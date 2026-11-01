// Administrative helper: prints an OAuth link without launching a browser.
// Pi's OAuth helper is internal to the pinned 1.4.0 package; keep this in step with upgrades.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const agentDir = process.env.PI_CODING_AGENT_DIR;
if (!agentDir)
  throw new Error(
    "Set PI_CODING_AGENT_DIR to the assistant's private agent directory",
  );
mkdirSync(agentDir, { recursive: true, mode: 0o700 });
const config = {
  mcpServers: {
    leolab: {
      url: "https://mcp.leolab.party/mcp",
      exposure: "direct",
      toolExposure: { request_media: "hidden" },
      oauth: {
        clientId: "leolab-mcp-telegram",
        callbackPort: 47832,
        scope: "openid offline_access lab:read media:read",
      },
    },
  },
  autoEnableCodemode: false,
};
writeFileSync(join(agentDir, "mcp.json"), JSON.stringify(config, null, 2), {
  mode: 0o600,
});
const entry = import.meta.resolve("@earendil-works/pi-coding-agent");
const { signInMcpServer } = await import(
  new URL("./extensions/mcp/oauth.js", entry).href
);
const path = join(agentDir, "mcp-auth.json");
const key = "mcp__leolab|https://mcp.leolab.party/mcp";
await signInMcpServer({
  serverUrl: config.mcpServers.leolab.url,
  settings: config.mcpServers.leolab.oauth,
  store: {
    load() {
      try {
        return JSON.parse(readFileSync(path, "utf8"))[key];
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
    },
    save(state: unknown) {
      writeFileSync(path, JSON.stringify({ [key]: state }, null, 2), {
        mode: 0o600,
      });
    },
  },
  prompt: {
    showAuthorizationUrl(url: URL) {
      console.log(`AUTHORIZE_URL=${url.href}`);
    },
    promptForRedirectUrl(signal: AbortSignal) {
      return new Promise<undefined>((resolve) =>
        signal.addEventListener("abort", () => resolve(undefined), {
          once: true,
        }),
      );
    },
  },
});
console.log(`OAuth credentials saved in ${agentDir}`);

if (process.argv.includes("--install-to-picard")) {
  execFileSync("ssh", ["picard", "sudo systemctl stop leolab-assistant"], {
    stdio: "inherit",
  });
  try {
    execFileSync(
      "ssh",
      [
        "picard",
        "sudo install -o leolab-assistant -g leolab-assistant -m 0600 /dev/stdin /mnt/fast/appdata/leolab-assistant/agent/mcp-auth.json",
      ],
      { input: readFileSync(path), stdio: ["pipe", "ignore", "inherit"] },
    );
    console.log(
      "Installed the assistant's read-only MCP credentials on Picard",
    );
  } finally {
    execFileSync("ssh", ["picard", "sudo systemctl start leolab-assistant"], {
      stdio: "inherit",
    });
  }
}
