// Style notes for Reply: every few edited replies, one Fast call reads what the user changed
// in the model's drafts and writes up to 5 short habits ("Drops 'Hope you're well'"), each for
// one kind of platform or everywhere. Code measures each edit first (length, capitalization,
// punctuation, ...) and gives the model those numbers next to the text, with the preferences
// the user's picks show (counted in code) and the current notes. The model judges what the
// changes mean (formality, slang, "im" for "I'm") and may answer that nothing changed. Code
// checks the answer: a new note has to name at least two real pairs, from its platform when it
// has one (decision 49). The user sees the notes in Profile and can remove any; a removed note
// is not written again.
import { z } from 'zod';
import stylePrompt from '../../prompts/style-notes.md?raw';
import type { LlmProvider } from '../llm/types';
import { measuredChanges, REPLY_CHANNELS, type ReplyChannel } from '../people/reply-style';

/** Edited replies between two runs. */
export const STYLE_NOTES_EVERY = 5;
const MAX_PAIRS = 12;
const MAX_PAIR_CHARS = 600;
const MAX_NOTES = 5;
/** At most this many notes about one aspect, so five punctuation notes can't crowd out the rest. */
const MAX_PER_ASPECT = 2;
/** A new note has to show in this many pairs. */
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

/** Where a note holds: everywhere, or one kind of platform. */
export const NOTE_PLACES = ['everywhere', ...REPLY_CHANNELS] as const;

export const StyleNotesSchema = z.object({
  keep: z.boolean().describe('True when the current notes still hold and no new habit repeats: nothing changes.'),
  notes: z
    .array(
      z.object({
        aspect: z.enum(STYLE_ASPECTS),
        note: z.string().describe('One short phrase about a habit, at most 12 words.'),
        where: z.enum(NOTE_PLACES).describe('The kind of platform it holds for, or everywhere.'),
        pairs: z.array(z.number().int()).describe('The n of every pair that shows this habit.'),
      }),
    )
    .describe('When keep is false: the full new list, at most 5. Empty when keep is true.'),
});

export interface EditedPair {
  original: string;
  text: string;
  channel: ReplyChannel | null;
}

export interface StyleNoteDraft {
  text: string;
  channel: ReplyChannel | null;
}

/** What the user's picks show, per kind of platform: `preferenceLine`s counted in code. */
export type PickLines = Partial<Record<ReplyChannel, string[]>>;

const CHANNEL_TITLES: Record<ReplyChannel, string> = { messaging: 'Messaging apps', work_chat: 'Work chat', email: 'Email', other: 'Other apps' };
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const placeOf = (c: ReplyChannel | null) => c ?? 'everywhere';
const norm = (s: string) => s.trim().toLowerCase().replace(/[.!]+$/, '');

/** Pairs grouped by kind of platform, numbered in that order; the numbers are what notes cite. */
function grouped(pairs: EditedPair[]): { n: number; pair: EditedPair }[] {
  const used = pairs.slice(0, MAX_PAIRS);
  const order: (ReplyChannel | null)[] = [...REPLY_CHANNELS, null];
  let n = 0;
  return order.flatMap((c) => used.filter((p) => p.channel === c).map((pair) => ({ n: ++n, pair })));
}

export function buildStyleNotesPrompt(pairs: EditedPair[], current: StyleNoteDraft[], picks: PickLines, removed: string[]): string {
  const parts = ['## Current notes', ...(current.length ? current.map((c) => `- [${placeOf(c.channel)}] ${c.text}`) : ['None yet.']), ''];
  let place: ReplyChannel | null | undefined;
  for (const { n, pair } of grouped(pairs)) {
    if (pair.channel !== place) {
      place = pair.channel;
      parts.push(`## Edited drafts: ${pair.channel ? CHANNEL_TITLES[pair.channel] : 'Unknown platform'}`);
    }
    parts.push(
      `<pair n="${n}">`,
      '<draft>',
      clip(pair.original, MAX_PAIR_CHARS),
      '</draft>',
      '<sent>',
      clip(pair.text, MAX_PAIR_CHARS),
      '</sent>',
      `<measured>${measuredChanges(pair.original, pair.text).join('; ')}</measured>`,
      '</pair>',
    );
  }
  const pickParts = REPLY_CHANNELS.flatMap((c) => (picks[c]?.length ? [`${CHANNEL_TITLES[c]}:`, ...picks[c]!.map((l) => `- ${l}`)] : []));
  parts.push('', '## What the user picks (counted in code)', ...(pickParts.length ? pickParts : ['Nothing clear yet.']));
  parts.push('', '## Notes the user removed', removed.length ? removed.map((r) => `- ${r}`).join('\n') : 'None.');
  return parts.join('\n');
}

/**
 * What the answer supports: `keep` when the model saw no change (or wrote the same notes), else
 * the new list. A current note may stay without new pairs; a new one needs at least MIN_COUNT
 * distinct pairs that exist, and, when it is for one kind of platform, from that platform. Never
 * a note the user removed, no repeats, at most MAX_PER_ASPECT per aspect and MAX_NOTES in all.
 * Pure, so it is tested.
 */
export function acceptStyleNotes(
  out: z.infer<typeof StyleNotesSchema>,
  pairs: EditedPair[],
  current: StyleNoteDraft[],
  removed: string[],
): { keep: true } | { keep: false; notes: StyleNoteDraft[] } {
  if (out.keep) return { keep: true };
  const numbered = new Map(grouped(pairs).map(({ n, pair }) => [n, pair]));
  const gone = new Set(removed.map(norm));
  const had = new Set(current.map((c) => `${placeOf(c.channel)}:${norm(c.text)}`));
  const seen = new Set<string>();
  const perAspect = new Map<string, number>();
  const kept: StyleNoteDraft[] = [];
  for (const n of out.notes) {
    const text = n.note.trim().replace(/\s+/g, ' ');
    const channel = n.where === 'everywhere' ? null : n.where;
    if (!text || text.length > MAX_NOTE_CHARS || gone.has(norm(text)) || seen.has(norm(text))) continue;
    const carried = had.has(`${n.where}:${norm(text)}`);
    const shown = new Set(n.pairs.filter((p) => numbered.has(p) && (channel === null || numbered.get(p)!.channel === channel)));
    if (!carried && shown.size < MIN_COUNT) continue;
    if ((perAspect.get(n.aspect) ?? 0) >= MAX_PER_ASPECT) continue;
    seen.add(norm(text));
    perAspect.set(n.aspect, (perAspect.get(n.aspect) ?? 0) + 1);
    kept.push({ text, channel });
    if (kept.length >= MAX_NOTES) break;
  }
  const same = kept.length === current.length && kept.every((k) => had.has(`${placeOf(k.channel)}:${norm(k.text)}`));
  return same ? { keep: true } : { keep: false, notes: kept };
}

/**
 * The notes to store, or `keep` when nothing should change (too few edits, or the model saw no
 * new habit). Local only refuses in the LLM layer, like every model call.
 */
export async function writeStyleNotes(
  llm: LlmProvider,
  input: { pairs: EditedPair[]; current: StyleNoteDraft[]; picks: PickLines; removed: string[] },
  signal?: AbortSignal,
): Promise<{ keep: true } | { keep: false; notes: StyleNoteDraft[] }> {
  if (input.pairs.length < MIN_COUNT) return { keep: true };
  const used = input.pairs.slice(0, MAX_PAIRS);
  const out = await llm.structured(
    {
      role: 'fast',
      action: 'style_notes',
      instructions: stylePrompt,
      prompt: buildStyleNotesPrompt(used, input.current, input.picks, input.removed),
      signal,
      temperature: 0,
      maxOutputTokens: 600,
    },
    StyleNotesSchema,
  );
  return acceptStyleNotes(out, used, input.current, input.removed);
}
