# Eve local-world terminal recovery

`patch-eve.ts` repairs terminal persistence in the exact Workflow local world
bundled with Eve 1.0.0-rc.2 (world-local 5.1.2). It checks the package version,
original source hash, replacement anchors and patched source hash. The upstream
implementation is Apache-2.0 licensed; its installed notices remain in the package.

The original code publishes a permanent terminal marker, updates the checkpoint,
then appends the event. An interruption can leave a running checkpoint with a
terminal marker, or a terminal checkpoint without its event. Both step and run
terminal transitions need recovery.

The patch replaces the marker claim with a redo record containing the terminal
result and event (or the run's prior state and terminal event). It writes and
fsyncs a temporary file, claims the marker with an exclusive hard link, then
fsyncs the directory. Startup completes claimed records before starting the queue.
It preserves existing event IDs and appends only when the terminal event is
absent. Run recovery retains the upstream staged-hook cleanup, terminal-event
ordering, hook/wait cleanup and data-retention behaviour. The marker becomes
empty only after the checkpoint and event are synced. Unclaimed temporary files
can be discarded; incomplete legacy empty markers and malformed journals fail
startup without silently altering uncertain state.

`npm ci` applies the patch through `postinstall`. `npm run build` applies/checks
it again before building Eve, including after `npm ci --ignore-scripts`. The Nix
package uses that same build command. Do not build directly with `eve build`
after deliberately disabling installation scripts.

The worker also persists the delivery ID before dispatch. Eve's idempotency key
prevents duplicate work, but a fresh delivery ID otherwise returns an ignored
result instead of following the original delivery. This release's implementation
accepts `deliveryId` even though its public TypeScript options omit it; the patch
script also checks that implementation's hash.

The supervised engine and integration fixture disable inline ownership leases.
One process owns this local world; retaining a dead process's 860-second lease
would delay unfinished inference after restart. Workflow's in-process step
single-flight remains active. This configuration is not for several processes
sharing one state directory.

Normal tests include the storage fault-injection matrix and built-engine restart
checks; no opt-in crash flag or settling sleep is required. The matrix kills
child processes while writing and recovering successful/failed steps and
completed/failed/cancelled runs, and checks repeated recovery and uncertain legacy
state. Integration checks kill the engine immediately after replying and during
root/coder inference, then follow the original delivery and durable conversation.
A settled reply must not replay inference. An inference interrupted before a
result is recorded may run again; remote writes retain the assistant's separate
durable receipt guards.

This is a terminal-transition repair, not a general transactional replacement for
the local world or proof against every filesystem/power-loss failure. Review and
remove or update the patch when changing Eve. Old corrupted state with an empty
marker has no trustworthy redo payload and cannot be repaired automatically.

Picard keeps the engine working directory on its native filesystem at
`/var/lib/leolab-assistant-eve`. Its systemd StateDirectory is private and included
in the appdata backup, including while Pi is selected. The existing Telegram
inbox, grants and delivery receipts remain on `/mnt/fast/appdata/leolab-assistant`.
The virtiofs export reproducibly returns `ESTALE` for `link(a, b); unlink(a);
read(b)`, a primitive used throughout the upstream local world. The shared mount
is unchanged. The supervisor requires `ASSISTANT_EVE_STATE_DIR` explicitly, and
the launcher grants that path only to Eve.
