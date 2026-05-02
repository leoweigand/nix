"""Post-consume hook for Paperless: extracts a better title via OpenAI.

Runs once per consumed document. Skips if the current title looks user-provided.
Failures are logged but never block the consumption pipeline.
"""

import json
import os
import re
import sys
import urllib.request
import urllib.error

PAPERLESS_URL = os.environ.get("PAPERLESS_LLM_PAPERLESS_URL", "http://127.0.0.1:28981")
PAPERLESS_USERNAME = os.environ.get("PAPERLESS_LLM_API_USERNAME", "admin")
PAPERLESS_PASSWORD_FILE = os.environ.get("PAPERLESS_LLM_API_PASSWORD_FILE")
OPENAI_KEY_FILE = os.environ.get("PAPERLESS_LLM_OPENAI_KEY_FILE")
MODEL = os.environ.get("PAPERLESS_LLM_MODEL", "gpt-5.4-nano")
DOC_ID = os.environ.get("DOCUMENT_ID")


def read_secret(path: str | None) -> str | None:
    if not path:
        return None
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        return None


# Heuristics for "this title was auto-generated and should be replaced".
# Keep conservative — anything that looks like a human chose it stays.
AUTO_TITLE_PATTERNS = [
    re.compile(r"^\d{4}-\d{2}-\d{2}[_ -]?scan", re.IGNORECASE),
    re.compile(r"\bscan[_ -]", re.IGNORECASE),
    re.compile(r"^(IMG|DOC|PDF|SCAN)[_-]\d+", re.IGNORECASE),
    re.compile(r"quickscan", re.IGNORECASE),
    re.compile(r"camscanner", re.IGNORECASE),
    re.compile(r"adobe[_ -]?scan", re.IGNORECASE),
]

PROMPT = (
    "You extract titles for archived documents. Read the OCR text below and "
    "return a single concise title.\n\n"
    "Rules:\n"
    "- Prefer the document's own subject line if it has one (e.g. 'Rechnung "
    "Nr. 12345', 'Mietvertrag', 'Kündigungsbestätigung').\n"
    "- If the subject is too generic on its own (e.g. just 'Rechnung' or "
    "'Invoice'), add the issuing organization and/or month/year for context.\n"
    "- Match the language of the document.\n"
    "- Output the title only — no quotes, no preamble, no trailing period.\n"
    "- Maximum 80 characters.\n\n"
    "OCR TEXT:\n"
)


def log(msg: str) -> None:
    print(f"paperless-llm-title[doc={DOC_ID}]: {msg}", file=sys.stderr, flush=True)


def http_json(req: urllib.request.Request) -> dict:
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        # Surface the response body so 4xx/5xx errors are debuggable in journald
        # instead of just showing the status line.
        body = e.read().decode("utf-8", errors="replace")[:500]
        raise urllib.error.URLError(f"HTTP {e.code} from {req.full_url}: {body}") from e


def is_auto_title(title: str, original_filename: str | None) -> bool:
    if not title:
        return True
    if any(p.search(title) for p in AUTO_TITLE_PATTERNS):
        return True
    # Paperless's fallback: title equals original filename minus extension.
    if original_filename:
        stem = re.sub(r"\.[^.]+$", "", original_filename)
        if title.strip() == stem.strip():
            return True
    return False


def get_paperless_token(username: str, password: str) -> str:
    req = urllib.request.Request(
        f"{PAPERLESS_URL}/api/token/",
        method="POST",
        data=json.dumps({"username": username, "password": password}).encode(),
        headers={"Content-Type": "application/json"},
    )
    return http_json(req)["token"]


def fetch_doc(doc_id: str, token: str) -> dict:
    req = urllib.request.Request(
        f"{PAPERLESS_URL}/api/documents/{doc_id}/",
        headers={"Authorization": f"Token {token}"},
    )
    return http_json(req)


def patch_title(doc_id: str, title: str, token: str) -> None:
    req = urllib.request.Request(
        f"{PAPERLESS_URL}/api/documents/{doc_id}/",
        method="PATCH",
        data=json.dumps({"title": title}).encode(),
        headers={
            "Authorization": f"Token {token}",
            "Content-Type": "application/json",
        },
    )
    http_json(req)


def call_openai(content: str, api_key: str) -> str:
    req = urllib.request.Request(
        "https://api.openai.com/v1/chat/completions",
        method="POST",
        data=json.dumps({
            "model": MODEL,
            "messages": [{"role": "user", "content": PROMPT + content}],
            # gpt-5 reasoning-family models reject `max_tokens` and `temperature`.
            "max_completion_tokens": 100,
        }).encode(),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
    )
    resp = http_json(req)
    return resp["choices"][0]["message"]["content"]


def clean_title(raw: str) -> str:
    title = raw.strip().strip('"').strip("'").strip()
    # Strip a trailing period if the model added one despite instructions.
    title = re.sub(r"\.+$", "", title)
    return title


def main() -> int:
    paperless_password = read_secret(PAPERLESS_PASSWORD_FILE)
    openai_key = read_secret(OPENAI_KEY_FILE)
    if not (paperless_password and openai_key and DOC_ID):
        log("missing required secrets or DOCUMENT_ID; aborting")
        return 0

    try:
        token = get_paperless_token(PAPERLESS_USERNAME, paperless_password)
    except urllib.error.URLError as e:
        log(f"failed to obtain paperless token: {e}")
        return 0

    try:
        doc = fetch_doc(DOC_ID, token)
    except urllib.error.URLError as e:
        log(f"failed to fetch document: {e}")
        return 0

    title = doc.get("title") or ""
    original = doc.get("original_file_name") or doc.get("original_filename")
    content = (doc.get("content") or "")[:4000]

    if not is_auto_title(title, original):
        log(f"keeping user-provided title: {title!r}")
        return 0

    if len(content.strip()) < 50:
        log("OCR content too short, skipping")
        return 0

    try:
        raw = call_openai(content, openai_key)
    except urllib.error.URLError as e:
        log(f"OpenAI call failed: {e}")
        return 0

    new_title = clean_title(raw)
    if not new_title or len(new_title) > 200:
        log(f"discarding bad title from LLM: {raw!r}")
        return 0

    try:
        patch_title(DOC_ID, new_title, token)
    except urllib.error.URLError as e:
        log(f"failed to patch title: {e}")
        return 0

    log(f"{title!r} -> {new_title!r}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
