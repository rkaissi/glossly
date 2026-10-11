import { z } from 'zod';
import extractPrompt from '../../prompts/extract-entities.md?raw';
import type { Embedder } from '../embed/types';
import { LlmError, type LlmProvider } from '../llm/types';
import type { Metrics } from '../metrics';
import type { Settings } from '../settings';
import type { EntityKind, Store } from '../store/store';
import type { CaptureMethod, ContainerContext, Item, SelectionPayload, Trigger } from '../types';
import { contextWindow, type ContextWindow } from './context';

export const EntityKindSchema = z.enum(['person', 'company', 'product', 'place', 'other']);

export const ExtractedEntitiesSchema = z.object({
  entities: z.array(z.object({ kind: EntityKindSchema, name: z.string().describe('The name as written, with normal capitalization.') })),
});
export type ExtractedEntities = z.infer<typeof ExtractedEntitiesSchema>;

const MAX_ENTITIES = 20;
const MAX_WHY = 500;
const MAX_EMBED_CHARS = 2000;
const MAX_EXTRACT_CHARS = 6000;
/** Extra time allowed after undoUntil, for a click that lands as the toast fades. */
const UNDO_GRACE_MS = 1500;

/** What a saved selection keeps in items.data_json. */
export interface SelectionItemData {
  excerpt: ContextWindow;
  method: CaptureMethod;
  trigger: Trigger;
  captured_at: string;
  is_editable: boolean;
}

export interface SaveInput {
  selection: SelectionPayload;
  container?: ContainerContext | null;
  /** Collection name. Created if it does not exist yet. */
  collection: string;
  why?: string | null;
  /** How the save was asked for, for metrics only. */
  via?: 'panel' | 'hotkey' | 'autosave';
}

export interface SaveResult {
  item: Item;
  /** Epoch ms. Undo works until then (plus a short grace). */
  undoUntil: number;
  /** Settles when embedding and entity extraction finish. Never rejects. */
  enriched: Promise<EnrichResult>;
}

export interface EnrichResult {
  embedded: boolean;
  entities: number;
  /** Set when entity extraction did not run because Local only was on. */
  entitiesSkipped?: 'local_only';
  /** Set when the item was undone or deleted mid-way. */
  cancelled: boolean;
}

export interface SaveServiceDeps {
  store: Store;
  llm: LlmProvider;
  /** Null until the local model is downloaded and loaded; items are embedded later. */
  embedder: () => Embedder | null;
  settings: () => Pick<Settings, 'save'>;
  metrics?: Pick<Metrics, 'record'>;
  now?: () => number;
}

function errorCode(e: unknown): string {
  if (e instanceof LlmError) return e.code;
  const name = (e as Error)?.name;
  return typeof name === 'string' && /^\w{1,40}$/.test(name) ? name : 'unknown';
}

function cleanWhy(why: string | null | undefined): string | null {
  const w = why?.replace(/\s+/g, ' ').trim();
  return w ? w.slice(0, MAX_WHY) : null;
}

export function embedText(item: Pick<Item, 'text' | 'why'>): string {
  return (item.why ? `${item.text}\n${item.why}` : item.text).slice(0, MAX_EMBED_CHARS);
}

export function formatExtractPrompt(item: Item): string {
  const data = item.data_json ? (JSON.parse(item.data_json) as Partial<SelectionItemData>) : null;
  const parts = ['<selection>', item.text.slice(0, MAX_EXTRACT_CHARS), '</selection>'];
  const ex = data?.excerpt;
  if (ex && ex.text.length > ex.selection_length) {
    parts.push('<context>', ex.text, '</context>');
  }
  return parts.join('\n');
}

/** Save: insert at once, then embed and extract entities in the background. */
export class SaveService {
  private readonly undoDeadlines = new Map<string, number>();
  private readonly running = new Map<string, { ctl: AbortController; done: Promise<EnrichResult> }>();

  constructor(private readonly deps: SaveServiceDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  save(input: SaveInput): SaveResult {
    const { store } = this.deps;
    const settings = this.deps.settings();
    const { selection } = input;
    const collection = store.collectionByName(input.collection) ?? store.createCollection(input.collection);
    const data: SelectionItemData = {
      excerpt: contextWindow(selection, input.container, settings.save.excerptChars),
      method: selection.method,
      trigger: selection.trigger,
      captured_at: selection.captured_at,
      is_editable: selection.is_editable,
    };
    const item = store.insertItem({
      collection_id: collection.id,
      kind: 'selection',
      text: selection.text,
      why: cleanWhy(input.why),
      source_app: selection.source_app || null,
      window_title: selection.window_title || null,
      data_json: JSON.stringify(data),
    });
    const undoUntil = this.now() + settings.save.undoSeconds * 1000;
    this.undoDeadlines.set(item.id, undoUntil);
    this.deps.metrics?.record('save_done', { method: selection.method, trigger: selection.trigger, has_why: Boolean(item.why), via: input.via ?? 'panel' });
    return { item, undoUntil, enriched: this.startEnrich(item) };
  }

  /**
   * Saves a note Ask wrote when the user asked it to remember something: an item of kind
   * "note", embedded and enriched like any save, with the same undo window.
   */
  saveNote(input: { text: string; collection: string; selection: SelectionPayload | null }): SaveResult {
    const { store } = this.deps;
    const settings = this.deps.settings();
    const collection = store.collectionByName(input.collection) ?? store.createCollection(input.collection);
    const sel = input.selection;
    const item = store.insertItem({
      collection_id: collection.id,
      kind: 'note',
      text: input.text,
      why: null,
      source_app: sel?.source_app || null,
      window_title: sel?.window_title || null,
      data_json: JSON.stringify({ via: 'ask', captured_at: sel?.captured_at ?? null }),
    });
    const undoUntil = this.now() + settings.save.undoSeconds * 1000;
    this.undoDeadlines.set(item.id, undoUntil);
    this.deps.metrics?.record('save_done', { via: 'ask', has_why: false });
    return { item, undoUntil, enriched: this.startEnrich(item) };
  }

  /**
   * Visualize's Save: the table and its chart as an item of kind "chart". The text is the
   * table as CSV, so search and Recall can find it; the rows and spec go in data_json.
   */
  saveChart(input: { csv: string; data: Record<string, unknown>; collection: string; selection: SelectionPayload }): SaveResult {
    const { store } = this.deps;
    const settings = this.deps.settings();
    const collection = store.collectionByName(input.collection) ?? store.createCollection(input.collection);
    const item = store.insertItem({
      collection_id: collection.id,
      kind: 'chart',
      text: input.csv,
      why: null,
      source_app: input.selection.source_app || null,
      window_title: input.selection.window_title || null,
      data_json: JSON.stringify(input.data),
    });
    const undoUntil = this.now() + settings.save.undoSeconds * 1000;
    this.undoDeadlines.set(item.id, undoUntil);
    this.deps.metrics?.record('save_done', { via: 'visualize', has_why: false });
    return { item, undoUntil, enriched: this.startEnrich(item) };
  }

  /** Moves a saved item to another collection (created if needed). Returns the collection's name, or null if the item is gone. */
  move(itemId: string, collection: string): string | null {
    const { store } = this.deps;
    if (!store.getItem(itemId)) return null;
    const c = store.collectionByName(collection) ?? store.createCollection(collection);
    store.setItemCollection(itemId, c.id);
    return c.name;
  }

  /** Deletes a saved item for good (the Saved tab, after a confirm), stopping its enrichment first so nothing lands after. */
  remove(itemId: string): boolean {
    this.undoDeadlines.delete(itemId);
    this.running.get(itemId)?.ctl.abort();
    const deleted = this.deps.store.deleteItem(itemId);
    if (deleted) this.deps.metrics?.record('item_deleted');
    return deleted;
  }

  /** Deletes the item if still inside the undo window. Returns whether it was undone. */
  undo(itemId: string): boolean {
    const until = this.undoDeadlines.get(itemId);
    if (until === undefined) return false;
    this.undoDeadlines.delete(itemId);
    if (this.now() > until + UNDO_GRACE_MS) return false;
    this.running.get(itemId)?.ctl.abort();
    const deleted = this.deps.store.deleteItem(itemId);
    if (deleted) this.deps.metrics?.record('save_undone');
    return deleted;
  }

  /** Sets or clears the "why I saved this" note, then re-embeds so recall sees it. */
  async setWhy(itemId: string, why: string | null): Promise<boolean> {
    const { store } = this.deps;
    if (!store.getItem(itemId)) return false;
    store.updateItemWhy(itemId, cleanWhy(why));
    await this.running.get(itemId)?.done;
    const item = store.getItem(itemId);
    if (!item) return false;
    try {
      await this.embed(item);
    } catch (e) {
      this.deps.metrics?.record('save_enrich_error', { stage: 'embed', code: errorCode(e) });
    }
    return true;
  }

  /** Waits for every background enrichment to settle. For shutdown and tests. */
  async idle(): Promise<void> {
    await Promise.all([...this.running.values()].map((r) => r.done));
  }

  private startEnrich(item: Item): Promise<EnrichResult> {
    const ctl = new AbortController();
    const done = this.enrich(item, ctl.signal).finally(() => {
      if (this.running.get(item.id)?.ctl === ctl) this.running.delete(item.id);
    });
    this.running.set(item.id, { ctl, done });
    return done;
  }

  /** Embeds the item and extracts, upserts, and links its entities. Errors are logged without text. */
  async enrich(item: Item, signal?: AbortSignal): Promise<EnrichResult> {
    const result: EnrichResult = { embedded: false, entities: 0, cancelled: false };
    const alive = () => !signal?.aborted && this.deps.store.getItem(item.id) !== null;

    try {
      result.embedded = await this.embed(item, alive);
    } catch (e) {
      this.deps.metrics?.record('save_enrich_error', { stage: 'embed', code: errorCode(e) });
    }
    if (!alive()) return { ...result, cancelled: true };

    if (this.deps.llm.hasModel('fast')) {
      try {
        result.entities = await this.extractEntities(item, signal, alive);
      } catch (e) {
        if (!alive()) return { ...result, cancelled: true };
        // Local only: the item stays saved and embedded, just without entities.
        if (e instanceof LlmError && e.code === 'local_only') result.entitiesSkipped = 'local_only';
        else this.deps.metrics?.record('save_enrich_error', { stage: 'entities', code: errorCode(e) });
      }
    }
    return { ...result, cancelled: !alive() };
  }

  private async embed(item: Item, alive: () => boolean = () => true): Promise<boolean> {
    const embedder = this.deps.embedder();
    if (!embedder || !this.deps.store.hasVectors) return false;
    const [v] = await embedder.embed([embedText(item)]);
    // The store is synchronous, so nothing can delete the item between this check and the write.
    if (!v || !alive()) return false;
    this.deps.store.setVector(item.id, v);
    return true;
  }

  private async extractEntities(item: Item, signal: AbortSignal | undefined, alive: () => boolean): Promise<number> {
    const { store, llm } = this.deps;
    const out = await llm.structured(
      {
        role: 'fast',
        action: 'save_entities',
        instructions: extractPrompt,
        prompt: formatExtractPrompt(item),
        signal,
        temperature: 0,
        maxOutputTokens: 600,
      },
      ExtractedEntitiesSchema,
    );
    if (!alive()) return 0;

    const seen = new Set<string>();
    const entities = out.entities
      .map((e) => ({ kind: e.kind as EntityKind, name: e.name.replace(/\s+/g, ' ').trim() }))
      .filter((e) => e.name.length >= 2 && e.name.length <= 100)
      .filter((e) => {
        const key = `${e.kind}:${e.name.toLowerCase()}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, MAX_ENTITIES);

    return store.tx(() => {
      const linked = new Set<string>();
      for (const e of entities) {
        let entityId: string | null = null;
        if (e.kind === 'person') {
          const person = store.findPersonByName(e.name);
          if (person?.entity_id) entityId = person.entity_id;
          else if (person) {
            entityId = store.upsertEntity('person', e.name);
            store.setPersonEntity(person.id, entityId);
          }
        }
        entityId ??= store.upsertEntity(e.kind, e.name);
        store.linkItemEntity(item.id, entityId);
        linked.add(entityId);
      }
      return linked.size;
    });
  }
}
