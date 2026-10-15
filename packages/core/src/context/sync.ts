// Keeps context_vectors in step with people, tasks, and events (decision 77). Rather than every
// write marking rows dirty, a sync rebuilds each row's text, embeds the ones whose hash changed,
// and drops the ones that are gone; at one person's scale (hundreds of rows) that is a few queries
// and hashes when nothing changed. It runs when the embedder is ready, and before each retrieval.
import type { Embedder } from '../embed/types';
import type { CalendarRepo } from '../store/calendar';
import type { PeopleRepo } from '../store/people';
import type { Store } from '../store/store';
import { contextDocs, docHash, type ContextDoc } from './docs';

export interface ContextSyncDeps {
  store: Store;
  people: PeopleRepo;
  calendar: CalendarRepo;
  embedder: () => Embedder | null;
}

export interface ContextSyncResult {
  embedded: number;
  removed: number;
}

const BATCH = 16;

/** Embeds what changed since the last sync and removes what was deleted. Null without vectors or the embedder. */
export async function syncContext(deps: ContextSyncDeps): Promise<ContextSyncResult | null> {
  const { store } = deps;
  const embedder = deps.embedder();
  if (!embedder || !store.hasVectors) return null;

  const stored = store.contextHashes();
  const docs = contextDocs(deps.people, deps.calendar);
  const live = new Set(docs.map((d) => d.id));
  const gone = [...stored.keys()].filter((id) => !live.has(id));
  store.deleteContextDocs(gone);

  const changed: { doc: ContextDoc; hash: string }[] = [];
  for (const doc of docs) {
    const hash = docHash(doc);
    const prev = stored.get(doc.id);
    if (!prev || prev.hash !== hash || prev.kind !== doc.kind) changed.push({ doc, hash });
  }
  for (let i = 0; i < changed.length; i += BATCH) {
    const batch = changed.slice(i, i + BATCH);
    const vectors = await embedder.embed(batch.map((c) => c.doc.text));
    batch.forEach((c, j) => {
      const v = vectors[j];
      if (v) store.setContextVector(c.doc.id, c.doc.kind, c.hash, v);
    });
  }
  return { embedded: changed.length, removed: gone.length };
}

/**
 * One sync at a time: a call while one runs waits for it and then runs once more (the data may
 * have changed meanwhile), and calls that pile up share that one run.
 */
export class ContextSyncer {
  private running: Promise<ContextSyncResult | null> | null = null;
  private queued: Promise<ContextSyncResult | null> | null = null;

  constructor(private readonly deps: ContextSyncDeps) {}

  sync(): Promise<ContextSyncResult | null> {
    if (!this.running) return this.start();
    this.queued ??= this.running.catch(() => null).then(() => {
      this.queued = null;
      return this.start();
    });
    return this.queued;
  }

  private start(): Promise<ContextSyncResult | null> {
    const run = syncContext(this.deps).finally(() => {
      if (this.running === run) this.running = null;
    });
    this.running = run;
    return run;
  }
}
