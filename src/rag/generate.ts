import type { ChatMessage } from "../providers/index.js";
import type { Paragraph } from "./squad.js";

// Layout matters for prefix caching later (Milestone 6): the fixed instructions come first,
// then the passages, then the question last. Text that never changes sits at the front.
export const SYSTEM_PROMPT =
  "You answer questions using only the numbered passages. " +
  "Reply with the shortest exact answer, a few words, no explanation. " +
  "If the passages do not contain the answer, reply: I don't know.";

// `nonce` puts a unique word at the very start of the prompt. A prefix cache can then never match an
// earlier request, which gives a "prefix caching off" control arm for experiments.
// `cacheMarkers` is for providers with explicit prompt caching: the breakpoint goes after the passages, so the
// fixed instruction + passage block is the cached prefix and only the question varies.
export function buildMessages(question: string, passages: Paragraph[], opts: { nonce?: string; cacheMarkers?: boolean } = {}): ChatMessage[] {
  const context = passages.map((p, i) => `[${i + 1}] ${p.text}`).join("\n\n");
  return [
    { role: "system", content: opts.nonce ? `[session ${opts.nonce}] ${SYSTEM_PROMPT}` : SYSTEM_PROMPT },
    {
      role: "user",
      content: `${context}\n\nQuestion: ${question}`,
      ...(opts.cacheMarkers && { parts: [{ text: `${context}\n\n`, cache: true }, { text: `Question: ${question}` }] }),
    },
  ];
}
