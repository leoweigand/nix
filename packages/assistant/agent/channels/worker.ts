import { defineChannel, POST, GET } from "eve/channels";
import { join } from "node:path";
import { messageContent } from "../../src/conversation.ts";
import { authorized } from "../../src/inbox.ts";
import { readJson, writeJson } from "../../src/storage.ts";
import { requestDirectory, type RuntimeRequest } from "../lib/context.ts";

export default defineChannel({
  turnPolicy: "queue",
  routes: [
    GET("/internal/healthz", async () => new Response(null, { status: 204 })),
    POST("/internal/turn", async (request, { from }) => {
      if (
        !authorized(
          request.headers.get("x-assistant-secret"),
          process.env.TELEGRAM_WEBHOOK_SECRET ?? "",
        )
      )
        return new Response(null, { status: 401 });
      const body = await request.text();
      if (body.length > 4096) return new Response(null, { status: 413 });
      const { eventId } = JSON.parse(body);
      const input = readJson<RuntimeRequest>(
        join(requestDirectory(eventId), "request.json"),
      );
      if (!input) return new Response(null, { status: 404 });
      const resultPath = join(
        requestDirectory(eventId),
        `settled-${input.authRevision ?? "initial"}.json`,
      );
      const cached = readJson<unknown>(resultPath);
      if (cached) return Response.json(cached);
      const { message, ref } = input;
      const auth = {
        authenticator: "leolab-telegram",
        principalType: "user",
        principalId: input.senderId,
        attributes: { eventId },
      };
      console.info(JSON.stringify({ event: "eve_delivery_start", eventId }));
      const { session } = await from(ref.id).create({ auth });
      const delivery = await session.send(messageContent(message), {
        auth,
        idempotencyKey: `${eventId}:${input.authRevision ?? "initial"}`,
        context: input.context ? [JSON.stringify(input.context)] : [],
      });
      console.info(
        JSON.stringify({
          event: "eve_delivery_accepted",
          eventId,
          sessionId: delivery.sessionId,
        }),
      );
      const result = await delivery.result();
      console.info(
        JSON.stringify({
          event: "eve_delivery_settled",
          eventId,
          status: result.status,
        }),
      );
      const presentation = readJson<unknown>(
        join(requestDirectory(eventId), "result.json"),
      );
      const output = { ...result, presentation };
      writeJson(resultPath, output);
      return Response.json(output);
    }),
  ],
});
