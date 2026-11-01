import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createAgentSession,
  createMcpExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ConversationMessage } from "./conversation.ts";
import { Sessions, MODEL_ID, type SessionRef } from "./sessions.ts";

const allowedTools = [
  "mcp__leolab__whoami",
  "mcp__leolab__search_media",
  "mcp__leolab__get_media_details",
  "mcp__leolab__request_media",
];

export class PiAssistant {
  stateDir: string;
  active?: AgentSession;
  mcpUrl: string;
  sessions: Sessions;
  constructor(
    stateDir: string,
    sessions: Sessions,
    mcpUrl = "https://mcp.leolab.party/mcp",
  ) {
    this.stateDir = stateDir;
    this.mcpUrl = mcpUrl;
    this.sessions = sessions;
  }
  async answer(
    message: ConversationMessage,
    ref: SessionRef,
    token?: string,
    onWriteAttempt: () => void = () => {},
    react: (emoji: string) => Promise<void> = async () => {
      throw new Error("Reaction unavailable");
    },
  ): Promise<{ text: string; needsConnection: boolean; compacted?: boolean }> {
    const agentDir = join(this.stateDir, "agents", "runtime");
    const cwd = join(this.stateDir, "workspace");
    for (const dir of [agentDir, cwd])
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    const instructions = this.sessions.loadInstructions(ref);
    writeFileSync(
      join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          leolab: {
            baseUrl: "https://ai.internal.leolab.party/v1",
            api: "openai-completions",
            apiKey: "internal-gateway",
            models: [
              {
                id: MODEL_ID,
                name: "LeoLab DeepSeek Flash",
                reasoning: false,
                input: ["text"],
                contextWindow: 131072,
                maxTokens: 2048,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      }),
      { mode: 0o600 },
    );
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
      allowModelNetwork: false,
    });
    const model = modelRuntime.getModel("leolab", MODEL_ID);
    if (!model) throw new Error("Assistant model is unavailable");
    const settingsManager = SettingsManager.inMemory({
      retry: { enabled: false },
      compaction: {
        enabled: true,
        reserveTokens: 4096,
        keepRecentTokens: 12000,
      },
    });
    let toolCalls = 0;
    let needsConnection = false;
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      appendSystemPrompt: [instructions.channel],
      systemPrompt:
        instructions.system +
        (token
          ? "\nYour MCP connection is authenticated for the current sender."
          : "\nMCP is not connected. For ANY media search, library availability, details or download request, call connect_mcp. Do not answer those from memory or claim they are unavailable. You may answer ordinary conversation without connecting. Do not invent a sign-in URL."),
      extensionFactories: [
        ...(token
          ? [
              createMcpExtension({
                loadConfig: () => ({
                  servers: [
                    {
                      name: "leolab",
                      source: "assistant",
                      config: {
                        url: this.mcpUrl,
                        headers: { Authorization: `Bearer ${token}` },
                        exposure: "direct",
                      },
                    },
                  ],
                  errors: [],
                  autoEnableCodemode: false,
                }),
                openUrl: () => {
                  throw new Error("Use the channel connection flow");
                },
                startupWaitMs: 15000,
              }),
            ]
          : []),
        (pi) => {
          pi.registerTool({
            name: "react_to_message",
            label: "React to message",
            description:
              "Set one Telegram emoji reaction on the current user's message. Provide the emoji as text.",
            parameters: Type.Object({
              emoji: Type.String({ minLength: 1, maxLength: 32 }),
            }),
            execute: async (_id, args) => {
              await react(args.emoji);
              return {
                content: [{ type: "text", text: "Reaction sent." }],
                details: {},
              };
            },
          });
          if (!token)
            pi.registerTool({
              name: "connect_mcp",
              label: "Connect LeoLab MCP",
              description:
                "Connect the requesting user's Pocket ID account. Required before any film/TV lookup, library inspection or media download request.",
              parameters: Type.Object({}),
              execute: async () => {
                needsConnection = true;
                return {
                  content: [
                    {
                      type: "text",
                      text: "The worker will privately send the user a sign-in link and resume this request afterwards. Stop here.",
                    },
                  ],
                  details: { needsConnection: true },
                };
              },
            });
          pi.on("tool_call", (event) => {
            if (!token && event.toolName === "connect_mcp") return;
            if (event.toolName === "react_to_message") return;
            if (!allowedTools.includes(event.toolName) || ++toolCalls > 8)
              return {
                block: true,
                reason:
                  "This assistant only supports up to eight media tool calls per message.",
              };
            if (event.toolName === "mcp__leolab__request_media") {
              try {
                onWriteAttempt();
              } catch {
                return {
                  block: true,
                  reason:
                    "The request cannot be submitted because its durable receipt could not be saved. Do not retry this request.",
                };
              }
            }
          });
          pi.on("turn_start", (_event, ctx) => {
            if (toolCalls > 8) ctx.abort();
          });
        },
      ],
    });
    await loader.reload();
    const sessionManager = this.sessions.open(ref);
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      modelRuntime,
      model,
      thinkingLevel: "off",
      tools: token
        ? [...allowedTools, "react_to_message"]
        : ["connect_mcp", "react_to_message"],
      resourceLoader: loader,
      sessionManager,
      settingsManager,
    });
    this.active = session;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void session.abort();
    }, 120000);
    try {
      await session.bindExtensions({});
      const deadline = Date.now() + 15000;
      while (
        token &&
        !session.getActiveToolNames().includes("mcp__leolab__search_media") &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (
        token &&
        !session.getActiveToolNames().includes("mcp__leolab__search_media")
      )
        throw new Error(
          "MCP lookup tools are unavailable; check the assistant OAuth connection",
        );
      await session.sendCustomMessage(
        {
          customType: "request_context",
          content: JSON.stringify({
            type: "runtime_context",
            current_time: new Date().toISOString(),
            time_zone: "Europe/Berlin",
            audience: message.audience,
            requester: message.author,
            instruction:
              "Respond to the current human request. If a connection was just established, continue that request using the available tools.",
          }),
          display: false,
        },
        { triggerTurn: true },
      );
      if (timedOut) throw new Error("Assistant timed out");
      const last = [...session.messages]
        .reverse()
        .find((m) => m.role === "assistant");
      if (
        last &&
        "stopReason" in last &&
        (last.stopReason === "error" || last.stopReason === "aborted")
      )
        throw new Error("Assistant inference failed");
      const text = session.getLastAssistantText()?.trim();
      if (!text) throw new Error("Assistant returned no response");
      console.info(
        JSON.stringify({
          event: "assistant_answer",
          eventId: message.eventId,
          toolCalls,
        }),
      );
      if (needsConnection) {
        const lastEntry = [...sessionManager.getEntries()]
          .reverse()
          .find((e) => e.type === "message" && e.message.role === "assistant");
        if (lastEntry)
          sessionManager.appendContextEdit(lastEntry.id, {
            content:
              "[The assistant requested a connection. The host handles the private sign-in link. No answer was delivered yet.]",
          });
      }
      return {
        text,
        needsConnection,
        compacted: sessionManager
          .getEntries()
          .some((e) => e.type === "compaction"),
      };
    } finally {
      clearTimeout(timer);
      session.dispose();
      this.active = undefined;
    }
  }
}
