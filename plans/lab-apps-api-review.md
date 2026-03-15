# Plan: API surface review for `homelab.apps`

## Context
- `modules/apps/*.nix` currently define app-facing options under `homelab.apps.<app>` and compose reverse-proxy/auth behavior directly in each module.
- Frontend proxying and auth wiring are implemented with slightly different patterns across apps (plain Caddy reverse proxy, native OIDC wiring, and `oauth2-proxy` + `forward_auth`).
- We want to verify the API shape from a module-consumer perspective, not just service behavior.

## Goal
- Ensure the `homelab.apps` option API is DRY, purpose-specific, and does not leak implementation details (service internals, wiring quirks, or backend-specific knobs) unless they are intentionally exposed.

## Review scope
1. **Frontend proxying API**
   - How each app exposes host/subdomain/proxy behavior.
   - Whether proxy-related options are consistent and belong at app-level vs shared-level.
   - Whether app APIs expose Caddy/oauth2-proxy implementation details that should be hidden behind higher-level intent.

2. **Auth API**
   - How auth is configured per app (`oidc`, `proxyAuth`, env secret references).
   - Consistency of auth option names, defaults, and required assertions.
   - Separation between intent-level options (for example "protect this app") and mechanism-level details (provider strings, callback paths, per-service env plumbing).

## Non-goals
- No immediate behavioral rewrites of running services.
- No migration to a different IdP or auth stack.
- No architecture-doc rewrite; this plan produces findings and a refactor proposal first.

## Working method
1. **Inventory current API surface**
   - Build a table of all `homelab.apps.<app>` options focused on proxying and auth.
   - Mark option type, default, required dependencies, and whether it is user-intent or implementation-exposure.

2. **Trace wiring path per concern**
   - For proxying: option -> `services.caddy.virtualHosts`/related settings.
   - For auth: option -> Keycloak/oauth2-proxy/Paperless/Immich service configuration and secret loading.
   - Capture where identical patterns are duplicated across app modules.

3. **Apply review rubric**
   - DRY: repeated option schemas/assertions/templates that should be centralized.
   - Purpose-specific: options map cleanly to user intent and app responsibility.
   - Leakage: options that force users to know internal service details when they should not.
   - Consistency: naming/defaults/shape align across apps for equivalent capabilities.

4. **Propose target API shape**
   - Draft a normalized model for proxy and auth settings (shared patterns + per-app overrides only where justified).
   - Define what remains app-specific and what should move to shared helpers/module(s).
   - Identify compatibility strategy for existing option names.

5. **Plan implementation slices**
   - Slice 1: internal refactors with no public option changes.
   - Slice 2: additive alias options/new API introduction.
   - Slice 3: cleanup/deprecation warnings and docs update once stable.

## Deliverables
- `plans/` review note with:
  - Current-state option inventory.
  - Findings by rubric (proxying + auth).
  - Proposed target API and migration map.
  - Ordered implementation steps with risk notes.
- Follow-up implementation PR(s) scoped to safe incremental changes.

## Review checklist (acceptance)
- Every proxy/auth option in `homelab.apps.*` is classified as intent-level or implementation-level.
- Repeated patterns are either justified or assigned a concrete consolidation step.
- Proposed API keeps per-app purpose clear while reducing cross-app inconsistency.
- Migration path preserves current behavior by default.

## Open questions to settle together before implementation
- Do we want one shared auth shape for all apps (with app-specific adapters), or keep separate `oidc` vs `proxyAuth` blocks but normalize naming?
- Should subdomain/proxy exposure remain app-local, or should a shared app-ingress API own common host/proxy knobs?
- How strict should we be about hiding mechanism details vs still exposing power-user escape hatches?
