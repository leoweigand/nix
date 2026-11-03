import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const source = new URL(
  "node_modules/eve/dist/src/compiled/@workflow/world-local/index.js",
  root,
);
const version = JSON.parse(
  readFileSync(new URL("node_modules/eve/package.json", root), "utf8"),
).version;
if (version !== "1.0.0-rc.2")
  throw new Error(`Review the local-world recovery patch for Eve ${version}`);
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
// The adapter preserves deliveryId, a supported runtime field omitted from
// this release's public SessionSendOptions type. Fail closed if that code changes.
if (
  digest(
    readFileSync(
      new URL("node_modules/eve/dist/src/channel/session.js", root),
      "utf8",
    ),
  ) !== "5562e7e7eac3f3be03da9dca780dab330540fc0e58f841667b677b37445027c3"
)
  throw new Error(
    "Review Eve's stable delivery identity support before upgrading",
  );
let code = readFileSync(source, "utf8");
const original =
  "595cac0e86a3e0ac7462393a514b3c8d08ffa7ee2da50a8629a3621c37327f99";
const patched =
  "caaff29bcdbbcd367652e7b4b7844d6299414d4b9e71381137b323dfa0a24423";
if (digest(code) !== patched) {
  if (digest(code) !== original)
    throw new Error("Unexpected bundled local-world source; refusing to patch");
  const replace = (before: string, after: string) => {
    if (code.split(before).length !== 2)
      throw new Error("Local-world patch anchor is missing or ambiguous");
    code = code.replace(before, after);
  };
  code = `import {claimTerminal as leolabClaim, finishTerminal as leolabFinish, recoverTerminals as leolabRecover, recoverRunTerminals as leolabRecoverRuns} from "./leolab-terminal-journal.mjs";\n${code}`;
  for (const [type, status, field, value] of [
    ["step_completed", "completed", "output", "result"],
    ["step_failed", "failed", "error", "error"],
  ]) {
    const before = `else if(i.eventType===\`${type}\`&&\`eventData\`in i){let n=i.eventData;if(E){let r=\`${"${m}-${i.correlationId}"}\`;if(!await Q(H(e,\`.locks\`,\`steps\`,t?\`${"${r}.terminal.${t}"}\`:\`${"${r}.terminal"}\`),\`\`))throw new A(\`Cannot modify step in terminal state\`);M={...E,status:\`${status}\`,${field}:n.${value},completedAt:u,updatedAt:u},await Y(W(e,G(\`steps\`,m),r,t),M,{overwrite:!0})}}`;
    const after = `else if(i.eventType===\`${type}\`&&\`eventData\`in i){let n=i.eventData;if(E){let r=\`${"${m}-${i.correlationId}"}\`;M={...E,status:\`${status}\`,${field}:n.${value},completedAt:u,updatedAt:u};if(!await leolabClaim(H(e,\`.locks\`,\`steps\`,t?\`${"${r}.terminal.${t}"}\`:\`${"${r}.terminal"}\`),JSON.stringify({version:1,step:M,event:O},J)))throw new A(\`Cannot modify step in terminal state\`);await Y(W(e,G(\`steps\`,m),r,t),M,{overwrite:!0})}}`;
    replace(before, after);
  }
  replace(
    "if(g(i.eventType)&&b){await Q(cn(e,m,t),``),await fn(e,m,t);",
    "if(g(i.eventType)&&b){if(!await leolabClaim(cn(e,m,t),JSON.stringify({version:1,previousRun:b,event:O},J)))throw new A(`Run terminal transition already claimed`);await fn(e,m,t);",
  );
  replace(
    "j&&(await xi(e,m,t),d(m));let Fe=",
    "j&&(await xi(e,m,t),d(m)),g(i.eventType)&&k&&await leolabFinish(cn(e,m,t),W(e,`runs`,m,t),F);let Fe=",
  );
  replace(
    "ce(O,F,I),i.eventType===`hook_received`",
    "ce(O,F,I),M&&[`step_completed`,`step_failed`].includes(i.eventType)&&await leolabFinish(H(e,`.locks`,`steps`,t?`${m}-${i.correlationId}.terminal.${t}`:`${m}-${i.correlationId}.terminal`),W(e,G(`steps`,m),`${m}-${i.correlationId}`,t),F),i.eventType===`hook_received`",
  );
  replace(
    "return{...j,create:Ie,list:Le}}function ta(e)",
    `return{...j,create:Ie,list:Le,recoverTerminalSteps:()=>leolabRecover(e,t,{
parse:contents=>JSON.parse(contents,Pt),
readStep:(run,step)=>K(e,G(\`steps\`,run),\`\${run}-\${step}\`,Ce,t),
readRun:run=>K(e,\`runs\`,run,y,t),
findEvent:async(run,step)=>(await j.listByCorrelationId({runId:run,correlationId:step})).data.find(event=>[\`step_completed\`,\`step_failed\`].includes(event.eventType)),
writeStep:async step=>{let path=W(e,G(\`steps\`,step.runId),\`\${step.runId}-\${step.stepId}\`,t);await Y(path,step,{overwrite:!0});return path},
appendEvent:event=>le(event),
eventPath:event=>W(e,G(\`events\`,event.runId),\`\${event.runId}-\${event.eventId}\`,t)
}),recoverRunTerminals:()=>leolabRecoverRuns(e,t,{
parse:contents=>JSON.parse(contents,Pt),
readRun:run=>K(e,\`runs\`,run,y,t),
findRunEvent:async run=>(await Gt({directory:z.join(e,G(\`events\`,run)),schema:$,filePrefix:\`\${run}-\`,filter:event=>g(event.eventType),limit:1,getCreatedAt:wn(\`evnt\`),getId:event=>event.eventId})).data[0],
writeRun:async record=>{let run=record.previousRun,event=record.event;await fn(e,run.runId,t);let result=await Xi(e,run.runId,t,{...run,status:event.eventType.slice(4),output:event.eventData?.output,error:event.eventData?.error,errorCode:event.eventData?.errorCode,completedAt:event.createdAt,updatedAt:event.createdAt});await ni(e,run.runId);await Yi(e,run.runId);return{checkpoint:W(e,\`runs\`,run.runId,t),purged:result.purged}},
appendRunEvent:async event=>{let key=await ie(event.runId);return le({...event,eventId:key.eventId,createdAt:key.createdAt})},
purgeRun:run=>xi(e,run,t),
eventPath:event=>W(e,G(\`events\`,event.runId),\`\${event.runId}-\${event.eventId}\`,t)
})}}function ta(e)`,
  );
  replace(
    "async start(){if(await dr(n.dataDir),!l)return;",
    "async start(){await dr(n.dataDir);await o.events.recoverTerminalSteps();await o.events.recoverRunTerminals();if(!l)return;",
  );
  if (digest(code) !== patched)
    throw new Error(
      `Unexpected recovery patch output; review its pinned hash: ${digest(code)}`,
    );
  writeFileSync(source, code);
  console.info(`Patched Eve local world: ${digest(code)}`);
}
copyFileSync(
  new URL("patches/eve-terminal-journal.mjs", root),
  new URL("leolab-terminal-journal.mjs", source),
);
