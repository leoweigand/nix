import type { Job } from "./inbox.ts";

async function bounded(response: Response, maximum: number): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Attachment response empty");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) {
        await reader.cancel();
        throw new Error("Attachment too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}
export async function stageTelegramAttachment(
  job: Job,
  token: string,
  secret: string,
  request = fetch,
): Promise<string> {
  if (!job.attachment || job.chatId !== job.senderId)
    throw new Error("Private attachment required");
  const download = await request(
    "http://127.0.0.1:9087/v1/assistant-attachments",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-assistant-secret": secret,
      },
      body: JSON.stringify({ fileId: job.attachment.fileId }),
      redirect: "error",
      signal: AbortSignal.timeout(45000),
    },
  );
  if (!download.ok) {
    await download.body?.cancel();
    throw new Error("Attachment download failed");
  }
  const bytes = await bounded(download, 20 * 1024 * 1024);
  const staged = await request("https://mcp.leolab.party/attachments", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/octet-stream",
      "x-document-filename": encodeURIComponent(job.attachment.filename),
    },
    body: new Uint8Array(bytes).buffer,
    redirect: "error",
    signal: AbortSignal.timeout(45000),
  });
  if (!staged.ok) {
    await staged.body?.cancel();
    throw new Error("Attachment staging failed");
  }
  const result = JSON.parse((await bounded(staged, 8192)).toString("utf8"));
  if (
    typeof result.attachmentId !== "string" ||
    !/^[a-f0-9-]{36}$/.test(result.attachmentId)
  )
    throw new Error("Invalid attachment reference");
  return result.attachmentId;
}
