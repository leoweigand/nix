import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { chmod, rm } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import { Control, NowError, identity } from "./control.ts";

async function body(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024)
      throw new NowError(413, "Request exceeds 2 MiB");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function equal(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
}
function failure(response: ServerResponse, error: unknown) {
  json(response, error instanceof NowError ? error.status : 500, {
    outcome: "error",
    message: error instanceof NowError ? error.message : "Now request failed",
  });
}
export function createControlServer(
  control: Control,
  token: string,
  issuer: string,
  runtimeToken = "",
) {
  return createServer(async (request, response) => {
    try {
      if (request.url === "/internal/egress" && request.method === "POST") {
        if (
          !runtimeToken ||
          !equal(request.headers.authorization ?? "", `Bearer ${runtimeToken}`)
        )
          throw new NowError(401, "Unauthorised");
        const result = await control.egress(
          JSON.parse((await body(request)).toString()),
        );
        response.writeHead(result.status, Object.fromEntries(result.headers));
        response.end(Buffer.from(await result.arrayBuffer()));
        return;
      }
      if (!equal(request.headers.authorization ?? "", `Bearer ${token}`))
        throw new NowError(401, "Unauthorised");
      if (
        request.method !== "POST" ||
        !/^\/v1\/[a-z_]+$/.test(request.url ?? "")
      )
        throw new NowError(404, "Not found");
      const subject = request.headers["x-now-subject"];
      if (typeof subject !== "string" || !subject || subject.length > 200)
        throw new NowError(401, "Missing verified subject");
      const input = JSON.parse((await body(request)).toString());
      const output = await control.operation(
        identity(issuer, subject),
        request.url!.slice(4),
        input,
      );
      json(
        response,
        typeof output.status === "number" && output.outcome === "error"
          ? output.status
          : 200,
        output,
      );
    } catch (error) {
      failure(response, error);
    }
  });
}
export function createFrontend(control: Control, issuer: string) {
  return createServer(async (request, response) => {
    try {
      // This listener is a Unix socket owned by Now and Caddy, never TCP.
      const subject = request.headers["x-now-subject"];
      if (typeof subject !== "string" || !subject || subject.length > 200)
        throw new NowError(401, "Missing authenticated user");
      const host = request.headers.host ?? "";
      const suffix = `.${control.config.domain}`;
      if (!host.endsWith(suffix)) throw new NowError(404, "Unknown app");
      const slug = host.slice(0, -suffix.length);
      if (!/^[a-z0-9-]+$/.test(slug)) throw new NowError(404, "Unknown app");
      if (
        !["GET", "HEAD", "OPTIONS"].includes(request.method ?? "") &&
        request.headers.origin !== `https://${host}`
      )
        throw new NowError(403, "App writes require a same-origin request");
      const app = control.one(
        "SELECT id FROM apps WHERE slug=? AND state='live'",
        slug,
      );
      if (!app) throw new NowError(404, "Unknown app");
      const bytes = await body(request);
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers))
        if (typeof value === "string") headers.set(name, value);
      const result = await control.serve(
        app.id,
        identity(issuer, subject),
        new Request(`https://${host}${request.url}`, {
          method: request.method,
          headers,
          ...(!["GET", "HEAD"].includes(request.method!)
            ? { body: bytes }
            : {}),
        }),
      );
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch (error) {
      failure(response, error);
    }
  });
}
export async function listenFrontend(
  server: ReturnType<typeof createServer>,
  socket: string,
) {
  await rm(socket, { force: true });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, resolve);
  });
  await chmod(socket, 0o660);
}
