# opencode: multi-provider shell aliases + Meridian

Goal: make opencode easily usable with different auth backends from the terminal via short aliases, with Meridian as the primary path for a Claude subscription.

---

## Context

`opencode` is already in use (`opencode.json` lives at the repo root) but is not yet managed by nix. This plan:

1. Adds `meridian` as a flake input and installs it via the darwin Home Manager module.
2. Runs Meridian as a persistent **launchd** service on `ro` (darwin) — it proxies Claude Code SDK to Anthropic API format, letting opencode share a Claude Max subscription.
3. Adds shell aliases for switching between providers without editing config.
4. Installs opencode itself via Home Manager.

---

## Aliases

| Alias | Invocation | Purpose |
|-------|-----------|---------|
| `oc` | `ANTHROPIC_BASE_URL=http://127.0.0.1:3456 ANTHROPIC_API_KEY=x opencode` | Claude Max via Meridian (default daily driver) |
| `oca` | `opencode` | Direct Anthropic API (relies on `ANTHROPIC_API_KEY` in environment — see [1password-darwin-secrets plan](./1password-darwin-secrets.md)) |

The `oc` alias passes a dummy API key because Meridian only needs the base URL override — the real auth is handled by the Claude Code SDK session.

---

## Meridian flake input

Meridian exposes `packages.${system}.default` and a `homeManagerModules.default`. The HM module creates a **systemd** service, which doesn't apply on darwin — we use `launchd.agents` instead and just take the package.

### flake.nix additions

```nix
inputs = {
  # existing inputs ...
  meridian = {
    url = "github:rynfar/meridian";
    inputs.nixpkgs.follows = "nixpkgs";
  };
};
```

Pass `meridian` through `specialArgs` (same pattern as `opnix`) so Home Manager modules can reference `inputs.meridian.packages.${system}.default`.

### modules/home/darwin/meridian.nix

```nix
{ pkgs, inputs, ... }:

let
  meridian = inputs.meridian.packages.${pkgs.stdenv.hostPlatform.system}.default;
in
{
  home.packages = [ meridian ];

  # Persistent background service — starts on login, restarts on crash
  launchd.agents.meridian = {
    enable = true;
    config = {
      ProgramArguments = [ "${meridian}/bin/meridian" ];
      RunAtLoad = true;
      KeepAlive = true;
      StandardOutPath = "%h/.cache/meridian/meridian.stdout.log";
      StandardErrorPath = "%h/.cache/meridian/meridian.stderr.log";
    };
  };
}
```

### modules/home/darwin/opencode.nix

```nix
{ pkgs, ... }:

{
  home.packages = [ pkgs.opencode ];

  programs.zsh.shellAliases = {
    oc  = "ANTHROPIC_BASE_URL=http://127.0.0.1:3456 ANTHROPIC_API_KEY=x opencode";
    oca = "opencode";
  };
}
```

Import both from `modules/home/darwin/default.nix`.

---

## First-time auth

Meridian authenticates via the Claude Code SDK session. On first setup (or after session expiry):

```bash
claude login
```

Credentials are stored by the SDK; Meridian picks them up automatically. The launchd service inherits the user environment, so no special configuration is needed.

---

## Open questions

1. **Third alias?** (Original message had a third bullet that was cut off — what was it?)
2. **`ANTHROPIC_API_KEY` for `oca`**: tracked in [1password-darwin-secrets plan](./1password-darwin-secrets.md).
3. **Meridian on NixOS (picard)?** — picard is a server, not a dev machine, so probably N/A. Confirm.
