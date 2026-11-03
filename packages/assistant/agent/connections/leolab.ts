import { defineDynamic, defineMcpClientConnection } from "eve/connections";
import { connectionStore, runtimeContext } from "../lib/context.ts";
import { availableTools } from "../../src/tools.ts";
import { labApproval } from "../lib/policy.ts";

export default defineDynamic(async (ctx) => {
  const { message, senderId } = runtimeContext(ctx);
  const token = await connectionStore().token(senderId);
  if (!token) return null;
  return defineMcpClientConnection({
    url: process.env.ASSISTANT_MCP_URL ?? "https://mcp.leolab.party/mcp",
    description:
      "LeoLab documents, bookmarks, media and approved home controls for the authenticated caller.",
    instanceKey: senderId,
    auth: {
      principalType: "user",
      getToken: async () => {
        const token = await connectionStore().token(senderId);
        if (!token) throw new Error("Reconnect with connect_mcp");
        return { token };
      },
    },
    tools: {
      allow: availableTools(token, message.audience).map((name) =>
        name.replace("mcp__leolab__", ""),
      ),
    },
    approval: labApproval,
  });
});
