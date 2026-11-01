import { readFileSync } from "node:fs";
import { isElement, isText, parse } from "@std/xml";
import { MediaService, type MediaConfig } from "./media.ts";
import { HomeService, type HomeConfig } from "./home.ts";
import { TransferService, type TransferConfig } from "./transfer.ts";
import { BookmarkService } from "./bookmarks.ts";
import { createVerifier } from "./auth.ts";
import { createApp, type Config } from "./server.ts";

const config = JSON.parse(
  readFileSync(process.env.MCP_CONFIG!, "utf8"),
) as Config & {
  port: number;
  media: MediaConfig;
  home?: HomeConfig;
  transfer?: TransferConfig;
  bookmarks?: {
    url: string;
    ownerSubject: string;
  };
};
for (const name of ["sonarr", "radarr"] as const) {
  const xml = parse(
    readFileSync(
      `${process.env.CREDENTIALS_DIRECTORY!}/${name}-config`,
      "utf8",
    ),
  );
  const element = xml.root.children.find(
    (node) => isElement(node) && node.name.local === "ApiKey",
  );
  const key =
    element && isElement(element)
      ? element.children.find(isText)?.text
      : undefined;
  if (typeof key !== "string" || !key.trim())
    throw new Error(`Missing ${name} API key`);
  config.media[name].apiKey = key.trim();
}
let transfer: TransferService | undefined;
if (config.transfer) {
  try {
    const xml = parse(
      readFileSync(
        `${process.env.CREDENTIALS_DIRECTORY!}/syncthing-config`,
        "utf8",
      ),
    );
    const gui = xml.root.children.find(
      (node) => isElement(node) && node.name.local === "gui",
    );
    const key =
      gui && isElement(gui)
        ? gui.children.find(
            (node) => isElement(node) && node.name.local === "apikey",
          )
        : undefined;
    const apiKey =
      key && isElement(key)
        ? key.children.find(isText)?.text.trim()
        : undefined;
    if (apiKey) transfer = new TransferService({ ...config.transfer, apiKey });
  } catch {
    /* Missing credentials leave transfer status unknown without breaking other tools. */
  }
}
const media = new MediaService(config.media, { transfer });
const app = createApp(
  config,
  createVerifier(
    config.issuer,
    config.resource,
    `${config.issuer}/.well-known/jwks.json`,
  ),
  media,
  config.home
    ? new HomeService({
        ...config.home,
        token: (() => {
          try {
            return readFileSync(
              `${process.env.CREDENTIALS_DIRECTORY!}/home-token`,
              "utf8",
            ).trim();
          } catch {
            return "";
          }
        })(),
      })
    : undefined,
  config.bookmarks
    ? new BookmarkService({
        url: config.bookmarks.url,
        ownerSubject: config.bookmarks.ownerSubject,
        token: readFileSync(
          `${process.env.CREDENTIALS_DIRECTORY!}/linkding-token`,
          "utf8",
        ).trim(),
      })
    : undefined,
);
app.server.listen(config.port, "127.0.0.1", () =>
  console.log(JSON.stringify({ event: "listening", port: config.port })),
);
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    app.server.close();
    void app.close().finally(() => app.server.closeAllConnections());
  });
