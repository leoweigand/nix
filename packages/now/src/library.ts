import { createHash } from "node:crypto";

const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );

function icon(id: string) {
  const seed = createHash("sha256").update(id).digest();
  const hue = seed.readUInt16BE(0) % 360;
  const y = (i: number) => 18 + (seed[i] % 44);
  const path = `M 17 ${y(2)} C 17 ${y(3)}, 39 ${y(4)}, 40 ${y(5)} S 63 ${y(6)}, 63 ${y(7)}`;
  return `<svg viewBox="0 0 80 80" aria-hidden="true"><rect width="80" height="80" rx="19" fill="hsl(${hue} 62% 44%)"/><path d="${path}" fill="none" stroke="white" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/><circle cx="${20 + (seed[8] % 40)}" cy="${16 + (seed[9] % 46)}" r="3" fill="white" opacity=".45"/></svg>`;
}

export function library(
  apps: {
    id: string;
    slug: string;
    displayName: string;
    description: string;
    url: string;
    active: string | null;
    state: string;
  }[],
) {
  const live = apps.filter((app) => app.state === "live");
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Apps</title>
<style>:root{font-family:system-ui,-apple-system,sans-serif;color-scheme:light dark;background:#f5f5f7;color:#1d1d1f}*{box-sizing:border-box}body{max-width:42rem;margin:auto;padding:24px 20px 40px}h1{font-size:28px;letter-spacing:-.6px;line-height:1.2;margin:0 0 28px;font-weight:700}ul{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:24px 12px}li{min-width:0}a,.pending{display:flex;flex-direction:column;align-items:center;gap:9px;color:inherit;text-decoration:none;text-align:center;-webkit-tap-highlight-color:transparent}svg{width:72px;height:72px;max-width:100%;filter:drop-shadow(0 2px 3px #0001)}.name{font-size:12px;line-height:1.3;font-weight:500;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}a:active svg{transform:scale(.93)}a:focus-visible{outline:2px solid currentColor;outline-offset:7px;border-radius:16px}.pending{opacity:.45}p{color:#777;font-size:15px}@media(min-width:520px){body{padding:32px}ul{grid-template-columns:repeat(4,minmax(0,1fr));gap:28px 20px}svg{width:80px;height:80px}.name{font-size:13px}}@media(prefers-color-scheme:dark){:root{background:#000;color:#f5f5f7}}</style>
<h1>Apps</h1><ul>${live.map((app) => `<li>${app.active ? `<a href="${escape(app.url)}" aria-label="${escape(app.displayName)}">` : `<div class="pending" aria-label="${escape(app.displayName)} — not deployed yet">`}${icon(app.id)}<span class="name">${escape(app.displayName)}</span>${app.active ? "</a>" : "</div>"}</li>`).join("")}</ul>${live.length ? "" : "<p>No apps yet.</p>"}</html>`;
}
