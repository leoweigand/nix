# Home Assistant: YAML vs UI Configuration Boundary

## The Problem

HA has two configuration systems that can silently collide:

- **YAML files** — `configuration.yaml` and included files (`automations.yaml`, etc.). Coding agents and manual edits live here.
- **UI / `.storage/`** — written by HA and the web UI when you add integrations, create helpers, edit automations, etc.

Collision risks:
- Agent and UI both target `automations.yaml` — a malformed agent write breaks all automations in that file.
- Same helper ID defined in YAML and created via UI → HA startup error.
- Coding agent restructuring `configuration.yaml` can break the Nix pre-start script's idempotency check, causing duplicate `http:` config.

## What Lives Where

| Category | Owner |
|---|---|
| Integration config (Z2M, etc.) | UI only (`.storage/`) |
| Device entity registry | UI only (`.storage/`) |
| Helpers (input_boolean, etc.) | UI **or** YAML — not both |
| Automations / Scripts / Scenes | Shared: UI editor and agents both write YAML files |
| Template sensors | YAML only |
| Core config (http, logger, recorder, etc.) | YAML — Nix owns `http:` |

## Boundary Rules

**YAML / agents may touch:**
- Core config: `http`, `logger`, `recorder`, `homekit`, MQTT connection
- Template sensors and other computed entities with no UI equivalent

**UI only — do not replicate in YAML:**
- Device integrations (Settings > Devices & Services)
- Helpers (Settings > Devices & Services > Helpers)
- Dashboards

**Nix constraint:** The pre-start script owns the `http:` block in `configuration.yaml`. Coding agents must not touch or restructure that block.

## Automations

Both the UI editor and coding agents write to `automations.yaml`, making it the main collision risk.

**Option A — UI owns automations, agents stay out** *(recommended to start)*
Agents must not write directly to `automations.yaml`. If an agent produces an automation, it gets reviewed and added via the UI. Simple and safe.

**Option B — YAML owns automations, UI is read-only**
More reproducible and agent-friendly, but requires discipline: never save in the UI without reviewing the resulting file diff.

Start with Option A. Once automations are complex enough to benefit from version control, migrate them to a separate `automations_managed.yaml` included alongside the UI-owned file.

## Open Questions

- [ ] Audit `automations.yaml` — which automations were agent-written vs UI-created? Check for conflicts now.
- [ ] Is full config-as-code (Nix-generated `configuration.yaml`) a goal? It's a stronger guarantee but requires migrating all UI state and sustained discipline.
