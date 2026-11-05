import type { ToolJournal } from "../agent/lib/context.ts";
import type { ReplyButton } from "./replies.ts";

export interface NowAppLink {
  id: string;
  name: string;
  url: string;
}

// App bodies and model-written URLs are not evidence that an app exists.
export function verifiedNowApps(journal?: ToolJournal): NowAppLink[] {
  const apps = new Map<string, NowAppLink>();
  for (const entry of journal?.entries ?? []) {
    const result = entry.result as Record<string, any> | undefined;
    if (!result || typeof result !== "object") continue;
    if (
      entry.tool === "mcp__leolab__now_destroy" ||
      result.outcome === "destroyed"
    ) {
      if (typeof entry.input.appId === "string") apps.delete(entry.input.appId);
      continue;
    }
    if (
      ![
        "now_list",
        "now_get",
        "now_create",
        "now_rename",
        "now_deploy",
        "now_rollback",
      ].some((name) => entry.tool === `mcp__leolab__${name}`)
    )
      continue;
    const candidates =
      entry.tool === "mcp__leolab__now_list" ? result.apps : [result.app];
    if (!Array.isArray(candidates)) continue;
    for (const app of candidates) {
      if (!app || typeof app.id !== "string") continue;
      if (!app.active || app.state !== "live") {
        apps.delete(app.id);
        continue;
      }
      if (typeof app.url !== "string" || !URL.canParse(app.url)) continue;
      const url = new URL(app.url);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.port ||
        url.pathname !== "/" ||
        url.search ||
        url.hash
      )
        continue;
      apps.set(app.id, {
        id: app.id,
        name: typeof app.displayName === "string" ? app.displayName : "app",
        url: app.url,
      });
    }
  }
  return [...apps.values()];
}

export function withNowLaunchButtons(
  text: string,
  apps: NowAppLink[] = [],
  buttons: ReplyButton[] = [],
): ReplyButton[] {
  const links = new Set(
    (text.match(/https:\/\/[^\s<>()\[\]"']+/g) ?? []).flatMap((raw) => {
      const value = raw.replace(/[.,;!?]+$/, "");
      return URL.canParse(value) ? [new URL(value).origin] : [];
    }),
  );
  const selected = apps.filter((app) => links.has(new URL(app.url).origin));
  const missing = selected.filter(
    (app) =>
      !buttons.some(
        (button) =>
          button.url &&
          URL.canParse(button.url) &&
          new URL(button.url).href === new URL(app.url).href,
      ),
  );
  return [
    ...missing.map((app) => ({
      label: selected.length === 1 ? "Open app" : `Open ${app.name}`,
      url: app.url,
    })),
    ...buttons,
  ].slice(0, 6);
}
