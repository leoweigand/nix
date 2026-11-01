import { readFileSync } from "node:fs";
import { createVerifier } from "./auth.ts";
import { createApp, type Config } from "./server.ts";

const config = JSON.parse(
  readFileSync(process.env.MCP_CONFIG!, "utf8"),
) as Config & { port: number };
const app = createApp(
  config,
  createVerifier(
    config.issuer,
    config.resource,
    `${config.issuer}/.well-known/jwks.json`,
  ),
);
app.server.listen(config.port, "127.0.0.1", () =>
  console.log(JSON.stringify({ event: "listening", port: config.port })),
);
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    app.server.close();
    void app.close().finally(() => app.server.closeAllConnections());
  });
