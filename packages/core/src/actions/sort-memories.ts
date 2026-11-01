// A one-time pass that moves Ask's older memories where their subject is (decision 84, Step 28h):
// a fact about the user to Profile, a fact about a saved person to their facts, and anything else
// stays a Memory in Saved. One Fast call per batch; the shell runs it once and records that it ran.
import { z } from 'zod';
import sortPrompt from '../../prompts/sort-memories.md?raw';
import type { LlmProvider } from '../llm/types';
import type { PeopleRepo } from '../store/people';
import type { Store } from '../store/store';
import { withAboutMe } from './ask-tools';

const BATCH = 25;
const MAX_MEMORY_CHARS = 400;
const MAX_FACT = 300;
const MAX_PEOPLE = 300;

export const SortedMemoriesSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      about: z.enum(['user', 'person', 'none']),
      person: z.string().nullable(),
      fact: z.string().nullable(),
    }),
  ),
});

type AboutMe = { id: string; text: string; at: string }[];

export interface SortMemoriesDeps {
  llm: LlmProvider;
  store: Store;
  people: PeopleRepo;
  userName: string;
  aboutMe: () => AboutMe;
  setAboutMe: (next: AboutMe) => void;
  newId: () => string;
  now: () => string;
}

export interface SortMemoriesResult {
  seen: number;
  toUser: number;
  toPeople: number;
  kept: number;
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function formatSortPrompt(userName: string, people: string[], memories: { id: string; text: string }[]): string {
  return [
    `The user: ${userName.trim() || '(name not set)'}`,
    `Saved people: ${people.length ? people.join(', ') : '(none)'}`,
    '',
    '<memories>',
    ...memories.map((m) => `${m.id}: ${clip(oneLine(m.text), MAX_MEMORY_CHARS)}`),
    '</memories>',
  ].join('\n');
}

/**
 * Sorts every Memory (items of kind `note`). A memory is moved only when the model names a
 * saved person that matches exactly (or the user) and gives a fact; the fact is added first and
 * the memory deleted after, so a failure leaves it where it was. Throws when a call fails, so the
 * caller doesn't record the pass as done.
 */
export async function sortMemories(deps: SortMemoriesDeps, signal?: AbortSignal): Promise<SortMemoriesResult> {
  const { store, people, llm } = deps;
  const ids = store.libraryItemIds({ kind: 'note', personId: null, source: null }, { limit: 5000 });
  const memories = store.itemsByIds(ids).map((it) => ({ id: it.id, text: it.text }));
  const result: SortMemoriesResult = { seen: memories.length, toUser: 0, toPeople: 0, kept: 0 };
  if (memories.length === 0) return result;
  const names = people
    .list()
    .slice(0, MAX_PEOPLE)
    .map((p) => p.name);

  for (let i = 0; i < memories.length; i += BATCH) {
    const batch = memories.slice(i, i + BATCH);
    // Short ids keep the prompt small and stop the model inventing long ones.
    const short = new Map(batch.map((m, n) => [`m${n + 1}`, m]));
    const out = await llm.structured(
      {
        role: 'fast',
        action: 'sort_memories',
        instructions: sortPrompt,
        prompt: formatSortPrompt(deps.userName, names, [...short].map(([id, m]) => ({ id, text: m.text }))),
        signal,
        temperature: 0,
        maxOutputTokens: 120 * batch.length,
      },
      SortedMemoriesSchema,
    );
    const handled = new Set<string>();
    for (const r of out.items) {
      const m = short.get(r.id);
      if (!m || handled.has(r.id)) continue;
      handled.add(r.id);
      const fact = clip(oneLine(r.fact ?? ''), MAX_FACT);
      if (r.about === 'user' && fact) {
        const next = withAboutMe(deps.aboutMe(), fact, deps.newId(), deps.now());
        if (next) deps.setAboutMe(next);
        store.deleteItem(m.id);
        result.toUser++;
      } else if (r.about === 'person' && fact && r.person) {
        const personId = people.byName(r.person);
        if (personId && people.addFact(personId, fact, 'ask')) {
          store.deleteItem(m.id);
          result.toPeople++;
        } else result.kept++;
      } else result.kept++;
    }
    result.kept += batch.length - handled.size;
  }
  return result;
}
