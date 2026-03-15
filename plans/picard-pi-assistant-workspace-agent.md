# Plan: Pi workspace agent on picard

## Context
- We want a Bun-based AI assistant built on Pi on picard in two modes:
  - interactive local agent mode (`pi` in terminal)
  - long-running background mode (service) with Telegram bot interface
- This assistant is intentionally unconventional for Nix: it should be able to create and evolve its own local tools (skills, scripts, extensions) inside a writable workspace.
- The homelab still needs operational reliability: service lifecycle, secrets, reverse proxy integration (if exposed), and backups.
- We also want to follow patterns proven in Armin's `agent-stuff` repository: package-style reusable skills/extensions, command wrappers, and a workspace-first authoring model.

## Agreed decisions
- Execution model: broad permissions for agent work, with policy that it does not modify outside its workspace unless explicitly prompted.
- Data durability: workspace and state are first-class persistent data and must be included in backups.
- Toolchain sourcing: use `pi` from `numtide/llm-agents.nix` rather than ad-hoc npm/global installs.
- Timing: do not install yet; capture integration design first, then implement in a later step.
- Directory layout: `${config.homelab.mounts.fast}/assistant` is the base directory with `src/` and `workspace/` subdirectories.
- Naming: Nix module/app name is `assistant`; ingress subdomain is also `assistant`.
- Telegram delivery: webhook mode through Cloudflare Tunnel is a requirement (not optional) for the Telegram integration phase.
- MVP scope for the first implementation pass: keep module options minimal and run a Telegram-only responder service first.

## Goal
- Ship a pragmatic Nix-managed runtime envelope for a mutable Pi assistant that supports both interactive and daemonized operation, while preserving rapid in-workspace experimentation.

## Non-goals
- No attempt to make generated skills/scripts fully declarative or immutable.
- No "perfect" sandbox that blocks all unsafe behavior at kernel level in phase 1.
- No immediate multi-agent orchestration or cross-host execution in the first rollout.

## Target shape
- Nix manages runtime, service, directories, secrets, and optional ingress.
- The assistant runs as a dedicated system user with writable paths under `${config.homelab.mounts.fast}/assistant`.
- Both execution modes share the same workspace conventions and policy:
  - Mode A: interactive terminal sessions (`pi`) for direct local agent work.
  - Mode B: persistent bot worker (systemd) for asynchronous Telegram-driven tasks delivered via webhook.
- `pi` binary is provided by a pinned flake input (`llm-agents.nix`) in implementation phase, then invoked from workspace wrappers.
- The workspace follows a predictable layout inspired by `agent-stuff` so skills/extensions can be evolved and reused:
- Directory structure:
  - `src/` (checked-in runtime/server code and wrappers)
  - `workspace/` (mutable agent-owned files)
- Inside `workspace/`, use a predictable layout inspired by `agent-stuff` so skills/extensions can be evolved and reused:
  - `skills/`
  - `scripts/`
  - `commands/`
  - `intercepted-commands/` (optional)
  - `logs/` and `state/`
- Policy is enforced in the agent prompt/instructions and wrapper tooling: outside-workspace writes require explicit user confirmation in the interaction.

## Module API proposal (`homelab.apps.assistant`)
- Minimal MVP options:
  - `enable` (bool)
  - `telegram.tokenReference` (opnix reference)
  - `telegram.allowedChats` (list of allowed chat IDs/users)
- Deferred for later phases: ingress-related settings, Pi package override, mode split, extra packages, and other advanced runtime controls.

## Plan
1. **Define service envelope in Nix**
   - Add `modules/apps/assistant.nix` with options + assertions using existing module style.
   - Add dedicated system user/group `assistant` with no login shell.
   - Create `${config.homelab.mounts.fast}/assistant`, `${...}/src`, and `${...}/workspace` via `systemd.tmpfiles.rules` with ownership to the service user.

2. **Wire Bun + Pi runtime**
   - Provide Bun and required helper CLIs through Nix (`environment.systemPackages` or service `path`).
   - Source `pi` from `inputs.llm-agents.packages.<system>.pi` so updates are centrally pinned and reproducible.
   - Enable interactive local usage so `pi` can be run manually in a shell with the same workspace conventions.
   - Start background worker with systemd when enabled (`WorkingDirectory = workspaceDir`, restart on failure, journal logging).
   - Keep startup deterministic by using a wrapper script checked into this repo (invokes Pi entrypoint in workspace).

3. **Implement workspace policy guardrails**
   - Add a default policy/instructions file in workspace bootstrap describing write boundaries:
     - free write inside workspace
     - explicit prompt required before touching paths outside workspace
   - Add optional command wrappers (inspired by `agent-stuff` intercepted commands) for high-risk commands so the assistant can gate or log outbound actions.
   - Add clear audit trail in logs when an out-of-workspace action is approved.

4. **Secrets and credentials**
   - Store Pi/API credentials with opnix and mount as environment file into systemd service.
   - Keep secret references in machine config and never in workspace files.
   - Store Telegram bot token with opnix when bot mode is enabled.

5. **Interfaces: ingress and Telegram**
   - If the assistant exposes HTTP, register `services.caddy.virtualHosts` entry via app subdomain.
   - Keep backend bound to localhost; external access only through Caddy + existing TLS model.
   - For Telegram mode, run webhook mode (required) and terminate public ingress via Cloudflare Tunnel.
   - Expose a dedicated local webhook listener endpoint for bot updates; do not bind directly to public interfaces.
   - Cloudflare Tunnel forwards Telegram webhook traffic to the local assistant webhook listener.
   - Restrict accepted webhook requests to Telegram verification constraints used by the chosen bot framework.
   - Keep an allowlist of chats/users so arbitrary Telegram users cannot drive the agent.
   - If CLI-only initially, skip ingress and keep service local.

6. **Backups and recovery**
   - Include `${config.homelab.mounts.fast}/assistant` in picard backup job paths/excludes.
   - Document restore procedure for workspace/state similarly to existing runbook sections.

7. **Learning/resource alignment with `agent-stuff`**
   - Mirror useful folder conventions and command ergonomics so future reuse is straightforward.
   - Treat reusable skills/extensions as packageable artifacts later, but do local-first development now.
   - Capture what should become reusable vs host-specific in a short `README` inside workspace root.

8. **Rollout phases**
   - Phase 0: planning only (this document), no installation or host changes yet.
- Phase 1: background Telegram responder with minimal module options and secret wiring.
- Phase 2: add pinned `llm-agents.nix` input and wire Pi-driven responses.
- Phase 3: add interactive local mode and richer workspace wrapper ergonomics.
   - Phase 4: Telegram webhook ingress through Cloudflare Tunnel and end-to-end verification.
   - Phase 5: optional web/API ingress through Caddy.
   - Phase 6: stronger controls (sudo policy narrowing, optional sandbox tightening, action approval UX improvements).

## Validation checklist
- Service survives reboot and restarts automatically on failure.
- Interactive `pi` sessions and background bot worker behave consistently against the same workspace policy.
- Assistant can create/edit files in `workspaceDir` without manual permission fixes.
- Assistant does not perform out-of-workspace writes unless the user explicitly confirms.
- Pi/API secrets are loaded at runtime and not persisted in plaintext workspace files.
- Telegram webhook reaches the local service through Cloudflare Tunnel and rejects invalid requests.
- Telegram mode accepts commands only from configured allowed chats/users.
- Backup job includes workspace/state and restore test recovers them successfully.
- Optional ingress is reachable only through Caddy and not directly exposed on wildcard interfaces.

## Risks and mitigations
- **Risk:** broad permissions increase blast radius.
  - **Mitigation:** explicit policy guard + command interception + logging + least-privilege service user.
- **Risk:** mutable workspace drifts into unmaintainable state.
  - **Mitigation:** clear workspace conventions, periodic curation, and promotion path for stable tools into versioned repo content.
- **Risk:** runtime/package mismatch over time.
  - **Mitigation:** pin Bun/Pi runtime via nixpkgs and update centrally rather than adding one-off channels.

## Exit criteria
- `homelab.apps.assistant` can be enabled on picard with one config block.
- The assistant supports both interactive `pi` usage and managed background operation with persistent writable workspace.
- Backup/restore for assistant workspace + state is verified.
- Policy for out-of-workspace writes is documented and enforced in the runtime wrapper/instructions.

## Open questions for later phases
- Should we expose HTTP features behind Caddy as soon as Pi integration lands, or keep Telegram-only until webhook ingress is ready?
- Which initial extra tools should be available by default to the agent (`git`, `gh`, `jq`, `ripgrep`, etc.) vs opt-in later?
- Do we want a second "quarantine" workspace for testing risky auto-generated tools before promoting them into the main workspace?
- When we switch from polling to webhook mode, should we route Telegram through Caddy or directly through Cloudflare Tunnel to a local webhook listener?
