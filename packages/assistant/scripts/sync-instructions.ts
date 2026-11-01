import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../../", import.meta.url));
const paths = [
  "packages/assistant/instructions/SYSTEM.md",
  "packages/assistant/skills/telegram/SKILL.md",
];
execFileSync("git", ["diff", "--quiet", "HEAD", "--", ...paths], { cwd: root });
for (const path of paths)
  execFileSync("git", ["ls-files", "--error-unmatch", path], {
    cwd: root,
    stdio: "ignore",
  });
const bundle = {
  system: readFileSync(root + paths[0], "utf8"),
  channel: readFileSync(root + paths[1], "utf8"),
  channelName: "telegram",
};
execFileSync(
  "ssh",
  [
    "picard",
    "sudo install -o root -g leolab-assistant -m 0640 /dev/stdin /var/lib/leolab-assistant-instructions/current.json.new && sudo mv /var/lib/leolab-assistant-instructions/current.json.new /var/lib/leolab-assistant-instructions/current.json",
  ],
  { input: JSON.stringify(bundle), stdio: ["pipe", "inherit", "inherit"] },
);
console.log(
  "Instructions synced. Existing sessions keep their pinned version; /clear or the next session boundary loads this version.",
);
