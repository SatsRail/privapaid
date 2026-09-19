/** Read SSE frames across arbitrary network chunks, including CRLF and UTF-8 splits. */
export async function readImportStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onEvent: (event: string, data: Record<string, unknown>) => void
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "";
  let data: string[] = [];
  let terminal = false;

  function line(value: string) {
    if (value === "") {
      if (event && data.length) {
        const parsed = JSON.parse(data.join("\n"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("Invalid import progress response.");
        }
        onEvent(event, parsed);
        if (event === "complete" || event === "error") terminal = true;
      }
      event = "";
      data = [];
    } else if (value.startsWith("event:")) {
      event = value.slice(6).trimStart();
    } else if (value.startsWith("data:")) {
      data.push(value.slice(5).replace(/^ /, ""));
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        line(buffer.slice(0, newline).replace(/\r$/, ""));
        buffer = buffer.slice(newline + 1);
      }
      if (done) break;
    }
    if (!terminal) {
      throw new Error("Import connection ended before confirmation. Some items may have been saved. Check the content list before retrying.");
    }
  } finally {
    reader.releaseLock();
  }
}

export function importResponseError(body: { error?: string; issues?: { path: string; message: string }[] }): string {
  const details = body.issues?.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
  return details || body.error || "Import failed";
}
