const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export function library(
  apps: {
    slug: string;
    description: string;
    url: string;
    active: string | null;
    state: string;
  }[],
) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Now apps</title>
<style>:root{font-family:system-ui,sans-serif;color-scheme:light dark}*{box-sizing:border-box}body{max-width:48rem;margin:auto;padding:1.25rem;line-height:1.5}h1{margin-bottom:.25rem}header p{margin-top:0;opacity:.7}input{font:inherit;width:100%;padding:.8rem;border:1px solid #8888;border-radius:.6rem;background:transparent;color:inherit}ul{list-style:none;padding:0;display:grid;gap:.75rem}li{border:1px solid #8885;border-radius:.75rem}a,li>div{display:block;color:inherit;text-decoration:none;padding:1rem}a:focus-visible,a:hover{outline:2px solid currentColor;border-radius:.75rem}h2{font-size:1.1rem;margin:0}li p{margin:.4rem 0 0;overflow-wrap:anywhere}small{opacity:.7}[hidden]{display:none}</style>
<header><h1>Now</h1><p>Your little apps, ready when you are.</p></header>
<label for="search">Find an app</label><input id="search" type="search" placeholder="Search your apps" autocomplete="off">
<ul>${apps
    .filter((a) => a.state === "live")
    .map(
      (a) =>
        `<li>${a.active ? `<a href="${escape(a.url)}">` : "<div>"}<h2>${escape(a.slug)}</h2><p>${escape(a.description)}</p>${a.active ? "</a>" : "<small>Not deployed yet</small></div>"}</li>`,
    )
    .join("")}</ul>
<p id="empty"${apps.some((a) => a.state === "live") ? " hidden" : ""}>No apps here yet. Ask your assistant to make one.</p>
<script>const input=document.getElementById('search'),items=[...document.querySelectorAll('li')];input.addEventListener('input',()=>{for(const item of items)item.hidden=!item.textContent.toLowerCase().includes(input.value.toLowerCase());document.getElementById('empty').hidden=items.some(item=>!item.hidden);});</script></html>`;
}
