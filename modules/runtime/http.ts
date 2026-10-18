import { createServer, type Server } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/** Adapt Node's HTTP streams without buffering or trusting the Host header. */
export function createWebServer(
  handler: (request: Request) => Promise<Response>,
  log: Pick<Console, "error"> = console,
): Server {
  return createServer(async (incoming, outgoing) => {
    const abort = new AbortController();
    incoming.on("aborted", () => abort.abort());
    outgoing.on("close", () => {
      if (!outgoing.writableFinished) abort.abort();
    });
    try {
      const headers = new Headers();
      for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
        headers.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);
      }
      const method = incoming.method ?? "GET";
      // Cancelling an oversized request must leave the socket alive for its error response.
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          incoming.pause();
          incoming.on("data", (chunk: Buffer) => {
            controller.enqueue(chunk);
            incoming.pause();
          });
          incoming.on("end", () => {
            if (!cancelled) controller.close();
          });
          incoming.on("error", (error) => {
            if (!cancelled) controller.error(error);
          });
        },
        pull() {
          incoming.resume();
        },
        cancel() {
          cancelled = true;
          incoming.removeAllListeners("data");
          incoming.resume();
          outgoing.setHeader("Connection", "close");
        },
      });
      const request = new Request(
        new URL(incoming.url ?? "/", "http://127.0.0.1"),
        {
          method,
          headers,
          signal: abort.signal,
          ...(method === "GET" || method === "HEAD"
            ? {}
            : { body, duplex: "half" as const }),
        },
      );
      const response = await handler(request);
      outgoing.statusCode = response.status;
      response.headers.forEach((value, name) =>
        outgoing.setHeader(name, value),
      );
      const cookies = response.headers.getSetCookie();
      if (cookies.length) outgoing.setHeader("set-cookie", cookies);
      if (!response.body || method === "HEAD") {
        outgoing.end();
      } else {
        await pipeline(Readable.from(response.body), outgoing);
      }
    } catch {
      log.error("HTTP request failed");
      if (!outgoing.headersSent) {
        outgoing.writeHead(500, { "content-type": "application/json" });
        outgoing.end(JSON.stringify({ error: "internal server error" }));
      } else outgoing.destroy();
    }
  });
}
