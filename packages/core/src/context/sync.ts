// Keeps context_vectors in step with people, tasks, and events (decision 77). Triggers count every
// write to their tables (context_clock, migration 10), so a sync with nothing new is one read.
// Otherwise it rebuilds each row's text, embeds the ones whose hash changed, and drops the ones
// that are gone (about 20 ms for 1,700 rows with nothing to embed). It runs when the embedder is
// ready, and before each retrieval.
import type { Embedder } from '../embed/types';
import type { Store } from '../store/store';
import { contextDocs, docHash, type ContextDoc } from './docs';

export interface ContextSyncDeps {
  store: Store;
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
  // Nothing written since the last finished sync: one read instead of rebuilding every text.
  const clock = store.contextClock();
  if (store.contextSyncedAt() === clock) return { embedded: 0, removed: 0 };

  const stored = store.contextHashes();
  const docs = contextDocs(store);
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
  // The clock as read before the texts: writes made while embedding get the next sync.
  store.setContextSyncedAt(clock);
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
