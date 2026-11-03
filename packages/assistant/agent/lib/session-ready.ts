import { setTimeout } from "node:timers/promises";

// create() waits for the address claim, but the command inbox may still be
// starting. Eve explicitly marks this refusal as retryable. Keep the caller's
// persisted delivery identity and never retry an accepted or uncertain send.
export async function sendWhenReady<T>(send: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 15_000;
  for (let delay = 25; ; delay = Math.min(delay * 2, 500)) {
    try {
      return await send();
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "session_not_ready" ||
        !("retryable" in error) ||
        error.retryable !== true ||
        Date.now() + delay > deadline
      )
        throw error;
      await setTimeout(delay);
    }
  }
}
