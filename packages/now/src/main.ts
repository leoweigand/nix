import { readFileSync, mkdirSync } from "node:fs";
import { Control } from "./control.ts";
import { createControlServer, createFrontend, listenFrontend } from "./http.ts";
const config = JSON.parse(readFileSync(process.env.NOW_CONFIG!, "utf8"));
const credential = (name: string) =>
  readFileSync(`${process.env.CREDENTIALS_DIRECTORY}/${name}`, "utf8").trim();
mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
const control = new Control({
  ...config,
  database: `${config.stateDir}/registry.sqlite`,
  scratch: config.scratchDir ?? `${config.stateDir}/builds`,
  runtimeToken: credential("runtime-token"),
});
const api = createControlServer(
  control,
  credential("control-token"),
  config.issuer,
);
api.listen(config.port, "127.0.0.1");
const frontend = createFrontend(control, config.issuer);
await listenFrontend(frontend, config.socket);
console.log(
  JSON.stringify({
    event: "listening",
    port: config.port,
    socket: config.socket,
  }),
);
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    const closed = [api, frontend].map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    api.closeIdleConnections();
    frontend.closeIdleConnections();
    void Promise.allSettled([...closed, ...control.jobs]).finally(() => {
      control.db.close();
      process.exit(0);
    });
  });
