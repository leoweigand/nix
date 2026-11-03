#!/run/current-system/sw/bin/bash
set -euo pipefail
# Match modules/infra/assistant's filesystem and TCP policy. The immutable
# engine tests substitute private scratch paths and their allocated fixture ports.
args=(
  --rox /nix/store --ro /etc/resolv.conf --ro /etc/nsswitch.conf
  --ro /etc/hosts --ro /dev/urandom --ro /proc/self --ro /proc/meminfo --ro /proc/cpuinfo
  --rw "$ASSISTANT_STATE_DIR" --rw "$ASSISTANT_EVE_STATE_DIR"
  --ro "$ASSISTANT_INSTRUCTIONS_FILE" --ro "$EVE_SANDBOX_ROOT/credentials"
  --env "HOME=$ASSISTANT_STATE_DIR" --env "PI_CODING_AGENT_DIR=$ASSISTANT_STATE_DIR/agent"
  --env "CREDENTIALS_DIRECTORY=$EVE_SANDBOX_ROOT/credentials"
  --connect-tcp 443 --connect-tcp "${EVE_SANDBOX_FIXTURE_PORT:-9087}"
  --connect-tcp "${EVE_SANDBOX_ENGINE_PORT:-9091}"
  --bind-tcp 9090 --bind-tcp "${EVE_SANDBOX_ENGINE_PORT:-9091}"
)
for name in ASSISTANT_STATE_DIR ASSISTANT_EVE_STATE_DIR ASSISTANT_INSTRUCTIONS_FILE \
  ASSISTANT_POCKET_ID_SUBJECT ASSISTANT_OAUTH_CALLBACK_URL ASSISTANT_RUNTIME \
  TELEGRAM_WEBHOOK_SECRET TELEGRAM_DESTINATIONS ASSISTANT_BOT_USERNAME \
  PORT HOST NITRO_HOST NITRO_PORT WORKFLOW_LOCAL_BASE_URL WORKFLOW_INLINE_OWNERSHIP \
  ASSISTANT_AI_URL ASSISTANT_MCP_URL EVE_FIXTURE_URL SSL_CERT_FILE; do
  if [[ -v "$name" ]]; then args+=(--env "$name"); fi
done
exec "$EVE_CHECK_LANDRUN" "${args[@]}" -- "$@"
