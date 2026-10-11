// Style notes for Reply: every few edited replies, one Fast call reads what the user changed
// in the model's drafts and writes up to 5 short habits ("Drops 'Hope you're well'"). Code
// measures each edit first (length, capitalization, punctuation, ...) and gives the model
// those numbers next to the text, and code checks the answer: every note has to name at least
// two real pairs. The user sees the notes in Profile and can remove any; a removed note is not
// written again.
import { z } from 'zod';
import stylePrompt from '../../prompts/style-notes.md?raw';
import type { LlmProvider } from '../llm/types';
import { measuredChanges } from '../people/reply-style';

/** Edited replies between two runs. */
export const STYLE_NOTES_EVERY = 5;
const MAX_PAIRS = 10;
const MAX_PAIR_CHARS = 600;
const MAX_NOTES = 5;
/** At most this many notes about one aspect, so five punctuation notes can't crowd out the rest. */
const MAX_PER_ASPECT = 2;
/** A note has to show in this many pairs. */
const MIN_COUNT = 2;
const MAX_NOTE_CHARS = 120;

/** What a note is about. The prompt lists the same aspects; keep them in sync. */
export const STYLE_ASPECTS = [
  'length',
  'greeting',
  'signoff',
  'capitalization',
  'punctuation',
  'formality',
  'sentiment',
  'word_choice',
  'emoji',
  'structure',
] as const;

export const StyleNotesSchema = z.object({
  notes: z
    .array(
      z.object({
        aspect: z.enum(STYLE_ASPECTS),
        note: z.string().describe('One short phrase about a habit, at most 12 words.'),
        pairs: z.array(z.number().int()).describe('The n of every pair that shows this habit.'),
      }),
    )
    .describe('At most 5 notes. Empty when nothing repeats.'),
});

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

export function buildStyleNotesPrompt(pairs: { original: string; text: string }[], removed: string[]): string {
  const parts = ['## Edited drafts (newest first)'];
  pairs.slice(0, MAX_PAIRS).forEach((p, i) => {
    parts.push(
      `<pair n="${i + 1}">`,
      '<draft>',
      clip(p.original, MAX_PAIR_CHARS),
      '</draft>',
      '<sent>',
      clip(p.text, MAX_PAIR_CHARS),
      '</sent>',
      `<measured>${measuredChanges(p.original, p.text).join('; ')}</measured>`,
      '</pair>',
    );
  });
  parts.push('', '## Notes the user removed', removed.length ? removed.map((r) => `- ${r}`).join('\n') : 'None.');
  return parts.join('\n');
}

/**
 * The notes the answer supports: at least MIN_COUNT distinct pairs that exist, not one the user
 * removed, no repeats, at most MAX_PER_ASPECT per aspect and MAX_NOTES in all. Pure, so it is tested.
 */
export function acceptStyleNotes(out: z.infer<typeof StyleNotesSchema>, pairCount: number, removed: string[]): string[] {
  const norm = (s: string) => s.trim().toLowerCase().replace(/[.!]+$/, '');
  const gone = new Set(removed.map(norm));
  const seen = new Set<string>();
  const perAspect = new Map<string, number>();
  const kept: string[] = [];
  for (const n of out.notes) {
    const text = n.note.trim().replace(/\s+/g, ' ');
    const pairs = new Set(n.pairs.filter((p) => Number.isInteger(p) && p >= 1 && p <= pairCount));
    if (!text || text.length > MAX_NOTE_CHARS || pairs.size < MIN_COUNT) continue;
    if (gone.has(norm(text)) || seen.has(norm(text))) continue;
    if ((perAspect.get(n.aspect) ?? 0) >= MAX_PER_ASPECT) continue;
    seen.add(norm(text));
    perAspect.set(n.aspect, (perAspect.get(n.aspect) ?? 0) + 1);
    kept.push(text);
    if (kept.length >= MAX_NOTES) break;
  }
  return kept;
}

/** The notes, or [] when nothing repeats. Local only refuses in the LLM layer, like every model call. */
export async function writeStyleNotes(llm: LlmProvider, pairs: { original: string; text: string }[], removed: string[], signal?: AbortSignal): Promise<string[]> {
  if (pairs.length < MIN_COUNT) return [];
  const used = pairs.slice(0, MAX_PAIRS);
  const out = await llm.structured(
    {
      role: 'fast',
      action: 'style_notes',
      instructions: stylePrompt,
      prompt: buildStyleNotesPrompt(used, removed),
      signal,
      temperature: 0,
      maxOutputTokens: 800,
    },
    StyleNotesSchema,
  );
  return acceptStyleNotes(out, used.length, removed);
}
