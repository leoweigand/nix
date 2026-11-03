import { defineHook } from "eve/hooks";
import { recordLabResult } from "../../../lib/lab-results.ts";

// Coder results share the initiating request's journal. Its own compaction
// does not compact the human conversation or produce a Telegram notice.
export default defineHook({ events: { "call.settled": recordLabResult } });
