# Plan: Authentik trial for Home Assistant and OpenClaw

## Context
- Keycloak is currently the IdP at `auth.leolab.party` and already backs existing integrations.
- Remaining app rollout targets are `home.leolab.party` (Home Assistant) and `cora.leolab.party` (OpenClaw).
- We want a low-risk trial to evaluate whether Authentik is a better fit before committing to a broader migration.

## Goal
- Stand up Authentik on picard and protect Home Assistant + OpenClaw with it, then decide whether to keep Authentik or stay on Keycloak.

## Non-goals
- No full migration of existing Keycloak-backed apps in this phase (`paperless`, `immich`, `zigbee2mqtt`).
- No DNS/topology change beyond adding an Authentik endpoint behind Caddy.
- No decommissioning of Keycloak during the trial.

## Trial design decisions
1. **Parallel IdP trial**
   - Run Authentik alongside Keycloak so rollback is just switching routes/config.
   - Use a dedicated hostname (for example `authentik.leolab.party`) to avoid issuer/cookie collisions.

2. **Per-app integration strategy**
   - Home Assistant: prefer `oauth2-proxy` + Caddy `forward_auth` first for predictable rollback, then evaluate native OIDC later if needed.
   - OpenClaw: use `oauth2-proxy` + Caddy `forward_auth` (no app-level OIDC changes expected).
   - Keep app auth changes isolated per service to avoid shared blast radius.

3. **Secrets and state handling**
   - Store Authentik bootstrap/admin secret, OIDC client secrets, and oauth2-proxy cookie secrets in 1Password via opnix.
   - Keep Authentik state in persisted storage already covered by picard `state` backups.

4. **Evaluation-first rollout**
   - Define up front what “better than Keycloak” means (admin UX, policy flexibility, reliability, passkey flow, troubleshooting effort).
   - Time-box trial feedback after daily use on both target apps.

## Rollout plan
1. **Add Authentik baseline module**
   - Create `modules/infra/authentik.nix` with service options under `homelab.infra.authentik.*` (hostname, ports, secrets, persistence knobs).
   - Bind Authentik internals to localhost; expose only through Caddy virtual host.
   - Wire required backing services (database/cache as needed by NixOS Authentik module) and startup ordering with opnix secrets.

2. **Introduce reusable proxy-auth pattern for apps**
   - Extract a generic OIDC proxy pattern from `modules/apps/zigbee2mqtt.nix` so app modules can select issuer/client/ports without duplicating boilerplate.
   - Keep provider configurable (`keycloak-oidc` vs OIDC issuer URL) so existing Keycloak paths continue to work unchanged.

3. **Integrate OpenClaw with Authentik first**
   - Add `proxyAuth` options in `modules/apps/openclaw.nix` mirroring the Zigbee2MQTT model (`enable`, issuer/provider, client ID, env secret reference, local oauth2-proxy port).
   - Update Caddy vhost for OpenClaw to gate UI/API through `forward_auth` and allow oauth2-proxy callback paths.
   - Validate container CLI/admin flows still work for break-glass operations.

4. **Integrate Home Assistant with Authentik**
   - Add optional `proxyAuth` block in `modules/apps/homeassistant.nix` and route external traffic through oauth2-proxy.
   - Preserve Home Assistant local config directory and reverse-proxy settings (`use_x_forwarded_for`, trusted proxies).
   - Verify websocket/event-stream behavior behind auth proxy, because HA frontend depends on long-lived connections.

5. **Create Authentik tenants/clients and policies**
   - Define one application/provider pair per service (`homeassistant`, `openclaw`) with explicit redirect URIs.
   - Configure user/group assignment and minimal scopes (`openid profile email`) first.
   - Enable passkey/WebAuthn in Authentik and test registration/login from LAN and Tailscale clients.

6. **Validation and comparison**
   - Confirm unauthenticated access to both service URLs redirects to Authentik.
   - Confirm login, logout, session refresh, and callback flows for both apps.
   - Confirm API/websocket behavior (HA dashboards, OpenClaw UI interactions) remains stable.
   - Record operational notes: setup complexity, reliability, and day-2 admin tasks versus current Keycloak workflow.

7. **Decision checkpoint**
   - If Authentik is a better fit, create a follow-up migration plan for existing Keycloak clients.
   - If not, disable app proxy auth changes and keep Keycloak as-is.
   - Document final decision and rationale in a short retrospective under `plans/`.

## Validation checklist
- `https://authentik.leolab.party` is reachable with valid TLS and stable issuer metadata.
- `https://home.leolab.party` and `https://cora.leolab.party` require auth and complete callback flow.
- Home Assistant real-time UI (websockets) and OpenClaw control paths work after auth.
- Secrets are sourced via opnix and not committed.
- Rollback to previous generation restores access model cleanly.

## Exit criteria
- Authentik is running reliably on picard for at least several days of normal use.
- Both target apps are protected via Authentik without breaking normal operation.
- A clear keep/migrate-or-revert decision is documented with concrete reasons.
