# Paperless email ingest

## Goal

Forward bills, receipts, contracts etc. to a dedicated mailbox; have Paperless poll it via IMAP and auto-consume PDF/image attachments. Eliminates the manual "save attachment → drop in consume folder" loop.

## Status

Not started — exploratory plan. Decisions below need to land before implementation.

## Open decisions

### 1. Where does the mailbox live?
Options:
- **Dedicated alias on existing mail provider** (e.g. `documents@<my-domain>`) → simplest, no new infra.
- **Subaddress on personal mailbox** (`me+docs@…` with a server-side filter into a Paperless folder) → no new account, but mixes concerns.
- **Self-hosted mailbox** → overkill for this.

Likely answer: dedicated alias. Need to confirm provider supports IMAP for aliases (some don't) and whether an app-password / OAuth is required.

### 2. Folder layout in the mailbox
Paperless mail rules act per-folder. Sensible default:
- `INBOX` — new mail to be processed
- `INBOX/Processed` — Paperless moves consumed mail here (audit trail, can be purged later)
- `INBOX/Failed` — manual review for things that didn't parse

### 3. Post-consume action
Choices Paperless offers per rule:
- Mark as read
- Move to folder ← preferred, gives clear "done" state
- Delete ← lossy, hard to debug failures
- Flag

Lean: **move to `Processed`**, plus tag the doc with `via-email`.

### 4. Filter scope
Initially: trust everything that lands in the mailbox (since the alias only gets things forwarded by us). Later: add per-sender rules (e.g. utility company → auto-correspondent + `bills` tag).

### 5. Attachment handling
- PDFs and images only? Or also `.eml` itself for context?
- Body-as-PDF? Useful when the bill is in the email body, not attached. Paperless supports this per-rule.

## Sketch of the work

### Secrets (1Password → opnix)
New item `Paperless Mail` in `Homelab` vault:
- `imapHost`
- `imapPort`
- `username`
- `password` (or app-password)

### NixOS module changes (`modules/apps/paperless.nix`)
Paperless mail accounts and rules live **in the Postgres DB**, not config files — they're created through the web UI. The nix side is minimal:
- No new env vars strictly required.
- Optionally bump `PAPERLESS_EMAIL_TASK_CRON` if we want polling more often than the default.
- Possibly add the `Paperless Mail` opnix secret so admins can find creds without leaving nix.

### Web UI bootstrap (manual, one-time)
1. Settings → Mail → Add Account: paste creds.
2. Settings → Mail → Add Rule:
   - Folder: `INBOX`
   - Filter: none initially
   - Action: move to `INBOX/Processed`
   - Metadata: tag `via-email`
   - Attachment type: attachments only (start), revisit body-as-PDF later.
3. Verify by sending a test PDF to the alias.

### Documentation
Add a short note to `ARCHITECTURE.md` once it works, since the mail config is DB-state and won't be obvious from reading the nix files.

## Questions to resolve before starting
- [ ] Which mail provider/alias?
- [ ] App-password support there?
- [ ] Confirm `via-email` is the tag name we want (vs. `email`, `mail`, etc.)?
- [ ] Any senders we want to whitelist on day 1 vs. open mailbox?
