# 1Password CLI on darwin: secret management for nix-darwin

Goal: manage the 1Password CLI (`op`) via nix-darwin and use it to expose secrets (e.g. `ANTHROPIC_API_KEY`) to shell sessions declaratively — without storing secrets in the nix store or dotfiles.

---

## Context

- `op` is already installed on `ro` but outside nix (likely via Homebrew or direct download).
- opnix (the 1Password secret injector used on picard/NixOS) is Linux-only — it hooks into systemd.
- On darwin, the equivalent mechanism is the **1Password shell plugin** or `op run`, both of which read secrets at shell startup time from the 1Password desktop app or CLI session.

---

## Options

### Option A — `op run` wrapper aliases (simplest)

Wrap commands that need secrets in `op run`:

```bash
oca = "op run --env-file=~/.config/op/opencode.env -- opencode";
```

`opencode.env` is a plain file with references like:
```
ANTHROPIC_API_KEY=op://Personal/Anthropic API/credential
```

**Pros:** simple, no shell session pollution, secrets are only injected for that invocation.  
**Cons:** `~/.config/op/opencode.env` is a non-nix file that must be created manually (or managed via `home.file`). Requires `op` session to be active (biometric unlock via 1Password desktop app covers this on macOS).

### Option B — 1Password shell plugin (most ergonomic)

The `op` CLI has a built-in shell plugin for sourcing env vars into the session:

```bash
op plugin init opencode  # or just op signin
```

This generates shell hooks that inject variables at login. Configured interactively, not declaratively.

**Pros:** zero-friction — secrets appear automatically in new shells.  
**Cons:** requires interactive setup; not reproducible from the nix config alone.

### Option C — `home.sessionVariables` with `op` substitution (declarative but limited)

Home Manager's `home.sessionVariables` sets env vars at shell init. There's no built-in way to evaluate `op` at that point, but a `programs.zsh.initContent` snippet can do it:

```nix
programs.zsh.initContent = ''
  if command -v op &>/dev/null && op account list &>/dev/null 2>&1; then
    export ANTHROPIC_API_KEY="$(op read 'op://Personal/Anthropic API/credential')"
  fi
'';
```

**Pros:** fully declarative nix config, secret resolved at shell startup.  
**Cons:** adds latency to every new shell (~100–300ms for `op read`); fails silently if 1Password is locked. Also exports the secret into the environment for the entire session.

---

## Installing `op` via nix-darwin

`1password-cli` is in nixpkgs (`pkgs._1password-cli` on darwin). Add it to the darwin Home Manager module or system packages:

```nix
home.packages = [ pkgs._1password-cli ];
```

This replaces the current Homebrew/manual install and pins the version to nixpkgs.

> Note: the 1Password desktop app (GUI) is a cask and stays in Homebrew for now (Nix can't manage macOS GUI apps well). The CLI and the desktop app share the same session/biometric unlock.

---

## Recommended approach

**Option A** (`op run` wrapper) for explicit, per-command secret injection. It's the least surprising: the secret is only live during that invocation, it's easy to reason about, and the `.env` reference file can be managed via `home.file` so it's at least source-controlled in shape (the values stay in 1Password).

```nix
# modules/home/darwin/opencode.nix
home.file.".config/op/opencode.env".text = ''
  ANTHROPIC_API_KEY=op://Personal/Anthropic API/credential
'';

programs.zsh.shellAliases = {
  oca = "op run --env-file=%h/.config/op/opencode.env -- opencode";
};
```

The `op://` reference is not a secret — it's a pointer. Safe to store in the nix config.

---

## Open questions

1. **1Password vault/item name**: what vault and item name holds the Anthropic API key? (Needed to fill in the `op://` reference.)
2. **Shell startup latency acceptable?** If Option C is preferred despite the latency, that's fine — just confirming.
3. **Other secrets needed on darwin?** If more keys are needed (OpenAI, etc.), this same pattern applies; worth establishing the convention now.
