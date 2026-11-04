import { DatabaseSync } from "node:sqlite";
import { randomUUID, createHash, randomInt } from "node:crypto";
import { bundle, validateSource, type Source } from "./builder.ts";

import { fetchPublic, type OutboundRequest } from "./egress.ts";

type App = {
  id: string;
  slug: string;
  owner: string;
  description: string;
  head: string | null;
  active: string | null;
  state: string;
};
type Row = Record<string, any>;
export class NowError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
export function identity(issuer: string, subject: string) {
  return JSON.stringify([issuer.replace(/\/$/, ""), subject]);
}
export function userKey(owner: string) {
  return createHash("sha256").update(owner).digest("hex");
}

export class Control {
  db: DatabaseSync;
  locks = new Map<string, Promise<unknown>>();
  jobs = new Set<Promise<unknown>>();
  outbound = new Map<
    string,
    { since: number; count: number; active: number }
  >();
  outboundActive = 0;
  builds = new Map<
    string,
    { appId: string; controller: AbortController; job?: Promise<void> }
  >();
  config: {
    database: string;
    scratch: string;
    domain: string;
    runtimeUrl: string;
    runtimeToken: string;
    npm?: string;
    sandbox?: string;
    compileSandbox?: string;
  };
  constructor(config: Control["config"]) {
    this.config = config;
    this.db = new DatabaseSync(config.database);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS apps(id TEXT PRIMARY KEY, slug TEXT UNIQUE, owner TEXT, description TEXT, head TEXT, active TEXT, state TEXT);
      CREATE TABLE IF NOT EXISTS revisions(id TEXT PRIMARY KEY, app TEXT, source TEXT);
      CREATE TABLE IF NOT EXISTS releases(id TEXT PRIMARY KEY, app TEXT, revision TEXT, state TEXT, code TEXT, lock TEXT, error TEXT);
      CREATE TABLE IF NOT EXISTS roots(app TEXT, root TEXT, PRIMARY KEY(app,root));
      CREATE TABLE IF NOT EXISTS receipts(owner TEXT, key TEXT, hash TEXT, state TEXT, result TEXT, app TEXT, PRIMARY KEY(owner,key));
      CREATE TABLE IF NOT EXISTS logs(id TEXT PRIMARY KEY, app TEXT, release TEXT, at TEXT, method TEXT, path TEXT, status INTEGER, error TEXT);
      UPDATE releases SET state='failed', error='Build interrupted; submit a new build' WHERE state='building';
      UPDATE receipts SET state='uncertain' WHERE state='pending';`);
    if (
      !this.all("PRAGMA table_info(receipts)").some(
        (column) => column.name === "app",
      )
    )
      this.db.exec("ALTER TABLE receipts ADD COLUMN app TEXT");
  }
  one(sql: string, ...params: any[]): Row | undefined {
    return this.db.prepare(sql).get(...params) as Row | undefined;
  }
  all(sql: string, ...params: any[]): Row[] {
    return this.db.prepare(sql).all(...params) as Row[];
  }
  run(sql: string, ...params: any[]) {
    return this.db.prepare(sql).run(...params);
  }
  async serial<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    this.locks.set(id, next);
    try {
      return await next;
    } finally {
      if (this.locks.get(id) === next) this.locks.delete(id);
    }
  }
  app(id: string, owner?: string): App {
    const app = this.one("SELECT * FROM apps WHERE id=?", id) as
      App | undefined;
    if (!app || (owner !== undefined && app.owner !== owner))
      throw new NowError(404, "App not found");
    return app;
  }
  live(id: string, owner?: string) {
    const a = this.app(id, owner);
    if (a.state !== "live") throw new NowError(410, `App ${a.state}`);
    return a;
  }
  describe(a: App) {
    const { owner: _owner, ...app } = a;
    return { ...app, url: `https://${a.slug}.${this.config.domain}` };
  }
  async operation(owner: string, action: string, input: Row): Promise<Row> {
    const reads = ["list", "get", "get_build", "logs"];
    if (reads.includes(action)) return this.execute(owner, action, input);
    if (
      typeof input.key !== "string" ||
      !/^[a-zA-Z0-9_-]{8,128}$/.test(input.key)
    )
      throw new NowError(
        400,
        "Supply a unique operation key (8–128 letters, digits, _ or -); reuse it only to inspect/retry this exact operation",
      );
    return this.serial(`receipt:${owner}:${input.key}`, async () => {
      const hash = createHash("sha256")
        .update(JSON.stringify([action, input]))
        .digest("hex");
      const previous = this.one(
        "SELECT * FROM receipts WHERE owner=? AND key=?",
        owner,
        input.key,
      );
      if (previous) {
        if (previous.hash !== hash)
          throw new NowError(409, "Operation key reused with different input");
        if (previous.state !== "done")
          return {
            outcome: "uncertain",
            key: input.key,
            message:
              "Interrupted operation may have taken effect. Inspect app/build/data state; do not blindly repeat with a new key.",
          };
        return JSON.parse(previous.result);
      }
      this.run(
        "INSERT INTO receipts(owner,key,hash,state,result,app) VALUES(?,?,?,'pending',NULL,?)",
        owner,
        input.key,
        hash,
        typeof input.appId === "string" ? input.appId : null,
      );
      try {
        let result = await this.execute(owner, action, input);
        const appId =
          typeof input.appId === "string"
            ? input.appId
            : (result.app?.id ?? null);
        if (
          appId &&
          action !== "destroy" &&
          this.one(
            "SELECT state FROM apps WHERE id=? AND owner=?",
            appId,
            owner,
          )?.state === "destroyed"
        )
          result = { outcome: "destroyed", appId };
        this.run(
          "UPDATE receipts SET state='done',result=?,app=? WHERE owner=? AND key=?",
          JSON.stringify(result),
          appId,
          owner,
          input.key,
        );
        return result;
      } catch (error) {
        let result: Row = {
          outcome: "error",
          status: error instanceof NowError ? error.status : 500,
          message: error instanceof Error ? error.message : "Operation failed",
        };
        if (
          typeof input.appId === "string" &&
          this.one(
            "SELECT state FROM apps WHERE id=? AND owner=?",
            input.appId,
            owner,
          )?.state === "destroyed"
        )
          result = { outcome: "destroyed", appId: input.appId };
        this.run(
          "UPDATE receipts SET state='done',result=? WHERE owner=? AND key=?",
          JSON.stringify(result),
          owner,
          input.key,
        );
        return result;
      }
    });
  }
  async execute(owner: string, action: string, input: Row): Promise<Row> {
    if (action === "create") {
      if (
        typeof input.description !== "string" ||
        !input.description.trim() ||
        input.description.length > 300
      )
        throw new NowError(
          400,
          "Supply a one-sentence description, at most 300 characters",
        );
      if (
        this.one("SELECT count(*) n FROM apps WHERE state!='destroyed'")!.n >=
        24
      )
        throw new NowError(409, "App limit reached");
      const adjectives = [
        "autumn",
        "amber",
        "quiet",
        "silver",
        "misty",
        "gentle",
        "mossy",
        "violet",
        "bright",
        "calm",
        "crimson",
        "dappled",
        "frosty",
        "golden",
        "hidden",
        "lunar",
        "mellow",
        "nimble",
        "rosy",
        "shady",
        "sunny",
        "velvet",
        "wild",
        "winter",
      ];
      const plants = [
        "monstera",
        "fern",
        "willow",
        "maple",
        "clover",
        "orchid",
        "cedar",
        "iris",
        "acacia",
        "aloe",
        "aspen",
        "azalea",
        "birch",
        "briar",
        "cactus",
        "dahlia",
        "elm",
        "hazel",
        "ivy",
        "juniper",
        "lotus",
        "magnolia",
        "poppy",
        "sage",
      ];
      const id = randomUUID();
      // Include retired names so old bookmarks can never point to a new app.
      const reserved = new Set(
        this.all("SELECT slug FROM apps").map((a) => a.slug),
      );
      const available = adjectives
        .flatMap((adjective) => plants.map((plant) => `${adjective}-${plant}`))
        .filter((name) => !reserved.has(name));
      if (!available.length) throw new NowError(409, "App names exhausted");
      const slug = available[randomInt(available.length)]!;
      this.run(
        "INSERT INTO apps VALUES(?,?,?,?,NULL,NULL,'live')",
        id,
        slug,
        owner,
        input.description.trim(),
      );
      return { app: this.describe(this.app(id)) };
    }
    if (action === "list")
      return {
        apps: this.all(
          "SELECT * FROM apps WHERE owner=? AND state!='destroyed' ORDER BY rowid DESC",
          owner,
        )
          .filter(
            (a) =>
              !input.query ||
              a.description
                .toLowerCase()
                .includes(String(input.query).toLowerCase()),
          )
          .map((a) => this.describe(a as App)),
      };
    const app = this.app(input.appId, owner);
    if (action === "get")
      return {
        app: this.describe(app),
        source: app.head
          ? JSON.parse(
              this.one(
                "SELECT source FROM revisions WHERE id=? AND app=?",
                app.head,
                app.id,
              )!.source,
            )
          : null,
        releases: this.all(
          "SELECT id,revision,state,error FROM releases WHERE app=? ORDER BY rowid DESC LIMIT 30",
          app.id,
        ),
      };
    if (action === "get_build") {
      const release = this.one(
        "SELECT id,revision,state,error FROM releases WHERE id=? AND app=?",
        input.releaseId,
        app.id,
      );
      if (!release) throw new NowError(404, "Build not found");
      return { release };
    }
    if (action === "logs")
      return {
        logs: this.all(
          "SELECT * FROM logs WHERE app=? ORDER BY rowid DESC LIMIT 50",
          app.id,
        ),
      };
    if (action === "destroy") {
      if (app.state !== "destroyed")
        this.run(
          "UPDATE apps SET state='deleting',active=NULL WHERE id=?",
          app.id,
        );
      const builds = [...this.builds.values()].filter(
        (build) => build.appId === app.id,
      );
      for (const build of builds)
        build.controller.abort(new Error("App destroyed"));
      await Promise.allSettled(builds.map((build) => build.job));
      return this.serial(app.id, () => this.destroy(app.id, owner));
    }
    this.live(app.id, owner);
    if (action === "put_source") {
      if (input.baseRevision !== app.head)
        throw new NowError(
          409,
          "Source changed; read the current revision before editing",
        );
      const base: Source | undefined =
        input.replace === false && app.head
          ? JSON.parse(
              this.one(
                "SELECT source FROM revisions WHERE id=? AND app=?",
                app.head,
                app.id,
              )!.source,
            )
          : undefined;
      const files: Record<string, string> = Object.assign(
        Object.create(null),
        base?.files ?? {},
      );
      for (const [name, content] of Object.entries(input.files ?? {})) {
        if (content === null) delete files[name];
        else files[name] = content as string;
      }
      const source = {
        files,
        dependencies: input.dependencies ?? base?.dependencies ?? {},
        network: input.network ?? base?.network ?? { server: [] },
      } as Source;
      validateSource(source);
      const id = randomUUID();
      this.db.exec("BEGIN IMMEDIATE");
      try {
        if (
          this.one("SELECT count(*) n FROM revisions WHERE app=?", app.id)!.n >=
          40
        )
          throw new NowError(409, "Revision limit reached");
        this.run(
          "INSERT INTO revisions VALUES(?,?,?)",
          id,
          app.id,
          JSON.stringify(source),
        );
        this.run("UPDATE apps SET head=? WHERE id=?", id, app.id);
        this.db.exec("COMMIT");
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
      return { revision: id };
    }
    if (action === "build") {
      const revision = this.one(
        "SELECT source FROM revisions WHERE id=? AND app=?",
        input.revision,
        app.id,
      );
      if (!revision) throw new NowError(404, "Revision not found");
      const existing = this.one(
        "SELECT id,state FROM releases WHERE app=? AND revision=? AND state IN ('building','ready') ORDER BY rowid DESC LIMIT 1",
        app.id,
        input.revision,
      );
      if (existing) return { releaseId: existing.id, state: existing.state };
      if (
        this.one("SELECT count(*) n FROM releases WHERE app=?", app.id)!.n >= 40
      )
        throw new NowError(409, "Release limit reached");
      if (
        this.all("SELECT id FROM releases WHERE state='building'").length >= 2
      )
        throw new NowError(429, "Builder busy; check existing builds");
      const id = randomUUID();
      this.run(
        "INSERT INTO releases VALUES(?,?,?,'building',NULL,NULL,NULL)",
        id,
        app.id,
        input.revision,
      );
      const tracked: {
        appId: string;
        controller: AbortController;
        job?: Promise<void>;
      } = { appId: app.id, controller: new AbortController() };
      this.builds.set(id, tracked);
      const job = this.build(
        id,
        app.id,
        JSON.parse(revision.source),
        tracked.controller.signal,
      );
      tracked.job = job;
      this.jobs.add(job);
      void job.finally(() => {
        this.jobs.delete(job);
        this.builds.delete(id);
      });
      return { releaseId: id, state: "building" };
    }
    if (["deploy", "rollback"].includes(action))
      return this.serial(app.id, async () => {
        const current = this.live(app.id, owner);
        if (input.expectedRelease !== current.active)
          throw new NowError(
            409,
            "Active release changed; inspect before deploying",
          );
        const release = this.one(
          "SELECT * FROM releases WHERE id=? AND app=? AND state='ready'",
          input.releaseId,
          app.id,
        );
        if (!release) throw new NowError(409, "Release is not ready");
        this.run("UPDATE apps SET active=? WHERE id=?", release.id, app.id);
        return {
          app: this.describe(this.app(app.id)),
          warning:
            "Code activation preserves current data; rollback does not reverse data migrations.",
        };
      });
    if (action === "request") {
      if (
        typeof input.path !== "string" ||
        !input.path.startsWith("/") ||
        input.path.startsWith("//") ||
        input.path.includes("\\")
      )
        throw new NowError(400, "Use an app-relative path");
      const response = await this.serve(
        app.id,
        owner,
        new Request(`https://${app.slug}.${this.config.domain}${input.path}`, {
          method: input.method ?? "GET",
          headers: { "Content-Type": input.contentType ?? "application/json" },
          ...(!["GET", "HEAD"].includes(input.method ?? "GET")
            ? { body: input.body ?? "" }
            : {}),
        }),
      );
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: await response.text(),
      };
    }
    throw new NowError(404, "Unknown operation");
  }
  async build(id: string, appId: string, source: Source, signal?: AbortSignal) {
    const root = `${appId}:probe:${id}`;
    try {
      const built = await bundle(source, this.config.scratch, {
        ...this.config,
        signal,
      });
      await this.serial(appId, async () => {
        this.live(appId);
        this.run("INSERT OR IGNORE INTO roots VALUES(?,?)", appId, root);
        try {
          const response = await this.invoke({
            root,
            operation: "fetch",
            release: id,
            code: built.code,
            subject: "build-probe",
            request: {
              url: "https://build.invalid/__now/health",
              method: "GET",
              headers: {},
            },
          });
          if (response.status >= 500)
            throw new Error(
              `Runtime probe failed (${response.status}): ${(await response.text()).slice(0, 2000)}`,
            );
        } finally {
          await this.invoke({ root, operation: "destroy" });
          this.run("DELETE FROM roots WHERE app=? AND root=?", appId, root);
        }
        this.run(
          "UPDATE releases SET state='ready',code=?,lock=? WHERE id=?",
          built.code,
          built.lock,
          id,
        );
      });
    } catch (e) {
      this.run(
        "UPDATE releases SET state='failed',error=? WHERE id=?",
        (e instanceof Error ? e.message : "Build failed").slice(0, 12000),
        id,
      );
    }
  }
  async egress(input: OutboundRequest & { root: string; release: string }) {
    if (typeof input.root !== "string" || typeof input.release !== "string")
      throw new NowError(400, "Missing outbound capability");
    const appId = input.root.split(":")[0]!;
    const app = this.live(appId);
    if (
      !this.one(
        "SELECT root FROM roots WHERE app=? AND root=?",
        appId,
        input.root,
      )
    )
      throw new NowError(403, "Unknown app root");
    const release = this.one(
      "SELECT * FROM releases WHERE id=? AND app=?",
      input.release,
      appId,
    );
    if (!release || (release.state !== "building" && app.active !== release.id))
      throw new NowError(403, "Outbound release is no longer active");
    const source: Source = JSON.parse(
      this.one(
        "SELECT source FROM revisions WHERE id=? AND app=?",
        release.revision,
        appId,
      )!.source,
    );
    const now = Date.now();
    let budget = this.outbound.get(appId);
    if (!budget) {
      budget = { since: now, count: 0, active: 0 };
      this.outbound.set(appId, budget);
    }
    if (now - budget.since >= 60_000) {
      budget.since = now;
      budget.count = 0;
    }
    if (budget.count >= 60 || budget.active >= 2 || this.outboundActive >= 8)
      throw new NowError(
        429,
        "Server fetch limit reached; do not automatically retry writes",
      );
    budget.count++;
    budget.active++;
    this.outboundActive++;
    try {
      return await fetchPublic(input, source.network?.server ?? []);
    } catch (error) {
      throw new NowError(
        502,
        error instanceof Error ? error.message : "Server fetch failed",
      );
    } finally {
      budget.active--;
      this.outboundActive--;
    }
  }
  async invoke(envelope: Row) {
    return fetch(this.config.runtimeUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.config.runtimeToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(envelope),
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    });
  }
  async serve(
    appId: string,
    caller: string,
    request: Request,
  ): Promise<Response> {
    return this.serial(appId, async () => {
      const app = this.live(appId);
      if (!app.active)
        return new Response("This app has no deployed release", {
          status: 503,
        });
      const release = this.one(
        "SELECT * FROM releases WHERE id=? AND app=?",
        app.active,
        app.id,
      )!;
      const source: Source = JSON.parse(
        this.one(
          "SELECT source FROM revisions WHERE id=? AND app=?",
          release.revision,
          app.id,
        )!.source,
      );
      const url = new URL(request.url);
      const headers = new Headers(request.headers);
      for (const key of [...headers.keys()])
        if (
          /^(cookie|authorization|remote-user|x-now-|x-auth-|x-forwarded-)/i.test(
            key,
          )
        )
          headers.delete(key);
      const root = `${app.id}:${userKey(caller)}`;
      this.run("INSERT OR IGNORE INTO roots VALUES(?,?)", app.id, root);
      const id = randomUUID();
      let status = 502;
      let error: string | null = null;
      try {
        const asset =
          source.files[
            `public${url.pathname === "/" ? "/index.html" : url.pathname}`
          ];
        let response: Response;
        if (asset !== undefined && ["GET", "HEAD"].includes(request.method)) {
          const extension =
            url.pathname === "/" ? "html" : url.pathname.split(".").pop();
          const type =
            (
              {
                html: "text/html",
                css: "text/css",
                js: "text/javascript",
                svg: "image/svg+xml",
                json: "application/json",
                txt: "text/plain",
              } as Row
            )[extension!] ?? "application/octet-stream";
          response = new Response(request.method === "HEAD" ? null : asset, {
            headers: { "content-type": `${type}; charset=utf-8` },
          });
        } else
          response = await this.invoke({
            root,
            operation: "fetch",
            release: release.id,
            code: release.code,
            subject: userKey(caller),
            request: {
              url: request.url,
              method: request.method,
              headers: Object.fromEntries(headers),
              body: Buffer.from(await request.arrayBuffer()).toString("base64"),
            },
          });
        status = response.status;
        const safe = new Headers(response.headers);
        for (const name of [
          "set-cookie",
          "clear-site-data",
          "access-control-allow-origin",
        ])
          safe.delete(name);
        safe.set("X-Request-ID", id);
        safe.set("Cache-Control", "no-store");
        safe.set("X-Content-Type-Options", "nosniff");
        safe.set("Referrer-Policy", "no-referrer");
        safe.set(
          "Content-Security-Policy",
          "default-src 'self' https:; script-src 'self' https: 'unsafe-inline'; style-src 'self' https: 'unsafe-inline'; img-src 'self' https: data: blob:; font-src 'self' https: data:; connect-src 'self' https: wss:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        );
        return new Response(response.body, { status, headers: safe });
      } catch (e) {
        error = "Runtime request failed; inspect state before retrying a write";
        return new Response(error, { status });
      } finally {
        this.run(
          "INSERT INTO logs VALUES(?,?,?,?,?,?,?,?)",
          id,
          app.id,
          release.id,
          new Date().toISOString(),
          request.method,
          url.pathname.slice(0, 300),
          status,
          error,
        );
        this.run(
          "DELETE FROM logs WHERE app=? AND id NOT IN(SELECT id FROM logs WHERE app=? ORDER BY rowid DESC LIMIT 200)",
          app.id,
          app.id,
        );
      }
    });
  }
  async destroy(appId: string, owner: string) {
    const app = this.app(appId, owner);
    if (app.state === "destroyed") return { state: "destroyed" };
    this.run("UPDATE apps SET state='deleting',active=NULL WHERE id=?", appId);
    for (const { root } of this.all(
      "SELECT root FROM roots WHERE app=?",
      appId,
    )) {
      const response = await this.invoke({ root, operation: "destroy" });
      if (!response.ok)
        throw new NowError(
          503,
          "Routing withdrawn; state deletion incomplete. Inspect then resume destroy with a new key.",
        );
      this.run("DELETE FROM roots WHERE app=? AND root=?", appId, root);
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const table of ["releases", "revisions", "logs"])
        this.run(`DELETE FROM ${table} WHERE app=?`, appId);
      // Keep deduplication metadata, but remove cached app responses and source
      // diagnostics. Replaying an old create/request must not resurrect data.
      this.run(
        "UPDATE receipts SET state='done',result=? WHERE app=? AND owner=?",
        JSON.stringify({ outcome: "destroyed", appId }),
        appId,
        owner,
      );
      this.run(
        "UPDATE apps SET state='destroyed',description='',head=NULL,active=NULL WHERE id=?",
        appId,
      );
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return {
      state: "destroyed",
      retiredHostname: `${app.slug}.${this.config.domain}`,
      backupNotice:
        "Live source and facet databases removed. Existing backups retain data until their normal expiry; this is not secure erasure.",
    };
  }
}
