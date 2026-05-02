---
name: server-deploy
description: Deploy/apply NixOS flake changes over SSH from the local machine. Use when configuration for a machine changed and the user asked to apply them.
---

# Server deploy and apply

Workflow for updating one of the machines over SSH.

## When to use

Use this skill only when the user explicitly asks to deploy/apply NixOS config to a machine.

## How it works

The deploy uses `nixos-rebuild --build-host --target-host --sudo` from the local mac:

- Evaluates the flake locally (eval is platform-independent, so darwin can produce an x86_64-linux derivation graph).
- Ships the derivation graph to the target over SSH and builds it there (darwin can't build x86_64-linux without a remote builder).
- Activates the resulting closure on the same target via `sudo`.

Consequences:
- The target never needs GitHub credentials or a checked-out copy of the repo.
- Uncommitted local edits are deployed (a feature, not a bug — but be aware).
- Server name must be specified.

Run the deploy script **in the background** (deployments are long-running):

```bash
.claude/skills/server-deploy/scripts/deploy-server.sh <server>
```

After the deploy is completed:
- Return concise status with server, branch/commit context.
- If a service was updated, try a health check over ssh.
- On failure, pull recent logs (`journalctl -u <unit> -n 50` over ssh).

## Example

```bash
.claude/skills/server-deploy/scripts/deploy-server.sh picard
ssh picard "systemctl status tailscaled.service"
```
