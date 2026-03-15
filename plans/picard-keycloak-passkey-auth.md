# Plan: Keycloak passkey auth for lab services

## Context
- Picard currently exposes services through Caddy at `*.leolab.party` with no shared SSO layer.
- We want OAuth/OIDC integration per app when supported, while keeping a consistent login experience.
- Primary login method should be passkeys (WebAuthn) managed by a central IdP.

## Goal
- Add a central Keycloak IdP on picard and use it to protect Paperless first with passkey-first authentication.

## Final shape
- `auth.leolab.party` serves Keycloak behind Caddy.
- Keycloak is the single OIDC issuer for lab apps.
- Phase 1 protects only `paperless.leolab.party`.
- App auth pattern remains per-service for later phases:
  - Native OIDC for apps that support it well.
  - `oauth2-proxy` + Caddy `forward_auth` for services without good native OIDC support.
- Passkeys are enabled in Keycloak and used as the default interactive login method.
- A break-glass admin path exists and is documented.

## Non-goals
- No migration to Authentik/ZITADEL in this implementation.
- No user directory sync (LDAP/AD) in this phase.
- No internet exposure changes beyond current Caddy/TLS model.

## Design decisions
1. **Identity provider**
   - Use NixOS `services.keycloak` with PostgreSQL for persistence.
   - Keep Keycloak bound to localhost and exposed only through Caddy.

2. **Token broker for legacy apps**
   - Use NixOS `services.oauth2-proxy` on localhost.
   - Use Caddy `forward_auth` for services that lack good native OIDC support.

3. **Realm/client model**
   - Create one realm for homelab users and one OIDC client per service.
   - Use explicit redirect URIs per service subdomain.
   - Start with minimal scopes (`openid profile email`) and add claims only when needed.

4. **Passkey strategy**
   - Enable WebAuthn in Keycloak and make it the primary browser login path.
   - Keep one emergency non-passkey admin login credential in 1Password for recovery.

5. **Secret management**
   - Store Keycloak admin/bootstrap credentials, OIDC client secrets, and oauth2-proxy cookie secret in 1Password via opnix.
   - Avoid putting secrets directly in Nix options that end up in the store.

## Rollout plan
1. **Add auth foundation modules**
   - Add a new module for Keycloak service settings, storage paths, systemd ordering, and Caddy virtual host (`auth.leolab.party`).
   - Add a new module for oauth2-proxy with secret file wiring and localhost bind.
   - Add auth-specific options under `lab.auth.*` so service modules can opt into `native-oidc` or `proxy-auth`.

2. **Prepare persistence, backups, and recovery**
   - Place Keycloak state in a persistent path included in the picard `state` backup job.
   - Ensure PostgreSQL backups include Keycloak DB dumps.
   - Document restore order for auth stack: PostgreSQL -> Keycloak -> oauth2-proxy -> Caddy.

3. **Configure Keycloak baseline**
   - Create realm, admin user, and base security settings.
   - Configure hostname/proxy settings so issuer URLs remain `https://auth.leolab.party/...`.
   - Enable WebAuthn passkeys and test registration/login from at least one LAN and one Tailscale client.

4. **Implement Paperless-only integration (phase 1)**
   - Integrate only `paperless.leolab.party` with Keycloak in this phase.
   - Complete end-to-end login, logout, callback, cookie, and API checks for Paperless.
   - Keep a tested rollback path so Paperless auth can be reverted independently.

5. **Freeze and document phase 1 before further app rollout**
   - Document the exact Paperless auth wiring and lessons learned.
   - Capture known caveats and troubleshooting notes.
   - Keep local admin access path during initial rollout to avoid lockout.

6. **Plan separate follow-up phases per app**
   - Add one follow-up plan item per app (`immich`, `homeassistant`, `openclaw`, `zigbee2mqtt`).
   - For each app phase, decide `native-oidc` vs `proxy-auth`, then validate browser/API/websocket behavior.
   - Ship each app in an isolated change so rollback remains simple.

7. **Harden and document operations**
   - Set session lifetimes and refresh behavior in Keycloak/oauth2-proxy.
   - Document user lifecycle tasks (add user, register passkey, revoke access, rotate client secret).
   - Add break-glass and rollback runbook.

## Service rollout scope
- **Phase 1 now**: `paperless` only.
- **Later, separate phases**: `immich`, `homeassistant`, `openclaw`, `zigbee2mqtt` (one app per step).

## Security model
- IdP and oauth2-proxy are internal-only listeners; Caddy is the only public ingress.
- All OIDC clients use least-privilege scopes and explicit callback URLs.
- Secrets are sourced from 1Password/opnix and never committed.
- Break-glass admin credential and recovery steps prevent passkey lockout scenarios.

## Validation
- `auth.leolab.party` serves Keycloak over valid TLS on LAN and Tailscale paths.
- Passkey registration and passkey login succeed for a normal user account.
- `paperless.leolab.party` denies unauthenticated access and redirects to Keycloak login.
- After login, Paperless callbacks succeed and sessions persist as expected.
- Backups contain auth state (Keycloak DB and related secrets) and can be restored in staging.
- Rolling back to previous Nix generation restores prior service accessibility.

## Exit criteria
- Keycloak is live at `auth.leolab.party`.
- Passkey login is working for day-to-day user sign-in.
- Paperless is integrated and protected successfully.
- Recovery docs cover lockout, secret rotation, and restore steps.
- Follow-up per-app rollout steps are documented for the remaining services.
