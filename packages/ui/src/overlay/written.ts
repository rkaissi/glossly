// Write here's streamed text as it can be pasted (decision 81). The prompt is core's write.md.

/** The model's answer when nothing useful can be written; keep in sync with prompts/write.md. */
const NOTHING_TO_WRITE = '[nothing to write]';

/**
 * The text without a fence or quotes the model wrapped it in, and empty for the "nothing to
 * write" answer (also while it is still arriving, so the panel never flashes it).
 */
export function writtenText(raw: string): string {
  let t = raw.trim();
  if (NOTHING_TO_WRITE.startsWith(t) || t.startsWith(NOTHING_TO_WRITE)) return '';
  const fence = /^```[\w-]*\n([\s\S]*?)(?:\n```)?$/.exec(t);
  if (fence) t = fence[1]!.trim();
  if (t.length > 1 && /^["“]/.test(t) && /["”]$/.test(t) && !/["“”]/.test(t.slice(1, -1))) t = t.slice(1, -1).trim();
  return t;
}

/** The answer was "nothing to write" (once the stream is done). */
export const wroteNothing = (raw: string) => raw.trim().startsWith(NOTHING_TO_WRITE);
