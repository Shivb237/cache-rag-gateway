// Turns a streaming HTTP body into text lines (used for NDJSON and SSE).
export async function* readLines(res: Response): AsyncGenerator<string> {
  if (!res.body) throw new Error("response has no body");
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) yield line;
    }
  }
  const rest = (buf + decoder.decode()).trim();
  if (rest) yield rest;
}
