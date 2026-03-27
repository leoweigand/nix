# n8n Self-Hosting Plan

## Goal
Add n8n workflow automation to picard using the native NixOS `services.n8n` module with PostgreSQL and reverse proxy.

## Notes
- n8n OIDC/SSO is enterprise-only; using n8n's built-in user accounts
- No TinyAuth forward auth — n8n's own login is sufficient
- Encryption key is required — n8n uses it to encrypt stored workflow credentials

## Steps

### 1. 1Password secrets
Create an item `n8n` in the `Homelab` vault with:
- `encryptionKey` — random 32-char string (used to encrypt credentials at rest)
- `dbPassword` — password for the `n8n` postgres user

### 2. `modules/apps/n8n.nix`
Native service module following the paperless pattern:
- Options: `enable`, `subdomain` (default `"n8n"`), `dataDir` (default `/mnt/fast/appdata/n8n`)
- Provision PostgreSQL database + user via `services.postgresql.ensure*`
- Pull secrets from 1Password via `services.onepassword-secrets`
- Pass DB password and encryption key via `EnvironmentFile`
- Hook `services.n8n` systemd unit to wait on `opnix-secrets.service`
- Register proxy at `homelab.infra.edge.proxies.${cfg.subdomain}`

### 3. `machines/picard/homelab.nix`
Enable the app:
```nix
apps.n8n = {
  enable = true;
  dataDir = "${mounts.fast}/appdata/n8n";
};
```

### 4. Deploy
```
sudo nixos-rebuild switch --flake .#picard
```
Then complete the initial account setup at `https://n8n.leolab.party`.

## Open questions
- Should n8n data (SQLite-equivalent, now postgres) be added to the postgres backup job? → Yes, it already will be — `services.postgresqlBackup` backs up all databases by default.
- Should the `appdata/n8n` dir be explicitly excluded or included in the appdata restic backup? It only holds the user folder (not the DB), so including it is fine.
