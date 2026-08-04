---
name: nix-setting
description: Research and declaratively implement user-requested operating-system, desktop, application, and service settings in this Nix repository. Use whenever the user asks to set, enable, disable, configure, or change something that may belong in NixOS, nix-darwin, Home Manager, a Nix module, or a managed application configuration; do not guess or make an unsupported configuration change.
---

# Research and manage a Nix setting

Turn a natural-language setting request into a verified declarative change in this flake. This applies to macOS settings, Home Manager preferences, NixOS services, packages, shell behavior, and application configuration—not only to the motivating Dock example.

## Required outcome

Keep investigating until one of these outcomes is reached:

1. A supported, repository-appropriate declarative implementation is found: make the change, validate it, and ask the user to switch/apply the configuration.
2. The setting cannot be managed declaratively with the available Nix ecosystem or this repository: make no speculative edit and finish by explicitly saying it is not possible, including what was checked and the closest manual or partial alternative if useful.

Do not silently stop at “I’m not sure.” Do not invent option names, module paths, package attributes, or undocumented `defaults` keys.

## Workflow

### 1. Understand the requested state and target

Translate the request into a precise desired state and identify the affected target(s):

- macOS (`nix-darwin`), usually the `ro` machine;
- Home Manager, including whether the module is shared with NixOS;
- NixOS system configuration or a service module;
- a package's own managed config; or
- a setting that is runtime-only and may not have a declarative owner.

Inspect `README.md`, `ARCHITECTURE.md`, `AGENTS.md`, the flake inputs, machine configuration, and nearby modules before deciding where a change belongs. Preserve the repository's separation between status-quo documentation and unfinished plans.

If the request is ambiguous but a safe interpretation is obvious, state the interpretation briefly and proceed. Ask only when different interpretations would change the target or behavior materially.

### 2. Research before editing

Use evidence in this order, selecting the sources relevant to the setting:

1. Search this repository for existing patterns, imports, target guards, and option usage (`rg`).
2. Inspect the exact pinned nixpkgs, nix-darwin, and Home Manager sources available through the flake. Check whether the option exists in the pinned revision and which module owns it.
3. Consult current upstream documentation or source for the relevant project. For web research, prefer official NixOS/nix-darwin/Home Manager documentation and upstream source/issues; cite URLs in the handoff when external research materially supports the decision.
4. Use local `nix` evaluation to query option definitions or evaluate a minimal expression when practical. A search result or a similarly named option is not proof that an option is valid for this flake.

For a macOS preference, distinguish among a documented nix-darwin option, a Home Manager option, `targets.darwin.defaults`, a launch agent/script, and an unsupported imperative command. Confirm the exact domain/key/value type and when it takes effect. For an app or service, confirm the owning module and whether its config is generated, merged, or overwritten.

Record enough evidence mentally or in the final summary to explain:

- the declarative owner and exact option/path;
- why the selected machine/module scope is correct;
- the expected generated setting and activation behavior; and
- any limitation, version dependency, or manual follow-up.

### 3. Choose the smallest correct change

Prefer an existing module or option over a custom script. Follow repository conventions and keep platform-specific behavior scoped with `lib.mkIf` or the appropriate machine/module boundary. If the option is shared by Darwin and Linux, verify that it evaluates on both before adding it to a shared module.

Do not introduce a one-off nixpkgs channel for a newer dependency when upgrading the repository's main input is the established project preference. Do not use `--network=host` for container work. Follow the repository's comment policy: explain only non-obvious constraints, timing, types, or workarounds.

Before editing, ensure the proposed mechanism is actually declarative. A command such as `defaults write` is only a valid implementation when it is wrapped in an intentional, idempotent managed activation mechanism and that approach is supported by the repository; otherwise report that the setting is not currently possible through the flake rather than pretending it is Nix-native.

### 4. Edit and validate

Make the change in the appropriate existing file, or add a focused module and import it if that is the repository pattern. Do not switch or deploy automatically.

Validate proportionally:

- format or parse changed Nix files;
- evaluate the relevant option/configuration;
- build the relevant Darwin or NixOS flake target when feasible;
- inspect the diff for accidental scope changes.

For Darwin, do not run `darwin-rebuild` directly in this environment because it requires sudo. Provide the exact switch command for the user. For NixOS, do not deploy unless the user explicitly asks; hand off to the deployment workflow when appropriate.

If validation reveals that the approach is unsupported, remove only the changes made for this request, re-check the diff, and report “not possible” with the evidence. Do not leave a knowingly broken or speculative configuration behind.

### 5. Hand off for activation

When the change is implemented and validation passes, summarize the exact files and behavior, then ask the user to switch/apply it. Give the exact command, for example:

```bash
darwin-rebuild switch --flake /Users/leo/git/nix#ro
```

Do not claim the setting is active until the user applies it and, if needed, verifies the resulting behavior. If the user says to terminate instead, stop without switching.

## Explanation standard

This repository is a learning resource. Explain unusual Nix details clearly: attribute paths, option merging, `lib.mkIf`, platform evaluation, Home Manager versus system ownership, generated files, and activation timing. When comparing Vue is relevant, use React analogies only for Vue questions; do not force analogies into Nix explanations.
