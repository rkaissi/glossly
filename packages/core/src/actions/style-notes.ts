// Style notes for Reply: every few edited replies, one Fast call reads what the user changed
// in the model's drafts and writes up to 5 short habits ("Drops 'Hope you're well'"). The user
// sees them in Profile and can remove any; a removed note is not written again.
import { z } from 'zod';
import stylePrompt from '../../prompts/style-notes.md?raw';
import type { LlmProvider } from '../llm/types';

/** Edited replies between two runs. */
export const STYLE_NOTES_EVERY = 5;
const MAX_PAIRS = 10;
const MAX_PAIR_CHARS = 600;
const MAX_NOTES = 5;
/** A note has to show in this many pairs. */
const MIN_COUNT = 2;

export const StyleNotesSchema = z.object({
  notes: z.array(z.object({ note: z.string(), count: z.number() })),
});

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

export function buildStyleNotesPrompt(pairs: { original: string; text: string }[], removed: string[]): string {
  const parts = ['## Edited drafts (newest first)'];
  pairs.slice(0, MAX_PAIRS).forEach((p, i) => {
    parts.push(`<pair n="${i + 1}">`, '<draft>', clip(p.original, MAX_PAIR_CHARS), '</draft>', '<sent>', clip(p.text, MAX_PAIR_CHARS), '</sent>', '</pair>');
  });
  parts.push('', '## Notes the user removed', removed.length ? removed.map((r) => `- ${r}`).join('\n') : 'None.');
  return parts.join('\n');
}

/** The notes, or [] when nothing repeats. Local only refuses in the LLM layer, like every model call. */
export async function writeStyleNotes(llm: LlmProvider, pairs: { original: string; text: string }[], removed: string[], signal?: AbortSignal): Promise<string[]> {
  if (pairs.length < MIN_COUNT) return [];
  const out = await llm.structured(
    {
      role: 'fast',
      action: 'style_notes',
      instructions: stylePrompt,
      prompt: buildStyleNotesPrompt(pairs, removed),
      signal,
      temperature: 0,
      maxOutputTokens: 600,
    },
    StyleNotesSchema,
  );
  const gone = new Set(removed.map((r) => r.trim().toLowerCase()));
  return out.notes
    .filter((n) => n.count >= MIN_COUNT && n.note.trim() && !gone.has(n.note.trim().toLowerCase()))
    .slice(0, MAX_NOTES)
    .map((n) => n.note.trim());
}
