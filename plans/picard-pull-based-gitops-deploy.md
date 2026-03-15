# Plan: Restricted infra deploy to picard

## Context
- This repository is the Nix flake that defines machine configuration for the homelab.
- `picard` is a NixOS machine managed from this flake.
- The objective is to deploy infrastructure changes safely with least privilege, without giving CI or general SSH users broad root access.

## Goal
- Keep infra deploys simple and explicit: GitHub Actions connects to `picard` over Tailscale SSH and runs one deploy command with tightly restricted permissions.
- Keep deploy operations observable: document a stable way for humans and coding agents to attach to in-flight deploys (live logs/status) for troubleshooting.

## Final shape
- Deploy trigger is a GitHub Actions workflow after infra checks pass.
- Deploy command runs as a dedicated `deploy` user.
- `deploy` user can run exactly one privileged action: update local repo checkout and run `nixos-rebuild switch --flake .#picard`.
- Tailscale SSH policy allows the CI identity to access only `picard` as user `deploy` (no shell access as other users).
- The workflow runs on an ephemeral runner so no long-lived runner state or credentials persist between deploys.

## Non-goals
- No automatic polling/webhook deploys.
- No application-specific release logic.
- No multi-host orchestration in this phase.

## Plan
1. **Create dedicated deploy identity on picard**
   - Add user `deploy` with no extra groups and no interactive admin privileges.
   - Install one SSH key used only for infra deploys.

2. **Add fixed deploy wrapper script**
   - Add a root-owned script (for example `/usr/local/bin/deploy-picard`) with `set -euo pipefail`.
   - Script runs exactly these steps in the infra checkout directory on picard:
     - `git pull --ff-only`
     - `nixos-rebuild switch --flake .#picard`
   - Script emits clear start/end/error logs so each run is auditable in `journalctl`.

3. **Restrict sudo to one command**
   - Add `/etc/sudoers.d/deploy-picard` rule allowing user `deploy` to run only the wrapper script as root.
   - No generic `sudo` access.

4. **Restrict SSH key behavior**
   - In `authorized_keys`, pin deploy key options: no port forwarding, no agent forwarding, no pty.
   - Optional hardening: force-command to the deploy wrapper.

5. **Restrict Tailscale SSH for GitHub Actions**
   - Create a dedicated Tailscale tag for CI identity (for example `tag:ci-deploy`).
   - In Tailscale ACL/SSH policy, allow `tag:ci-deploy` to SSH only to `picard`.
   - Restrict allowed SSH users to `deploy` only.
   - Deny access to all other hosts/users by default.
   - Use short-lived/ephemeral CI auth for joining tailnet.

6. **GitHub Actions deploy workflow**
   - Workflow joins tailnet with the CI identity and runs one command:
     - `ssh deploy@picard 'sudo /usr/local/bin/deploy-picard'`
   - Workflow has minimum GitHub permissions and uses protected environment rules for deploy approvals.
   - Runner must be ephemeral per job (GitHub-hosted runner or auto-removed ephemeral self-hosted runner).
   - Do not use persistent self-hosted runners for deploy jobs.

7. **Operational runbook**
- Standard deploy path is the GitHub Actions workflow.
- Manual break-glass deploy (optional): `ssh deploy@picard 'sudo /usr/local/bin/deploy-picard'`.
- Ongoing deploy troubleshooting (human or agent):
  - Watch workflow progress/live logs: `gh run watch <run-id>` and `gh run view <run-id> --log`.
  - Watch host-side deploy logs: `ssh picard 'sudo journalctl -f -t deploy-picard'`.
  - Review the latest deploy attempt: `ssh picard 'sudo journalctl -t deploy-picard -n 200 --no-pager'`.
- Verify: `ssh picard 'systemctl status <changed-service>'`.
- Rollback: `ssh picard 'sudo nixos-rebuild --rollback switch'`.

## Security model
- SSH authentication proves caller identity for the dedicated deploy key.
- `deploy` user has no broad privilege escalation path.
- Sudo policy grants one narrow root action.
- The wrapper script defines and constrains what “deploy” means.
- Tailscale SSH policy constrains CI to one host (`picard`) and one user (`deploy`).
- Ephemeral runner lifecycle reduces credential residue and cross-run state contamination risk.
- NixOS generations provide recovery if a deploy is bad.

## Validation
- Deploy key can run the deploy command successfully.
- Deploy key cannot run arbitrary shell or other sudo commands.
- CI Tailscale identity cannot SSH as `root` or any non-`deploy` user.
- CI Tailscale identity cannot SSH to non-`picard` hosts.
- Consecutive workflow runs use fresh runner instances with no persisted workspace/secrets.
- Ongoing deploy can be observed with documented commands (both GitHub Actions logs and host-side `journalctl`) without requiring ad-hoc access.
- Failed deploy exits non-zero and leaves previous generation intact.
- Rollback command works from previous generation.

## Exit criteria
- Infra deploys require only one SSH command.
- Permissions are least-privilege and auditable.
- CI can deploy via Tailscale SSH but has no general SSH privileges beyond `deploy@picard`.
- Deploy workflow executes only on ephemeral runners.
