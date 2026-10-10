// Splits Reply's streamed text into its drafts. Pure, so it is unit-tested. The model writes
// "### Intent" then the reply, three times (prompts/reply.md); the parser also accepts other
// heading levels and bold labels, since models drift.

export interface Draft {
  intent: string;
  text: string;
}

const HEADER = /^\s*(?:#{1,4}\s+|\*\*)(.+?)(?:\*\*)?\s*:?\s*$/;
const MAX_DRAFTS = 3;

function cleanIntent(s: string): string {
  return s
    .replace(/^(?:draft|option|reply)\s*\d*\s*[:.\-–—]\s*/i, '')
    .replace(/^["'“”]|["'“”]$/g, '')
    .replace(/\*\*/g, '')
    .trim()
    .slice(0, 60);
}

/** Drafts so far; while streaming, the last one may still be growing. */
export function parseDrafts(raw: string): Draft[] {
  const drafts: Draft[] = [];
  let current: { intent: string; lines: string[] } | null = null;
  const flush = () => {
    if (current) drafts.push({ intent: current.intent, text: current.lines.join('\n').trim() });
  };
  for (const line of raw.split(/\r?\n/)) {
    // A header still arriving ("##") shouldn't flash at the end of the previous draft.
    if (/^\s*#{1,4}\s*$/.test(line)) continue;
    const h = HEADER.exec(line);
    // A bold line inside a draft is only a header when it is short, like a label.
    if (h && (line.trimStart().startsWith('#') || h[1]!.length <= 40)) {
      flush();
      if (drafts.length >= MAX_DRAFTS) return drafts;
      current = { intent: cleanIntent(h[1]!), lines: [] };
    } else if (current) current.lines.push(line);
  }
  flush();
  return drafts.slice(0, MAX_DRAFTS);
}
