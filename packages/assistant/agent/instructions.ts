import { defineDynamic, defineInstructions } from "eve/instructions";
import { runtimeContext } from "./lib/context.ts";

export default defineDynamic((ctx) => {
  const { sessions, ref, message } = runtimeContext(ctx);
  const instructions = sessions.loadInstructions(ref);
  return defineInstructions({
    content:
      instructions.system +
      "\n" +
      instructions.channel +
      `
You are running in Eve. Use the coder subagent for substantive coding work;
it uses DeepSeek Flash and has no access to this conversation unless you include
requirements in your delegation message. Do not delegate personal lab operations.
Lab tools are on the leolab MCP connection. Discover them with eve__search and
call them with eve__tool; names are leolab__<tool>. All previous lab tool rules
still apply. Use connect_mcp when a required permission or connection is missing.
Current audience: ${message.audience}. Time zone: Europe/Berlin.
The host provides external notifications and the current human request as context.
Do not claim tools, deployments or Now capabilities exist unless discovered.
`,
  });
});
