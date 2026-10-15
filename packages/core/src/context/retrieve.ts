// What Ask and Reply get from the user's saved data (decision 77): the saved notes, people,
// tasks, and events closest to the conversation. Local: exact matches from the database, days
// named in the text, then meaning from the local embedding model. No provider calls.
import type { CalendarEvent } from '../calendar/types';
import type { Embedder } from '../embed/types';
import { canonicalize } from '../people/names';
import type { Relationship } from '../people/relationship';
import type { CommitmentView } from '../people/types';
import { containsTerm, recall } from '../recall/recall';
import type { RecallHit } from '../recall/types';
import type { Settings } from '../settings';
import type { CalendarRepo } from '../store/calendar';
import type { PeopleRepo } from '../store/people';
import type { ContextKind, Store } from '../store/store';
import { namedDays } from './days';

export interface RetrieveDeps {
  store: Store;
  people: PeopleRepo;
  calendar: CalendarRepo;
  /** Null until the local model is loaded; only exact matches and named days then. */
  embedder: () => Embedder | null;
  settings: () => Pick<Settings, 'recall' | 'context'>;
  /** Brings the vectors up to date first (`EmbedHost.syncContext`); left out in tests. */
  sync?: () => Promise<unknown>;
}

export interface ContextQuery {
  /** What to find matches for, most important first: the question, the selection, the message answered. */
  texts: string[];
  /** People already known to be in it (the resolved author, known people in the selection). */
  personIds?: string[];
  now?: Date;
}

/** Why a person, task, or event came back. */
export type ContextReason = 'given' | 'named' | 'day' | 'person' | 'similar';

export interface ContextPerson {
  id: string;
  name: string;
  relationship: Relationship | null;
  note: string | null;
  reason: ContextReason;
  similarity: number | null;
}

export interface ContextTask extends CommitmentView {
  reason: ContextReason;
  similarity: number | null;
}

export interface ContextEvent extends CalendarEvent {
  reason: ContextReason;
  similarity: number | null;
}

export interface RetrievedContext {
  notes: RecallHit[];
  people: ContextPerson[];
  tasks: ContextTask[];
  events: ContextEvent[];
  /** The days the texts named ("YYYY-MM-DD"). */
  days: string[];
  /** False when the embedder wasn't ready, so only exact matches and named days were used. */
  semantic: boolean;
}

const MAX_QUERY_CHARS = 2000;
/** Events this far around today come back for a person or by meaning; a named day reaches any date. */
const PAST_DAYS = 7;
const AHEAD_DAYS = 60;
/** Finished tasks stay relevant this long ("did I send it?"). */
const DONE_DAYS = 7;

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const shift = (d: Date, days: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + days);

/** Saved people whose full name or another saved name appears in the text as whole words. */
export function namedPeople(people: Pick<PeopleRepo, 'nameIndex'>, texts: string[]): string[] {
  const hay = canonicalize(texts.join('\n'));
  if (!hay) return [];
  return people
    .nameIndex()
    .filter((p) => p.names.some((n) => containsTerm(hay, n)))
    .map((p) => p.personId);
}

/** Nearest rows of one kind over every query vector, best similarity per row, above `min`. */
function nearestOf(store: Store, vectors: Float32Array[], kind: ContextKind, k: number, min: number): Map<string, number> {
  const best = new Map<string, number>();
  for (const v of vectors) {
    for (const r of store.searchContextVectors(v, kind, k)) {
      if (r.similarity >= min && r.similarity > (best.get(r.doc_id) ?? -1)) best.set(r.doc_id, r.similarity);
    }
  }
  return best;
}

const byScore = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]);

/**
 * The saved data closest to a conversation, at most `context.max*` of each kind. People: those
 * given, then those named, then by meaning. Tasks: those due on a named day, the open ones of
 * the people found, then by meaning (open, or finished in the last week). Events: those on a
 * named day, those with the people found, then by meaning (from a week back to 60 days ahead).
 * Notes: Recall over each text (entities, then meaning), the selection's own copy left out.
 */
export async function retrieveContext(deps: RetrieveDeps, q: ContextQuery): Promise<RetrievedContext> {
  const { store, people, calendar } = deps;
  const s = deps.settings().context;
  const now = q.now ?? new Date();
  const texts = q.texts.map((t) => t.trim()).filter(Boolean);
  if (deps.sync) await deps.sync();

  const embedder = deps.embedder();
  const semantic = Boolean(embedder) && store.hasVectors && texts.length > 0;
  const vectors = semantic ? await embedder!.embed(texts.map((t) => t.slice(0, MAX_QUERY_CHARS))) : [];
  const k = Math.max(s.maxPeople, s.maxTasks, s.maxEvents) * 3;

  // ---- people ----
  const found = new Map<string, { reason: ContextReason; similarity: number | null }>();
  for (const id of q.personIds ?? []) found.set(id, { reason: 'given', similarity: null });
  for (const id of namedPeople(people, texts)) if (!found.has(id)) found.set(id, { reason: 'named', similarity: null });
  const exactPeople = [...found.keys()];
  for (const [id, sim] of byScore(nearestOf(store, vectors, 'person', k, s.personSimilarity))) {
    if (!found.has(id)) found.set(id, { reason: 'similar', similarity: sim });
  }
  const contextPeople: ContextPerson[] = [];
  for (const [id, why] of found) {
    if (contextPeople.length >= s.maxPeople) break;
    const p = people.get(id);
    if (p) contextPeople.push({ id, name: p.name, relationship: p.relationship, note: p.note, ...why });
  }

  // ---- tasks ----
  const days = namedDays(texts.join('\n'), now);
  const doneSince = shift(now, -DONE_DAYS).getTime();
  const all = new Map(people.commitments().map((c) => [c.id, c]));
  // Timestamps carry their own offsets, so compare instants, not strings.
  const current = (c: CommitmentView) => c.status === 'open' || (c.completed_at !== null && new Date(c.completed_at).getTime() >= doneSince);
  const tasks: ContextTask[] = [];
  const addTask = (c: CommitmentView | undefined, reason: ContextReason, similarity: number | null) => {
    if (c && tasks.length < s.maxTasks && current(c) && !tasks.some((t) => t.id === c.id)) tasks.push({ ...c, reason, similarity });
  };
  for (const c of all.values()) if (c.due_at && days.includes(c.due_at.slice(0, 10))) addTask(c, 'day', null);
  if (exactPeople.length) for (const c of people.commitments({ personIds: exactPeople, status: 'open' })) addTask(c, 'person', null);
  for (const [id, sim] of byScore(nearestOf(store, vectors, 'task', k, s.taskSimilarity))) addTask(all.get(id), 'similar', sim);

  // ---- events ----
  const from = iso(shift(now, -PAST_DAYS));
  const to = iso(shift(now, AHEAD_DAYS));
  const events: ContextEvent[] = [];
  const addEvent = (e: CalendarEvent | null, reason: ContextReason, similarity: number | null) => {
    if (e && events.length < s.maxEvents && !events.some((x) => x.id === e.id)) events.push({ ...e, reason, similarity });
  };
  for (const d of days) for (const e of calendar.list({ from: d, to: d })) addEvent(e, 'day', null);
  for (const pid of exactPeople) for (const e of calendar.list({ from, to, personId: pid, limit: s.maxEvents })) addEvent(e, 'person', null);
  for (const [id, sim] of byScore(nearestOf(store, vectors, 'event', k, s.eventSimilarity))) {
    const e = calendar.get(id);
    const day = e?.starts_at.slice(0, 10) ?? '';
    if (e && day >= from && day <= to) addEvent(e, 'similar', sim);
  }

  // ---- notes ----
  const notes: RecallHit[] = [];
  const recallDeps = { store, embedder: deps.embedder, settings: () => ({ recall: deps.settings().recall }) };
  for (let i = 0; i < texts.length && notes.length < s.maxNotes; i++) {
    const hits = await recall(recallDeps, { text: texts[i]!, personIds: exactPeople, ...(vectors[i] && { vector: vectors[i] }) });
    for (const h of hits) if (notes.length < s.maxNotes && !notes.some((n) => n.itemId === h.itemId)) notes.push(h);
  }

  return { notes, people: contextPeople, tasks, events, days, semantic };
}
