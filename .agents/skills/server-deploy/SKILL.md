---
name: server-deploy
description: Deploy/apply NixOS flake changes over SSH with a safe push-and-switch workflow. Use when configuration for a machine changed and the user asked to apply them.
---

# Server deploy and apply

Workflow for updating one of the machines over SSH. 

## When to use

Use this skill only when the user explicitly asks to deploy/apply NixOS config to a machine.

## How to run

- Make sure the Git working tree is clean. Changes to be pushed need to be committed before running the deploy.
- Serve name must be specified 

```bash
.agents/skills/server-deploy/scripts/deploy-server.sh <server>
```

After the deploy is completed:
- Return concise status with server, branch/commit context
- If a service was updated, try doing a health check (over ssh)
- In case of failure, pull recent logs


## Example

```bash
git commit -m "update tailscale module"
.agents/skills/server-deploy/scripts/deploy-server.sh picard
ssh picard "systemctl status tailscaled.service"
```
