// Recall (spec: Actions, Recall) and the search box. Local only: entity matches come from the
// database and similarity from the local embedding model, so nothing here calls a provider.
import type { Embedder } from '../embed/types';
import { canonicalize } from '../people/names';
import type { Settings } from '../settings';
import type { PeopleRepo } from '../store/people';
import type { EntityKind, Store } from '../store/store';
import type { Item } from '../types';
import type { LibraryItem, LibraryQuery, LibraryResult, RecallHit, RecallReason, SearchResults } from './types';

export interface RecallDeps {
  store: Store;
  /** Null until the local model is loaded; recall then uses entity matches only. */
  embedder: () => Embedder | null;
  settings: () => Pick<Settings, 'recall'>;
}

const MAX_QUERY_CHARS = 2000;
const MAX_HIT_CHARS = 600;
const MIN_TERM_CHARS = 3;
const SEARCH_LIMIT = 8;
const SIDE_LIMIT = 5;

type MatchKind = Extract<EntityKind, 'person' | 'company' | 'product' | 'place'>;
const REASONS: Record<MatchKind, RecallReason> = {
  person: 'same_person',
  company: 'same_company',
  product: 'same_product',
  place: 'same_place',
};
/** Ranking inside entity matches: a shared person beats a shared place. */
const KIND_ORDER: MatchKind[] = ['person', 'company', 'product', 'place'];

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const sameText = (a: string, b: string) => a.replace(/\s+/g, ' ').trim().toLowerCase() === b.replace(/\s+/g, ' ').trim().toLowerCase();
const isWordChar = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c);

/** True when `term` appears in `hay` as whole words. Both are canonical (see canonicalize). */
export function containsTerm(hay: string, term: string): boolean {
  if (term.length < MIN_TERM_CHARS) return false;
  for (let i = hay.indexOf(term); i >= 0; i = hay.indexOf(term, i + 1)) {
    if (!isWordChar(hay[i - 1]) && !isWordChar(hay[i + term.length])) return true;
  }
  return false;
}

function toHit(item: Item & { collection: string | null }, reason: RecallReason, term: string | null, similarity: number | null): RecallHit {
  return {
    itemId: item.id,
    text: clip(item.text.trim(), MAX_HIT_CHARS),
    why: item.why,
    collection: item.collection,
    source_app: item.source_app,
    window_title: item.window_title,
    created_at: item.created_at,
    reason,
    term,
    similarity,
  };
}

async function nearest(deps: RecallDeps, text: string, k: number, min: number): Promise<{ item_id: string; similarity: number }[] | null> {
  const embedder = deps.embedder();
  if (!embedder || !deps.store.hasVectors) return null;
  const [v] = await embedder.embed([text.slice(0, MAX_QUERY_CHARS)]);
  if (!v) return null;
  return deps.store.searchVectors(v, k).filter((r) => r.similarity >= min);
}

/**
 * Saved items related to a selection, at most `maxResults`: first items sharing a person,
 * company, product, or place with it, then items similar in meaning above `minSimilarity`.
 * An item with the same text as the selection (it was saved from here) is left out.
 */
export async function recall(deps: RecallDeps, input: { text: string; personIds?: string[] }): Promise<RecallHit[]> {
  const { store } = deps;
  const settings = deps.settings().recall;
  const max = settings.maxResults;
  const hay = canonicalize(input.text);
  if (!hay) return [];

  const entities = store.matchableEntities();
  const matched = new Map(entities.filter((e) => containsTerm(hay, e.canonical)).map((e) => [e.id, e]));
  // A known person named by an alias (an email or a handle) counts as the same person.
  const byId = new Map(entities.map((e) => [e.id, e]));
  for (const id of store.personEntityIds(input.personIds ?? [])) {
    const e = byId.get(id);
    if (e) matched.set(id, e);
  }

  const picked = new Map<string, { reason: RecallReason; term: string | null; similarity: number | null; rank: number }>();
  for (const link of store.itemsForEntities([...matched.keys()], max * 10)) {
    const e = matched.get(link.entity_id)!;
    const kind = e.kind as MatchKind;
    const rank = KIND_ORDER.indexOf(kind);
    const prev = picked.get(link.item_id);
    if (!prev || rank < prev.rank) picked.set(link.item_id, { reason: REASONS[kind], term: e.display, similarity: null, rank });
  }
  const entityIds = [...picked.entries()].sort((a, b) => a[1].rank - b[1].rank).map(([id]) => id);

  const similar = (await nearest(deps, input.text, max * 3, settings.minSimilarity)) ?? [];
  for (const r of similar) {
    if (!picked.has(r.item_id)) picked.set(r.item_id, { reason: 'similar_topic', term: null, similarity: r.similarity, rank: KIND_ORDER.length });
  }
  const order = [...entityIds, ...similar.map((r) => r.item_id).filter((id) => !entityIds.includes(id))];

  return store
    .itemsWithCollection(order)
    .filter((it) => !sameText(it.text, input.text))
    .slice(0, max)
    .map((it) => {
      const p = picked.get(it.id)!;
      return toHit(it, p.reason, p.term, p.similarity);
    });
}

/**
 * The search box (hotkey with nothing selected): saved items by their words, then by meaning,
 * plus people and open commitments. An empty query lists the newest saved items and the open
 * commitments.
 */
export async function search(deps: RecallDeps & { people: PeopleRepo }, query: string): Promise<SearchResults> {
  const { store, people } = deps;
  const q = query.replace(/\s+/g, ' ').trim().slice(0, 200);
  const embedderReady = Boolean(deps.embedder()) && store.hasVectors;
  const open = people.commitments({ status: 'open' });

  if (!q) {
    const items = store.itemsWithCollection(store.recentItemIds(SEARCH_LIMIT)).map((it) => toHit(it, 'text_match', null, null));
    return { query: q, items, people: [], commitments: open.slice(0, SIDE_LIMIT), semantic: embedderReady };
  }

  const exact = store.searchItemText(q, SEARCH_LIMIT);
  const similar = (await nearest(deps, q, SEARCH_LIMIT, deps.settings().recall.searchSimilarity)) ?? [];
  const sims = new Map(similar.map((r) => [r.item_id, r.similarity]));
  const ids = [...exact, ...similar.map((r) => r.item_id).filter((id) => !exact.includes(id))].slice(0, SEARCH_LIMIT);
  const items = store
    .itemsWithCollection(ids)
    .map((it) => (exact.includes(it.id) ? toHit(it, 'text_match', q, null) : toHit(it, 'similar_topic', null, sims.get(it.id) ?? null)));

  const lower = q.toLowerCase();
  const commitments = open.filter((c) => c.text.toLowerCase().includes(lower) || (c.person_name ?? '').toLowerCase().includes(lower));
  return { query: q, items, people: people.list(q).slice(0, SIDE_LIMIT), commitments: commitments.slice(0, SIDE_LIMIT), semantic: embedderReady };
}

const LIBRARY_HIT_CHARS = 1500;

/**
 * The Saved tab: with no query, the newest items (in one collection, or all); with a query,
 * items with those words first, then items close in meaning (`recall.searchSimilarity`).
 */
export async function library(deps: RecallDeps, q: LibraryQuery): Promise<LibraryResult> {
  const { store } = deps;
  const query = q.query.replace(/\s+/g, ' ').trim().slice(0, 200);
  const limit = Math.max(1, Math.min(q.limit, 500));
  const counts = store.collectionCounts();
  const col = q.collection ? store.collectionByName(q.collection) : null;
  const semantic = Boolean(deps.embedder()) && store.hasVectors;
  const base = { query, collection: col?.name ?? null, collections: counts.collections, total: counts.total, semantic };
  // A collection that doesn't exist (renamed or gone) has nothing in it.
  if (q.collection && !col) return { ...base, items: [], more: false };

  const toItem = (it: Item & { collection: string | null }, reason: RecallReason, term: string | null, similarity: number | null): LibraryItem => ({
    ...toHit(it, reason, term, similarity),
    text: clip(it.text.trim(), LIBRARY_HIT_CHARS),
    clipped: it.text.trim().length > LIBRARY_HIT_CHARS,
    kind: it.kind,
  });

  if (!query) {
    const ids = store.itemIdsPage(limit + 1, 0, col?.id);
    return { ...base, items: store.itemsWithCollection(ids.slice(0, limit)).map((it) => toItem(it, 'text_match', null, null)), more: ids.length > limit };
  }

  const exact = store.searchItemText(query, limit + 1, col?.id);
  const similar = ((await nearest(deps, query, limit * 3, deps.settings().recall.searchSimilarity)) ?? []).filter((r) => !exact.includes(r.item_id));
  const sims = new Map(similar.map((r) => [r.item_id, r.similarity]));
  const matches = store.itemsWithCollection([...exact, ...similar.map((r) => r.item_id)]).filter((it) => !col || it.collection_id === col.id);
  return {
    ...base,
    items: matches.slice(0, limit).map((it) => (sims.has(it.id) ? toItem(it, 'similar_topic', null, sims.get(it.id)!) : toItem(it, 'text_match', query, null))),
    more: matches.length > limit,
  };
}
