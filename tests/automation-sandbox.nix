{ pkgs }:
let
  sandbox = pkgs.callPackage ../packages/automation/sandbox.nix { };
  probe = pkgs.writeText "automation-sandbox-probe.mjs" ''
    import assert from "node:assert/strict";
    import { readFile, writeFile, open, rename } from "node:fs/promises";
    import { DatabaseSync } from "node:sqlite";
    import { createServer } from "node:http";
    const [allowed, blocked] = process.argv.slice(2);
    assert.equal(await readFile(allowed + "/readable", "utf8"), "allowed\n");
    await assert.rejects(readFile(blocked + "/secret"), { code: "EACCES" });
    assert.throws(() => new DatabaseSync(blocked + "/secret.db", {readOnly: true}));
    await assert.rejects(writeFile(allowed + "/readable", "changed"), { code: "EACCES" });
    const file = await open(allowed + "/state/temporary", "wx", 0o600);
    await file.writeFile("durable");
    await file.sync();
    await file.close();
    await rename(allowed + "/state/temporary", allowed + "/state/state.json");
    assert.equal(await readFile(allowed + "/state/state.json", "utf8"), "durable");
    assert.equal(process.env.AUTOMATION_UNDECLARED_SECRET, undefined);
    assert.equal(process.env.AUTOMATION_DECLARED_VALUE, "allowed");
    await new Promise((resolve, reject) => {
      const server = createServer();
      server.once("error", (error) => {
        try { assert.equal(error.code, "EACCES"); resolve(); } catch (error) { reject(error); }
      });
      server.listen(0, "127.0.0.1", () => { server.close(); reject(new Error("TCP bind escaped policy")); });
    });
  '';
in
pkgs.runCommand "automation-sandbox-check" { nativeBuildInputs = [ pkgs.nodejs_26 ]; } ''
  mkdir -p allowed/state blocked
  echo allowed > allowed/readable
  echo secret > blocked/secret
  node --input-type=module -e 'import { DatabaseSync } from "node:sqlite"; new DatabaseSync("blocked/secret.db").close();'
  export AUTOMATION_UNDECLARED_SECRET=hidden AUTOMATION_DECLARED_VALUE=allowed
  ${sandbox}/bin/landrun --rox /nix/store --ro /proc/self \
    --ro "$PWD/allowed" --rw "$PWD/allowed/state" --env AUTOMATION_DECLARED_VALUE \
    -- ${pkgs.nodejs_26}/bin/node ${probe} "$PWD/allowed" "$PWD/blocked"
  touch "$out"
''
