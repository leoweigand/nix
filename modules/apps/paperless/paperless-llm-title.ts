import { restrictedFetch } from "../../runtime/network.ts";
import { readFile } from "node:fs/promises";

const automationFetch = restrictedFetch([
  "http://127.0.0.1:28981",
  "https://api.openai.com",
]);

/** Post-consume hook for Paperless: extracts a better title via OpenAI.
 *
 * Runs once per consumed document. Skips if the current title looks
 * user-provided. Failures are logged but never block the consumption pipeline.
 */

type Environment = Record<string, string | undefined>;

const autoTitlePatterns = [
  /^\d{4}-\d{2}-\d{2}[_ -]?scan/i,
  /\bscan[_ -]/i,
  /^(IMG|DOC|PDF|SCAN)[_-]\d+/i,
  /quickscan/i,
  /camscanner/i,
  /adobe[_ -]?scan/i,
];

const prompt = [
  "You extract titles for archived documents. Read the OCR text below and return a single concise title.",
  "",
  "Rules:",
  "- Prefer the document's own subject line if it has one (e.g. 'Rechnung Nr. 12345', 'Mietvertrag', 'Kündigungsbestätigung').",
  "- If the subject is too generic on its own (e.g. just 'Rechnung' or 'Invoice'), add the issuing organization and/or month/year for context.",
  "- Match the language of the document.",
  "- Output the title only — no quotes, no preamble, no trailing period.",
  "- Maximum 80 characters.",
  "",
  "OCR TEXT:",
].join("\n");

function environment(): Environment {
  return {
    PAPERLESS_LLM_PAPERLESS_URL: process.env["PAPERLESS_LLM_PAPERLESS_URL"],
    PAPERLESS_LLM_API_USERNAME: process.env["PAPERLESS_LLM_API_USERNAME"],
    PAPERLESS_LLM_API_PASSWORD_FILE:
      process.env["PAPERLESS_LLM_API_PASSWORD_FILE"],
    PAPERLESS_LLM_OPENAI_KEY_FILE: process.env["PAPERLESS_LLM_OPENAI_KEY_FILE"],
    PAPERLESS_LLM_MODEL: process.env["PAPERLESS_LLM_MODEL"],
    DOCUMENT_ID: process.env["DOCUMENT_ID"],
  };
}

async function readSecret(
  path: string | undefined,
): Promise<string | undefined> {
  if (!path) return undefined;
  try {
    return (await readFile(path, "utf8")).trim() || undefined;
  } catch {
    return undefined;
  }
}

function log(documentId: string | undefined, message: string): void {
  console.error(`paperless-llm-title[doc=${documentId}]: ${message}`);
}

async function httpJson(request: Request): Promise<Record<string, unknown>> {
  const response = await automationFetch(request);
  if (!response.ok) {
    const body = (await response.text()).slice(0, 500);
    throw new Error(`HTTP ${response.status} from ${request.url}: ${body}`);
  }
  const value: unknown = await response.json();
  if (!isRecord(value)) {
    throw new Error(`JSON object expected from ${request.url}`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isAutoTitle(
  title: string,
  originalFilename: string | undefined,
): boolean {
  if (!title) return true;
  if (autoTitlePatterns.some((pattern) => pattern.test(title))) return true;
  if (!originalFilename) return false;
  return title.trim() === originalFilename.replace(/\.[^.]+$/, "").trim();
}

export function cleanTitle(raw: string): string {
  return raw
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .replace(/\.+$/, "")
    .trim();
}

async function getPaperlessToken(
  url: string,
  username: string,
  password: string,
): Promise<string> {
  const response = await httpJson(
    new Request(`${url}/api/token/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password }),
    }),
  );
  if (typeof response.token !== "string" || !response.token) {
    throw new Error("Paperless returned no token");
  }
  return response.token;
}

async function fetchDocument(
  url: string,
  documentId: string,
  token: string,
): Promise<Record<string, unknown>> {
  return await httpJson(
    new Request(`${url}/api/documents/${documentId}/`, {
      headers: { authorization: `Token ${token}` },
    }),
  );
}

async function patchTitle(
  url: string,
  documentId: string,
  title: string,
  token: string,
): Promise<void> {
  await httpJson(
    new Request(`${url}/api/documents/${documentId}/`, {
      method: "PATCH",
      headers: {
        authorization: `Token ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ title }),
    }),
  );
}

async function callOpenAi(
  content: string,
  apiKey: string,
  model: string,
): Promise<string> {
  const response = await httpJson(
    new Request("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: `${prompt}\n${content}` }],
        max_completion_tokens: 100,
      }),
    }),
  );
  const choice = Array.isArray(response.choices)
    ? response.choices[0]
    : undefined;
  if (
    !isRecord(choice) ||
    !isRecord(choice.message) ||
    typeof choice.message.content !== "string"
  ) {
    throw new Error("OpenAI returned no title");
  }
  return choice.message.content;
}

export async function main(env = environment()): Promise<number> {
  const documentId = env.DOCUMENT_ID;
  const [paperlessPassword, openaiKey] = await Promise.all([
    readSecret(env.PAPERLESS_LLM_API_PASSWORD_FILE),
    readSecret(env.PAPERLESS_LLM_OPENAI_KEY_FILE),
  ]);
  if (!paperlessPassword || !openaiKey || !documentId) {
    log(documentId, "missing required secrets or DOCUMENT_ID; aborting");
    return 0;
  }

  const paperlessUrl =
    env.PAPERLESS_LLM_PAPERLESS_URL ?? "http://127.0.0.1:28981";
  const username = env.PAPERLESS_LLM_API_USERNAME ?? "admin";
  const model = env.PAPERLESS_LLM_MODEL ?? "gpt-5.4-nano";
  let token: string;
  try {
    token = await getPaperlessToken(paperlessUrl, username, paperlessPassword);
  } catch (error) {
    log(
      documentId,
      `failed to obtain paperless token: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
    return 0;
  }

  let document: Record<string, unknown>;
  try {
    document = await fetchDocument(paperlessUrl, documentId, token);
  } catch (error) {
    log(
      documentId,
      `failed to fetch document: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
    return 0;
  }

  const title = typeof document.title === "string" ? document.title : "";
  const original =
    typeof document.original_file_name === "string"
      ? document.original_file_name
      : typeof document.original_filename === "string"
        ? document.original_filename
        : undefined;
  const content =
    typeof document.content === "string" ? document.content.slice(0, 4000) : "";
  if (!isAutoTitle(title, original)) {
    log(documentId, `keeping user-provided title: ${JSON.stringify(title)}`);
    return 0;
  }
  if (content.trim().length < 50) {
    log(documentId, "OCR content too short, skipping");
    return 0;
  }

  let raw: string;
  try {
    raw = await callOpenAi(content, openaiKey, model);
  } catch (error) {
    log(
      documentId,
      `OpenAI call failed: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
    return 0;
  }
  const newTitle = cleanTitle(raw);
  if (!newTitle || newTitle.length > 200) {
    log(documentId, `discarding bad title from LLM: ${JSON.stringify(raw)}`);
    return 0;
  }
  try {
    await patchTitle(paperlessUrl, documentId, newTitle, token);
  } catch (error) {
    log(
      documentId,
      `failed to patch title: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
    return 0;
  }
  log(documentId, `${JSON.stringify(title)} -> ${JSON.stringify(newTitle)}`);
  return 0;
}

if (import.meta.main) process.exit(await main());
