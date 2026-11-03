# Eve verification

Build the assistant before running the engine checks. Normal `node --test
src/*_test.ts` uses deterministic local models and synthetic OAuth/MCP fixtures.
It makes no Telegram requests.

## Picard service sandbox

Run `verify-eve-sandbox.sh` on Picard with three explicit immutable paths:

```sh
bash verify-eve-sandbox.sh \
  /nix/store/…-leolab-assistant-1.1.0 \
  /nix/store/…-landrun-0.1.17/bin/landrun \
  /nix/store/…-nodejs-26.13.0/bin/node
```

Keep the other `eve-sandbox-*` scripts beside it. The runner uses `sudo -n` to
create private scratch directories and a transient systemd service as
`leolab-assistant`. It runs the package's complete test suite sequentially,
with the assistant service's hardening, 1 GiB memory limit and 64-task limit.
It adds a private network namespace and makes live assistant state inaccessible.
Request fixtures use virtiofs; workflow and storage fixtures use native storage.

A test-only preload wraps built engine launches in the patched Landlock binary.
The filesystem and TCP policy follows the assistant launcher, substituting
scratch paths and the fixture's allocated loopback ports. The fixture's network
preload and environment variables are allowed only for those test children.
The runner also proves unapproved reads, writes and TCP connections are denied,
then starts the immutable package's actual worker/supervisor on ports 9090/9091
and checks health and graceful shutdown. Its empty inbox causes no Telegram
messages. Scratch directories and the transient unit are removed afterwards.

This checks the candidate under service-equivalent restrictions; it does not
activate the production unit or verify a backup snapshot.

## Real Haiku → DeepSeek authoring

The existing MCP integration fixture has an explicit opt-in mode:

```sh
EVE_LIVE_AUTHORING_TEST=1 \
EVE_SMOKE_MCP_URL=http://127.0.0.1:18976/mcp \
EVE_SMOKE_AUTH_FILE=/private/fixture/smoke-auth.json \
EVE_SMOKE_PROMPT_FILE=/private/fixture/prompt.txt \
EVE_SMOKE_ARTIFACT_DIR=/private/fixture/results \
node --test src/eve-mcp_test.ts
```

Use an isolated MCP/Now stack and synthetic credentials. The endpoint must be
loopback HTTP. The auth file has `subject`, public `jwks`, `tokens` containing
`access_token` and a synthetic `refresh_token`, and `tokensExpireAt` in epoch
milliseconds. The grant must remain valid for over thirty minutes. It uses the
normal assistant JWT contract: RS256, `typ: at+jwt`, issuer
`https://auth.leolab.party`, audience `https://mcp.leolab.party/mcp`, and
`client_id: leolab-mcp-telegram`, with the required `now:read now:write` scopes.
The real fixture MCP server must verify the same signature and claims.

The test serves those public keys to Eve, verifies the bearer token before
forwarding MCP, and preserves the body and protocol headers. It replaces Host
with the loopback destination's Host. Model requests use the actual lab AI
gateway; no Telegram is involved. The fixture stores synthetic grants only in
its private temporary request directory and removes that directory on exit.

A successful run requires both Haiku and DeepSeek inference and the
`now_put_source`, `now_build`, `now_deploy` and `now_request` operations, with a
confirmed source revision, ready build, active release and successful app HTTP
response. The runner also verifies the completed request survives an engine
restart without more inference. Review the saved tool journal and responses for
application-specific acceptance checks; generic HTTP success is not proof that
every app feature works. Private artifacts contain model requests,
MCP operation inputs without bearer tokens, the journal, engine log and final
response. The live mode is never enabled by the normal package test suite.

For a fresh-conversation frontend update, set `EVE_SMOKE_UPDATE_TEST=1` and
`EVE_SMOKE_PRESERVED_VALUES` to a JSON array of seeded strings expected in the
app's response after deployment. That mode also requires list/get discovery,
partial source updates containing only `public/*` files, the previous active
release as the deploy precondition, and no app creation or destruction. Each
invocation starts with fresh assistant conversation/workflow state; the
isolated Now fixture retains the existing app and user data.
