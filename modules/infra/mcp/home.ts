import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

const entityId = z
  .string()
  .regex(/^(light|switch|sensor|binary_sensor|cover)\.[a-z0-9_]+$/);
const action = z.enum([
  "turn_on",
  "turn_off",
  "set_brightness",
  "open",
  "close",
  "stop",
  "set_position",
]);
export const homePolicySchema = z
  .object({
    entityId,
    name: z.string().min(1).max(160).optional(),
    room: z.string().max(100).optional(),
    aliases: z.array(z.string().min(1).max(100)).max(20).default([]),
    actions: z.array(action).default([]),
  })
  .strict();
export type HomePolicy = z.infer<typeof homePolicySchema>;
export const homeSearchSchema = z
  .object({
    query: z.string().max(160).default(""),
    domain: z
      .enum(["light", "switch", "sensor", "binary_sensor", "cover"])
      .optional(),
    limit: z.number().int().min(1).max(100).default(20),
  })
  .strict();
export const homeDetailsSchema = z.object({ entityId }).strict();
const targets = {
  entityIds: z
    .array(entityId)
    .min(1)
    .max(20)
    .refine((v) => new Set(v).size === v.length, "Duplicate targets"),
};
export const homeControlSchema = z.discriminatedUnion("action", [
  z
    .object({
      ...targets,
      action: z.enum(["turn_on", "turn_off", "open", "close", "stop"]),
    })
    .strict(),
  z
    .object({
      ...targets,
      action: z.literal("set_brightness"),
      percent: z.number().min(0).max(100),
    })
    .strict(),
  z
    .object({
      ...targets,
      action: z.literal("set_position"),
      percent: z.number().min(0).max(100),
    })
    .strict(),
]);
export type HomeControl = z.infer<typeof homeControlSchema>;
// Publish a flat object: Pi's JSON-schema coercion does not preserve root oneOf inputs.
// The same discriminated contract is still enforced before any backend operation.
export const homeControlInputSchema = z
  .object({
    ...targets,
    action,
    percent: z
      .number()
      .min(0)
      .max(100)
      .optional()
      .describe(
        "Required only for set_brightness or set_position; omit for every other action. Position is 0 closed, 100 open.",
      ),
  })
  .strict()
  .superRefine((value, ctx) => {
    const parsed = homeControlSchema.safeParse(value);
    if (!parsed.success)
      for (const issue of parsed.error.issues)
        ctx.addIssue({
          code: "custom",
          message: issue.message,
          path: issue.path,
        });
  });
const entityOutput = z
  .object({
    entityId,
    name: z.string(),
    room: z.string().nullable(),
    aliases: z.array(z.string()),
    domain: z.string(),
    state: z.string(),
    observedAt: z.string(),
    updatedAt: z.string().nullable(),
    brightnessPercent: z.number().nullable(),
    positionPercent: z.number().nullable(),
    unit: z.string().nullable(),
    availableControls: z.array(action),
  })
  .strict();
export const homeSearchOutput = z
  .object({
    entities: z.array(entityOutput),
    total: z.number().int(),
    truncated: z.boolean(),
  })
  .strict();
export const homeDetailsOutput = z.object({ entity: entityOutput }).strict();
const outcome = z.enum([
  "confirmed",
  "already_satisfied",
  "unconfirmed",
  "failed",
]);
export const homeControlOutput = z
  .object({
    outcome: z.enum([
      "confirmed",
      "already_satisfied",
      "unconfirmed",
      "failed",
      "partial_failure",
    ]),
    results: z.array(
      z
        .object({
          entityId,
          action,
          outcome,
          submitted: z.boolean().nullable(),
          observed: entityOutput.nullable(),
          error: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();
const stateSchema = z.object({
  entity_id: entityId,
  state: z.string(),
  last_updated: z.string().optional(),
  attributes: z.record(z.string(), z.unknown()).default({}),
});
type State = z.infer<typeof stateSchema>;
export class HomeError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
export interface HomeConfig {
  url: string;
  token: string;
  entities: HomePolicy[];
}

export class HomeService {
  private config: HomeConfig;
  private policy: Map<string, HomePolicy>;
  private locks = new Map<string, Promise<void>>();
  private request: typeof fetch;
  private pollMs: number;
  constructor(config: HomeConfig, request = fetch, pollMs = 300) {
    const url = new URL(config.url);
    if (
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      url.username ||
      url.password ||
      !["http:", "https:"].includes(url.protocol)
    )
      throw new HomeError("invalid_home_origin");
    this.config = config;
    this.policy = new Map(
      config.entities.map((p) => {
        const parsed = homePolicySchema.parse(p);
        return [parsed.entityId, parsed];
      }),
    );
    if (this.policy.size !== config.entities.length)
      throw new HomeError("duplicate_home_policy");
    this.request = request;
    this.pollMs = pollMs;
  }
  private async api(
    path: string,
    signal: AbortSignal,
    body?: unknown,
  ): Promise<unknown> {
    if (!this.config.token) throw new HomeError("home_not_configured");
    const response = await this.request(new URL(path, this.config.url), {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new HomeError(`home_http_${response.status}`);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new HomeError("invalid_home_response");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 16 * 1024 * 1024)
          throw new HomeError("home_response_too_large");
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  private allowed(id: string) {
    const policy = this.policy.get(id);
    if (!policy) throw new HomeError("home_entity_not_allowed");
    return policy;
  }
  private controls(state: State, policy: HomePolicy) {
    if (["unavailable", "unknown"].includes(state.state)) return [];
    const domain = state.entity_id.split(".")[0];
    const features =
      typeof state.attributes.supported_features === "number"
        ? state.attributes.supported_features
        : 0;
    const modes = state.attributes.supported_color_modes;
    return policy.actions.filter((a) => {
      if (["turn_on", "turn_off"].includes(a))
        return ["light", "switch"].includes(domain);
      if (a === "set_brightness")
        return (
          domain === "light" &&
          Array.isArray(modes) &&
          modes.some((m) => !["onoff", "unknown"].includes(m))
        );
      return (
        domain === "cover" &&
        Boolean(
          features &
          ({ open: 1, close: 2, set_position: 4, stop: 8 }[a as "open"] ?? 0),
        )
      );
    });
  }
  private present(state: State) {
    const p = this.allowed(state.entity_id),
      a = state.attributes;
    return {
      entityId: state.entity_id,
      name:
        p.name ??
        (typeof a.friendly_name === "string"
          ? a.friendly_name
          : state.entity_id),
      room: p.room ?? null,
      aliases: p.aliases,
      domain: state.entity_id.split(".")[0],
      state: state.state,
      observedAt: new Date().toISOString(),
      updatedAt: state.last_updated ?? null,
      brightnessPercent:
        typeof a.brightness === "number"
          ? Math.round((a.brightness / 255) * 100)
          : null,
      positionPercent:
        typeof a.current_position === "number" ? a.current_position : null,
      unit:
        typeof a.unit_of_measurement === "string"
          ? a.unit_of_measurement
          : null,
      availableControls: this.controls(state, p),
    };
  }
  private async state(id: string, signal: AbortSignal) {
    this.allowed(id);
    const state = stateSchema.parse(
      await this.api(`/api/states/${encodeURIComponent(id)}`, signal),
    );
    if (state.entity_id !== id) throw new HomeError("home_entity_mismatch");
    return state;
  }
  async search(input: z.infer<typeof homeSearchSchema>, signal: AbortSignal) {
    // Filter before parsing: unrelated domains and attributes never enter results.
    const raw = await this.api("/api/states", signal);
    if (!Array.isArray(raw)) throw new HomeError("invalid_home_response");
    const terms = input.query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const entities = raw
      .filter((s) => s && typeof s === "object" && this.policy.has(s.entity_id))
      .map((s) => this.present(stateSchema.parse(s)))
      .filter(
        (s) =>
          (!input.domain || s.domain === input.domain) &&
          terms.every((t) =>
            [s.entityId, s.name, s.room ?? "", ...s.aliases]
              .join(" ")
              .toLocaleLowerCase()
              .includes(t),
          ),
      )
      .sort((a, b) => a.entityId.localeCompare(b.entityId));
    return {
      entities: entities.slice(0, input.limit),
      total: entities.length,
      truncated: entities.length > input.limit,
    };
  }
  async details(id: string, signal: AbortSignal) {
    return { entity: this.present(await this.state(id, signal)) };
  }
  async control(raw: HomeControl, signal: AbortSignal) {
    const input = homeControlSchema.parse(raw);
    for (const id of input.entityIds) this.allowed(id);
    // Reserve every target synchronously; overlapping batches cannot deadlock.
    const previous = input.entityIds.map(
      (id) => this.locks.get(id) ?? Promise.resolve(),
    );
    let release!: () => void;
    const own = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = Promise.all(previous).then(() => own);
    for (const id of input.entityIds) this.locks.set(id, held);
    try {
      await Promise.all(previous);
      signal.throwIfAborted();
      const states = await Promise.all(
        input.entityIds.map((id) => this.state(id, signal)),
      );
      for (const s of states)
        if (!this.controls(s, this.allowed(s.entity_id)).includes(input.action))
          throw new HomeError("home_action_not_supported");
      const results: z.infer<typeof homeControlOutput>["results"] = [];
      const matches = (s: State) => {
        switch (input.action) {
          case "turn_on":
            return s.state === "on";
          case "turn_off":
            return s.state === "off";
          case "open":
            return (
              s.state === "open" &&
              (s.attributes.current_position === undefined ||
                s.attributes.current_position === 100)
            );
          case "close":
            return s.state === "closed";
          case "set_brightness":
            return input.percent === 0
              ? s.state === "off"
              : s.state === "on" &&
                  typeof s.attributes.brightness === "number" &&
                  Math.abs(
                    (s.attributes.brightness / 255) * 100 - input.percent,
                  ) <= 1;
          case "set_position":
            return (
              typeof s.attributes.current_position === "number" &&
              Math.abs(s.attributes.current_position - input.percent) <= 1
            );
          case "stop":
            return false; // A stationary state does not prove a stop command reached the motor.
        }
      };
      for (const before of states) {
        let submitted: boolean | null = false;
        let observed: z.infer<typeof entityOutput> | null =
          this.present(before);
        try {
          signal.throwIfAborted();
          if (matches(before)) {
            results.push({
              entityId: before.entity_id,
              action: input.action,
              outcome: "already_satisfied",
              submitted,
              observed,
              error: null,
            });
            continue;
          }
          const domain = before.entity_id.split(".")[0];
          const service = {
            turn_on: "turn_on",
            turn_off: "turn_off",
            set_brightness:
              input.action === "set_brightness" && input.percent === 0
                ? "turn_off"
                : "turn_on",
            open: "open_cover",
            close: "close_cover",
            stop: "stop_cover",
            set_position: "set_cover_position",
          }[input.action];
          const body = {
            entity_id: before.entity_id,
            ...(input.action === "set_brightness" && input.percent > 0
              ? { brightness_pct: input.percent }
              : {}),
            ...(input.action === "set_position"
              ? { position: input.percent }
              : {}),
          };
          submitted = null;
          await this.api(`/api/services/${domain}/${service}`, signal, body);
          submitted = true;
          observed = null;
          let confirmed = false;
          for (let i = 0; i < 5; i++) {
            const after = await this.state(before.entity_id, signal);
            observed = this.present(after);
            if (matches(after)) {
              confirmed = true;
              break;
            }
            if (i < 4) await delay(this.pollMs, undefined, { signal });
          }
          results.push({
            entityId: before.entity_id,
            action: input.action,
            outcome: confirmed ? "confirmed" : "unconfirmed",
            submitted,
            observed,
            error: null,
          });
        } catch (error) {
          results.push({
            entityId: before.entity_id,
            action: input.action,
            outcome: submitted === false ? "failed" : "unconfirmed",
            submitted,
            observed: submitted === false ? observed : null,
            error:
              error instanceof HomeError ? error.code : "home_result_uncertain",
          });
        }
      }
      const outcomes = results.map((r) => r.outcome);
      const summary = outcomes.every((o) => o === "already_satisfied")
        ? "already_satisfied"
        : outcomes.every((o) => ["confirmed", "already_satisfied"].includes(o))
          ? "confirmed"
          : new Set(outcomes).size === 1
            ? outcomes[0]
            : "partial_failure";
      return homeControlOutput.parse({ outcome: summary, results });
    } finally {
      release();
      for (const id of input.entityIds)
        if (this.locks.get(id) === held) this.locks.delete(id);
    }
  }
}
