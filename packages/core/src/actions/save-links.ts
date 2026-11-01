import { namedDays } from '../context/days';
import { namedPeople, type RetrieveDeps } from '../context/retrieve';
import type { DetectedPerson } from '../people/detect';
import type { ItemLinkKind } from '../types';
import { isLinkText } from './save';

/** Something the Save panel offers to link the item to (decision 84). */
export interface SaveLinkView {
  kind: ItemLinkKind;
  id: string;
  /** The person's name, the task's text, or the event's title. */
  label: string;
}

/** What the Save panel shows before saving: answered in code and local search, with no model call. */
export interface SaveOpen {
  /** What the item will be: a Link when the selection is one web address, else a Snippet. */
  kind: 'selection' | 'link';
  /** People, tasks, and events already saved, each removable before saving. */
  links: SaveLinkView[];
  /** A person the text names who isn't saved yet, for "+ Add person". */
  addPerson: string | null;
  /** True when the route found a commitment phrase or a date, for "+ Add as task or event". */
  addTask: boolean;
  /** The browser page it's saved from, when there is one (the shell fills it in). */
  page?: { url: string | null; title: string | null } | null;
}

export interface SaveOpenInput {
  text: string;
  /** The local pass of `detectPeople` over the selection. */
  detected: DetectedPerson[];
  /** The route's `contains_commitment`. */
  commitment: number;
  hasDateWord: boolean;
  now?: Date;
}

const MAX_PEOPLE = 3;
const MAX_TASKS = 2;
const MAX_EVENTS = 2;
const MAX_QUERY_CHARS = 2000;
/** Events by meaning reach this far back; a meeting from last month is rarely what a save is about. */
const PAST_DAYS = 7;
/** The route's commitment score from which Save offers to add a task or event. */
const OFFER_TASK = 0.6;

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * The Save panel's links and offers (decision 84). People: saved people named in the text (by a
 * full or saved name, or found by the local detection). Tasks: open ones close in meaning, at
 * Recall's threshold. Events: close in meaning (from a week back), or on a day the text names with
 * one of those people. A task isn't linked just for being a named person's, and nothing is linked
 * from a first name alone or a shared day alone.
 */
export async function saveOpen(deps: RetrieveDeps, input: SaveOpenInput): Promise<SaveOpen> {
  const { store, people, calendar } = deps;
  const now = input.now ?? new Date();
  const ids = [...new Set([...input.detected.map((d) => d.knownId).filter((id): id is string => Boolean(id)), ...namedPeople(people, [input.text])])];
  const links: SaveLinkView[] = [];
  for (const id of ids) {
    const p = people.get(id);
    if (p && links.length < MAX_PEOPLE) links.push({ kind: 'person', id, label: p.name });
  }
  const personIds = links.map((l) => l.id);
  const seen = new Set<string>();
  const add = (l: SaveLinkView) => {
    if (seen.has(`${l.kind}:${l.id}`)) return;
    seen.add(`${l.kind}:${l.id}`);
    links.push(l);
  };

  try {
    if (deps.sync) await deps.sync();
    const embedder = deps.embedder();
    const [v] = embedder && store.hasVectors ? await embedder.embed([input.text.slice(0, MAX_QUERY_CHARS)]) : [];
    const min = deps.settings().recall.minSimilarity;
    const from = iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() - PAST_DAYS));
    let tasks = 0;
    let events = 0;
    if (v) {
      for (const hit of store.searchContextVectors(v, 'task', 10)) {
        if (hit.similarity < min || tasks >= MAX_TASKS) break;
        const c = people.getCommitment(hit.doc_id);
        if (c?.status !== 'open') continue;
        add({ kind: 'task', id: c.id, label: c.text });
        tasks++;
      }
      for (const hit of store.searchContextVectors(v, 'event', 10)) {
        if (hit.similarity < min || events >= MAX_EVENTS) break;
        const e = calendar.get(hit.doc_id);
        if (!e || e.starts_at.slice(0, 10) < from) continue;
        add({ kind: 'event', id: e.id, label: e.title });
        events++;
      }
    }
    for (const day of personIds.length ? namedDays(input.text, now) : []) {
      for (const e of calendar.list({ from: day, to: day })) {
        if (events >= MAX_EVENTS) break;
        if (!e.people.some((p) => personIds.includes(p.id)) || seen.has(`event:${e.id}`)) continue;
        add({ kind: 'event', id: e.id, label: e.title });
        events++;
      }
    }
  } catch {
    // Search not ready: people only.
  }

  const newcomer = input.detected.find((d) => !d.knownId && d.name && (d.name.trim().includes(' ') || d.email));
  return {
    kind: isLinkText(input.text) ? 'link' : 'selection',
    links,
    addPerson: newcomer?.name?.trim() ?? null,
    addTask: input.commitment >= OFFER_TASK || input.hasDateWord,
  };
}
