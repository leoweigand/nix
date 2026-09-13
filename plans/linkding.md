# Plan: Linkding bookmark manager

## Decisions

- Run Linkding on Picard as a rootful Podman container.
- Publish it at `https://bookmarks.leolab.party` through the existing Caddy edge.
- Pin the `1.46.2-plus` image so local HTML snapshot archiving is available.
- Store Linkding's SQLite database, snapshots, favicons, and previews under `/mnt/fast/appdata/linkding`.
- Have Linkding create its transaction-safe full backup immediately before the existing daily `appdata` restic job captures it.
- Use Tinyauth as an OIDC provider, map users by Tinyauth's `preferred_username` claim, and hide Linkding's local login form.
- Emit `leo@leolab.party` as the stable OIDC email claim for Tinyauth user `leo`, because Linkding's upstream OIDC backend locates existing users by email.
- Read `OIDC_RP_CLIENT_SECRET` from `op://Homelab/Linkding/oidc-env`.
- Add `linkding` as a Tinyauth OIDC client with `https://bookmarks.leolab.party/oidc/callback/` as its trusted redirect URI.
- Reserve host port `9094` for Linkding so the planned Prometheus service can use its conventional port `9090`.

## Implementation

1. Add a reusable `homelab.apps.linkding` module for the container, persistent directory, opnix secret, OIDC settings, and edge proxy.
2. Import the module from `modules/apps/default.nix`.
3. Register the OIDC client and enable Linkding in Picard's homelab configuration.
4. Extend backup jobs with an optional preparation command and use it to generate Linkding's supported full-backup archive.
5. Add Linkding to the Homepage Services category.

## Activation

1. Generate one OIDC client secret and store it in both the existing Tinyauth env field and Linkding's `oidc-env` field.
2. Deploy the Picard configuration.
3. Before the first OIDC login, create the Linkding superuser with the same username and email emitted by Tinyauth.
4. Verify OIDC login, bookmark creation, browser-extension API access, and local snapshot creation.

## Validation

- Evaluate and build the Picard NixOS configuration.
- Confirm the generated container binds `127.0.0.1:9094` and does not open a firewall port.
- Confirm Caddy proxies `bookmarks.leolab.party` to Linkding.
- Confirm Linkding and Tinyauth both start after `opnix-secrets.service`.
- Confirm the `appdata` job generates `/mnt/fast/appdata/linkding/backup.zip` before restic reads the data tree.
