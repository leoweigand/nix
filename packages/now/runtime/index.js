import { WorkerEntrypoint, DurableObject } from "cloudflare:workers";

// Only the control plane holds this binding. Uploaded code gets no bindings,
// loader, direct network access or authority to select another app's root object.
export default {
  async fetch(request, env) {
    if (request.headers.get("authorization") !== `Bearer ${env.CAPABILITY}`)
      return new Response("Unauthorised", { status: 401 });
    const envelope = await request.json();
    if (!/^[a-zA-Z0-9:_-]{1,256}$/.test(envelope.root))
      return new Response("Invalid root", { status: 400 });
    return env.SUPERVISOR.getByName(envelope.root).fetch(
      new Request("https://supervisor/", {
        method: "POST",
        body: JSON.stringify(envelope),
      }),
    );
  },
};

export class Supervisor extends DurableObject {
  tail = Promise.resolve();
  release;
  worker;
  fetch(request) {
    // Serialise release changes with requests, so abort cannot kill an older
    // invocation while it is still committing user data.
    const result = this.tail.then(() => this.dispatch(request));
    this.tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  async dispatch(request) {
    const e = await request.json();
    if (e.operation === "destroy") {
      this.ctx.storage.kv.put("retired", true);
      await this.ctx.facets.delete("app");
      this.worker = undefined;
      this.release = undefined;
      return new Response(null, { status: 204 });
    }
    if (this.ctx.storage.kv.get("retired"))
      return new Response("App state retired", { status: 410 });
    if (this.release !== e.release) {
      await this.ctx.facets.abort("app", "Code release changed");
      this.worker = this.env.LOADER.get(`${e.root}:${e.release}`, () => ({
        compatibilityDate: "2026-01-01",
        mainModule: "app.js",
        modules: { "app.js": e.code },
        env: {},
        globalOutbound: this.ctx.exports.Outbound({
          props: { root: e.root, release: e.release },
        }),
        limits: { cpuMs: 1000, subRequests: 16 },
      }));
      this.release = e.release;
    }
    const facet = this.ctx.facets.get("app", () => ({
      class: this.worker.getDurableObjectClass("App"),
    }));
    const incoming = e.request;
    const headers = new Headers(incoming.headers);
    headers.set("X-Now-User-ID", e.subject);
    headers.delete("cookie");
    headers.delete("authorization");
    const bytes = Uint8Array.from(atob(incoming.body ?? ""), (c) =>
      c.charCodeAt(0),
    );
    const response = await facet.fetch(
      new Request(incoming.url, {
        method: incoming.method,
        headers,
        ...(!["GET", "HEAD"].includes(incoming.method) ? { body: bytes } : {}),
      }),
    );
    // Consume inside the serialised section, including the durable output gate.
    const body = await response.arrayBuffer();
    if (body.byteLength > 2 * 1024 * 1024)
      return new Response("App response exceeds 2 MiB", { status: 502 });
    return new Response(
      [204, 205, 304].includes(response.status) ? null : body,
      { status: response.status, headers: response.headers },
    );
  }
}

// Only this trusted entrypoint knows the broker URL and runtime credential.
export class Outbound extends WorkerEntrypoint {
  async fetch(request) {
    if (!this.env.EGRESS_URL)
      return new Response("Server fetch is unavailable", { status: 503 });
    const chunks = [];
    let size = 0;
    const reader = request.body?.getReader();
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 1024 * 1024) {
          await reader.cancel();
          return new Response("Outbound body exceeds 1 MiB", { status: 413 });
        }
        chunks.push(value);
      }
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    let binary = "";
    for (let i = 0; i < bytes.length; i += 8192)
      binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return fetch(this.env.EGRESS_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.env.CAPABILITY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ...this.ctx.props,
        url: request.url,
        method: request.method,
        headers: Object.fromEntries(request.headers),
        body: btoa(binary),
      }),
      redirect: "error",
    });
  }
}
