import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { uuidv7 } from 'uuidv7';
import type { KnownPerson } from '../router/types';
import { SETTINGS_MIGRATIONS, parseSettings, type Settings, type SettingsKey } from '../settings';
import { isoNow, type Collection, type Item, type ItemLink, type ItemLinkKind, type ItemPageFields, type LinkPreview } from '../types';
import { canonicalize } from '../people/names';
import { DATA_TABLES, MIGRATIONS, USER_DATA_TABLES } from './migrations';
import type { LlmCallRow } from './llm-call-row';
import type { LibraryFilter } from '../recall/types';

export type EntityKind = 'person' | 'company' | 'product' | 'place' | 'other';

/** What context_vectors holds besides saved items (decision 77). */
export type ContextKind = 'person' | 'task' | 'event';

export interface StoredModel {
  provider: string;
  model_id: string;
  display_name: string;
  capabilities: Record<string, unknown>;
  fetched_at: string;
}

export interface EventRow {
  id: string;
  kind: string;
  payload: Record<string, unknown> | null;
  at: string;
}

export interface StoreOptions {
  /** Path to the sqlite-vec loadable extension (require('sqlite-vec').getLoadablePath()). */
  vecExtensionPath?: string;
}

const CONTEXT_SYNCED_KEY = 'context_synced_clock';

const vecBytes = (v: Float32Array | number[]) => {
  const f = v instanceof Float32Array ? v : new Float32Array(v);
  return new Uint8Array(f.buffer, f.byteOffset, f.byteLength);
};

/** The single local SQLite file. Synchronous by design; it runs in the main process. */
export class Store {
  readonly db: DatabaseSync;
  readonly hasVectors: boolean;

  constructor(path: string, opts: StoreOptions = {}) {
    this.db = new DatabaseSync(path, { allowExtension: Boolean(opts.vecExtensionPath) });
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 2000;');
    if (opts.vecExtensionPath) this.db.loadExtension(opts.vecExtensionPath);
    this.hasVectors = Boolean(opts.vecExtensionPath);
    this.migrate();
    this.migrateSettings();
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }

  private migrate(): void {
    const { user_version } = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    for (let v = user_version; v < MIGRATIONS.length; v++) {
      this.tx(() => {
        this.db.exec(MIGRATIONS[v]!);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
  }

  /** Applies each SETTINGS_MIGRATIONS entry once, to stored values only. */
  private migrateSettings(): void {
    const done = Number(this.getMeta('settings_migrations') ?? 0);
    if (done >= SETTINGS_MIGRATIONS.length) return;
    this.tx(() => {
      for (const m of SETTINGS_MIGRATIONS.slice(done)) {
        const source = m.from ?? m.key;
        const row = this.db.prepare('SELECT value_json FROM settings WHERE key = ?').get(source) as { value_json: string } | undefined;
        if (!row) continue;
        let stored: unknown;
        try {
          stored = JSON.parse(row.value_json);
        } catch {
          continue;
        }
        const next = m.migrate(stored);
        if (next !== undefined) {
          this.db
            .prepare('INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json')
            .run(m.key, JSON.stringify(next));
        }
        if (m.from) this.db.prepare('DELETE FROM settings WHERE key = ?').run(m.from);
      }
      this.setMeta('settings_migrations', String(SETTINGS_MIGRATIONS.length));
    });
  }

  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  get schemaVersion(): number {
    return (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  }

  // ---- meta ----

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  // ---- settings ----

  getSettings(): Settings {
    const rows = this.db.prepare('SELECT key, value_json FROM settings').all() as { key: string; value_json: string }[];
    const raw: Record<string, unknown> = {};
    for (const r of rows) {
      try {
        raw[r.key] = JSON.parse(r.value_json);
      } catch {
        /* a corrupt row falls back to its default */
      }
    }
    return parseSettings(raw);
  }

  setSetting<K extends SettingsKey>(key: K, value: Settings[K]): void {
    this.db
      .prepare('INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json')
      .run(key, JSON.stringify(value));
  }

  // ---- collections (none are seeded since decision 84; old ones stay until the Saved tab moves to types) ----

  listCollections(): Collection[] {
    return this.db.prepare('SELECT id, name, created_at FROM collections ORDER BY created_at, rowid').all() as unknown as Collection[];
  }

  collectionByName(name: string): Collection | null {
    return (this.db.prepare('SELECT id, name, created_at FROM collections WHERE name = ? COLLATE NOCASE').get(name) as
      | Collection
      | undefined) ?? null;
  }

  createCollection(name: string): Collection {
    const c = { id: uuidv7(), name: name.trim(), created_at: isoNow() };
    this.db.prepare('INSERT INTO collections (id, name, created_at) VALUES (?, ?, ?)').run(c.id, c.name, c.created_at);
    return c;
  }

  // ---- items ----

  insertItem(item: Omit<Item, 'id' | 'created_at' | ItemPageFields> & Partial<Pick<Item, ItemPageFields>> & { id?: string; created_at?: string }): Item {
    const row: Item = {
      ...item,
      page_url: item.page_url ?? null,
      page_title: item.page_title ?? null,
      urls_json: item.urls_json ?? null,
      preview_json: item.preview_json ?? null,
      id: item.id ?? uuidv7(),
      created_at: item.created_at ?? isoNow(),
    };
    this.db
      .prepare(
        `INSERT INTO items (id, collection_id, kind, text, why, source_app, window_title, data_json, page_url, page_title, urls_json, preview_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.collection_id,
        row.kind,
        row.text,
        row.why,
        row.source_app,
        row.window_title,
        row.data_json,
        row.page_url,
        row.page_title,
        row.urls_json,
        row.preview_json,
        row.created_at,
      );
    return row;
  }

  /** The page an item was saved from (decision 84). */
  setItemPage(id: string, page: { url: string | null; title: string | null }): void {
    this.db.prepare('UPDATE items SET page_url = ?, page_title = ? WHERE id = ?').run(page.url, page.title, id);
  }

  /** The page's preview once fetched, or null to clear it. */
  setItemPreview(id: string, preview: LinkPreview | null): void {
    this.db.prepare('UPDATE items SET preview_json = ? WHERE id = ?').run(preview ? JSON.stringify(preview) : null, id);
  }

  // ---- item links (decision 84) ----

  /** Links an item to a person, task, or event; linking twice is a no-op. */
  linkItem(itemId: string, kind: ItemLinkKind, targetId: string): void {
    this.db.prepare('INSERT OR IGNORE INTO item_links (item_id, kind, target_id) VALUES (?, ?, ?)').run(itemId, kind, targetId);
  }

  unlinkItem(itemId: string, kind: ItemLinkKind, targetId: string): void {
    this.db.prepare('DELETE FROM item_links WHERE item_id = ? AND kind = ? AND target_id = ?').run(itemId, kind, targetId);
  }

  /** What an item links to, people first, then tasks, then events. */
  itemLinks(itemId: string): ItemLink[] {
    return this.db
      .prepare(
        `SELECT kind, target_id FROM item_links WHERE item_id = ?
         ORDER BY CASE kind WHEN 'person' THEN 0 WHEN 'task' THEN 1 ELSE 2 END, rowid`,
      )
      .all(itemId) as unknown as ItemLink[];
  }

  /** The ids of the items linked to a person, task, or event, newest first. */
  itemsLinkedTo(kind: ItemLinkKind, targetId: string): string[] {
    return (
      this.db
        .prepare(
          `SELECT l.item_id FROM item_links l JOIN items i ON i.id = l.item_id
           WHERE l.kind = ? AND l.target_id = ? ORDER BY i.created_at DESC, i.rowid DESC`,
        )
        .all(kind, targetId) as { item_id: string }[]
    ).map((r) => r.item_id);
  }

  getItem(id: string): Item | null {
    return (this.db.prepare('SELECT * FROM items WHERE id = ?').get(id) as Item | undefined) ?? null;
  }

  listItems(limit = 100): Item[] {
    return this.db.prepare('SELECT * FROM items ORDER BY created_at DESC, rowid DESC LIMIT ?').all(limit) as unknown as Item[];
  }

  updateItemWhy(id: string, why: string | null): void {
    this.db.prepare('UPDATE items SET why = ? WHERE id = ?').run(why, id);
  }

  /** A memory's new wording (decision 78); its vector is redone by the caller. */
  updateItemText(id: string, text: string): void {
    this.db.prepare('UPDATE items SET text = ? WHERE id = ?').run(text, id);
  }

  /** Items in the order of `ids`. Missing ids are skipped. */
  itemsByIds(ids: string[]): Item[] {
    if (ids.length === 0) return [];
    const rows = this.db.prepare(`SELECT * FROM items WHERE id IN (${ids.map(() => '?').join(', ')})`).all(...ids) as unknown as Item[];
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.flatMap((id) => byId.get(id) ?? []);
  }

  /** Newest first, optionally only since an ISO time. */
  recentItemIds(limit: number, sinceIso?: string): string[] {
    const rows = (
      sinceIso
        ? this.db.prepare('SELECT id FROM items WHERE created_at >= ? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(sinceIso, limit)
        : this.db.prepare('SELECT id FROM items ORDER BY created_at DESC, rowid DESC LIMIT ?').all(limit)
    ) as { id: string }[];
    return rows.map((r) => r.id);
  }

  /** Items whose text, note, or window title contains `query` (case-insensitive), newest first; optionally in one collection. */
  searchItemText(query: string, limit: number, collectionId?: string): string[] {
    const q = `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const inCollection = collectionId ? 'AND collection_id = ?' : '';
    const rows = this.db
      .prepare(
        `SELECT id FROM items WHERE (text LIKE ? ESCAPE '\\' OR why LIKE ? ESCAPE '\\' OR window_title LIKE ? ESCAPE '\\') ${inCollection}
         ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      )
      .all(q, q, q, ...(collectionId ? [collectionId] : []), limit) as { id: string }[];
    return rows.map((r) => r.id);
  }

  // ---- the Saved tab (decision 84) ----

  /**
   * Item ids newest first, narrowed by type, a linked person, and where they were saved (a page's
   * host, else the app), and optionally by words (text, note, window or page title) or to `within`.
   */
  libraryItemIds(filter: LibraryFilter, opts: { limit: number; offset?: number; words?: string; within?: string[] }): string[] {
    const where: string[] = [];
    const args: SQLInputValue[] = [];
    if (filter.kind) {
      where.push('kind = ?');
      args.push(filter.kind);
    }
    if (filter.personId) {
      where.push("EXISTS (SELECT 1 FROM item_links l WHERE l.item_id = items.id AND l.kind = 'person' AND l.target_id = ?)");
      args.push(filter.personId);
    }
    if (filter.source) {
      const s = filter.source.toLowerCase();
      if (s.endsWith('.exe')) {
        where.push('lower(source_app) = ? AND page_url IS NULL');
        args.push(s);
      } else {
        const host = s.replace(/[\\%_]/g, (c) => `\\${c}`);
        where.push("(page_url LIKE ? ESCAPE '\\' OR page_url LIKE ? ESCAPE '\\')");
        args.push(`http://${host}/%`, `https://${host}/%`);
      }
    }
    if (opts.words) {
      const q = `%${opts.words.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      where.push("(text LIKE ? ESCAPE '\\' OR why LIKE ? ESCAPE '\\' OR window_title LIKE ? ESCAPE '\\' OR page_title LIKE ? ESCAPE '\\')");
      args.push(q, q, q, q);
    }
    if (opts.within) {
      if (opts.within.length === 0) return [];
      where.push(`id IN (${opts.within.map(() => '?').join(', ')})`);
      args.push(...opts.within);
    }
    const rows = this.db
      .prepare(`SELECT id FROM items ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`)
      .all(...args, opts.limit, opts.offset ?? 0) as { id: string }[];
    return rows.map((r) => r.id);
  }

  /** How many items of each kind, and in all. */
  kindCounts(): Record<Item['kind'], number> & { all: number } {
    const counts = { selection: 0, note: 0, chart: 0, link: 0, all: 0 };
    for (const r of this.db.prepare('SELECT kind, COUNT(*) AS n FROM items GROUP BY kind').all() as { kind: Item['kind']; n: number }[]) {
      if (r.kind in counts) counts[r.kind] = Number(r.n);
      counts.all += Number(r.n);
    }
    return counts;
  }

  /** The people saved items link to, by name, with how many. */
  linkedPeople(): { id: string; name: string; count: number }[] {
    return (
      this.db
        .prepare(
          `SELECT p.id, p.name, COUNT(*) AS count FROM item_links l JOIN people p ON p.id = l.target_id
           WHERE l.kind = 'person' GROUP BY p.id ORDER BY p.name COLLATE NOCASE`,
        )
        .all() as { id: string; name: string; count: number }[]
    ).map((r) => ({ ...r, count: Number(r.count) }));
  }

  /** Where items were saved: a page's host, else the app's process name, most items first. */
  itemSources(): { key: string; count: number }[] {
    const counts = new Map<string, number>();
    for (const r of this.db.prepare('SELECT source_app, page_url FROM items').all() as { source_app: string | null; page_url: string | null }[]) {
      let key = r.source_app?.toLowerCase() ?? null;
      if (r.page_url) {
        try {
          const u = new URL(r.page_url);
          if (u.hostname) key = u.hostname.toLowerCase();
        } catch {
          /* keep the app */
        }
      }
      if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  }

  /** What these items link to, with a label: the person's name, the task's text, or the event's title. */
  itemLinkLabels(itemIds: string[]): Map<string, { kind: ItemLinkKind; id: string; label: string }[]> {
    const out = new Map<string, { kind: ItemLinkKind; id: string; label: string }[]>();
    if (itemIds.length === 0) return out;
    const rows = this.db
      .prepare(
        `SELECT l.item_id, l.kind, l.target_id, COALESCE(p.name, c.text, e.title) AS label FROM item_links l
         LEFT JOIN people p ON l.kind = 'person' AND p.id = l.target_id
         LEFT JOIN commitments c ON l.kind = 'task' AND c.id = l.target_id
         LEFT JOIN calendar_events e ON l.kind = 'event' AND e.id = l.target_id
         WHERE l.item_id IN (${itemIds.map(() => '?').join(', ')})
         ORDER BY CASE l.kind WHEN 'person' THEN 0 WHEN 'task' THEN 1 ELSE 2 END, l.rowid`,
      )
      .all(...itemIds) as { item_id: string; kind: ItemLinkKind; target_id: string; label: string | null }[];
    for (const r of rows) {
      if (!r.label) continue;
      const list = out.get(r.item_id) ?? [];
      list.push({ kind: r.kind, id: r.target_id, label: r.label });
      out.set(r.item_id, list);
    }
    return out;
  }


  /** Every person, company, product, and place entity, for matching against a selection. */
  matchableEntities(): { id: string; kind: EntityKind; canonical: string; display: string }[] {
    return this.db
      .prepare("SELECT id, kind, canonical, display FROM entities WHERE kind IN ('person', 'company', 'product', 'place')")
      .all() as unknown as { id: string; kind: EntityKind; canonical: string; display: string }[];
  }

  /** Items linked to any of these entities, newest first, with the entity that linked them. */
  itemsForEntities(entityIds: string[], limit: number): { item_id: string; entity_id: string }[] {
    if (entityIds.length === 0) return [];
    return this.db
      .prepare(
        `SELECT ie.item_id, ie.entity_id FROM item_entities ie JOIN items i ON i.id = ie.item_id
         WHERE ie.entity_id IN (${entityIds.map(() => '?').join(', ')}) ORDER BY i.created_at DESC, i.rowid DESC LIMIT ?`,
      )
      .all(...entityIds, limit) as unknown as { item_id: string; entity_id: string }[];
  }

  /** People's entity ids, for people matched by an alias such as an email. */
  personEntityIds(personIds: string[]): string[] {
    if (personIds.length === 0) return [];
    return (
      this.db
        .prepare(`SELECT entity_id FROM people WHERE entity_id IS NOT NULL AND id IN (${personIds.map(() => '?').join(', ')})`)
        .all(...personIds) as { entity_id: string }[]
    ).map((r) => r.entity_id);
  }

  /** Deletes an item, its entity links, its vector, and entities nothing else uses. */
  deleteItem(id: string): boolean {
    return this.tx(() => {
      const entityIds = (this.db.prepare('SELECT entity_id FROM item_entities WHERE item_id = ?').all(id) as { entity_id: string }[]).map(
        (r) => r.entity_id,
      );
      this.db.prepare('DELETE FROM item_entities WHERE item_id = ?').run(id);
      if (this.hasVectors && this.vectorTableExists()) this.db.prepare('DELETE FROM item_vectors WHERE item_id = ?').run(id);
      const res = this.db.prepare('DELETE FROM items WHERE id = ?').run(id);
      const orphan = this.db.prepare(
        `DELETE FROM entities WHERE id = ? AND NOT EXISTS (SELECT 1 FROM item_entities WHERE entity_id = ?)
           AND NOT EXISTS (SELECT 1 FROM people WHERE entity_id = ?)`,
      );
      for (const e of entityIds) orphan.run(e, e, e);
      return Number(res.changes) > 0;
    });
  }

  // ---- entities ----

  upsertEntity(kind: EntityKind, display: string): string {
    const canonical = canonicalize(display);
    const existing = this.db.prepare('SELECT id FROM entities WHERE kind = ? AND canonical = ?').get(kind, canonical) as
      | { id: string }
      | undefined;
    if (existing) return existing.id;
    const id = uuidv7();
    this.db.prepare('INSERT INTO entities (id, kind, canonical, display) VALUES (?, ?, ?, ?)').run(id, kind, canonical, display.trim());
    return id;
  }

  linkItemEntity(itemId: string, entityId: string): void {
    this.db.prepare('INSERT OR IGNORE INTO item_entities (item_id, entity_id) VALUES (?, ?)').run(itemId, entityId);
  }

  entitiesForItem(itemId: string): { id: string; kind: EntityKind; display: string }[] {
    return this.db
      .prepare('SELECT e.id, e.kind, e.display FROM entities e JOIN item_entities ie ON ie.entity_id = e.id WHERE ie.item_id = ? ORDER BY e.display')
      .all(itemId) as unknown as { id: string; kind: EntityKind; display: string }[];
  }

  // ---- people ----

  /** People with their name, handle, and email aliases, for the router's feature matching. */
  listKnownPeople(): KnownPerson[] {
    const people = this.db
      .prepare("SELECT p.id, p.name, (SELECT COUNT(*) FROM commitments c WHERE c.person_id = p.id AND c.status = 'open') AS open FROM people p ORDER BY p.name")
      .all() as { id: string; name: string; open: number }[];
    const aliases = this.db.prepare('SELECT person_id, value FROM person_aliases').all() as { person_id: string; value: string }[];
    return people.map((p) => ({ id: p.id, name: p.name, aliases: aliases.filter((a) => a.person_id === p.id).map((a) => a.value), open: Number(p.open) }));
  }

  /** The person whose name or name alias matches, compared in canonical form. */
  findPersonByName(name: string): { id: string; entity_id: string | null } | null {
    const c = canonicalize(name);
    if (!c) return null;
    const people = this.db.prepare('SELECT id, name, entity_id FROM people').all() as { id: string; name: string; entity_id: string | null }[];
    const hit = people.find((p) => canonicalize(p.name) === c);
    if (hit) return { id: hit.id, entity_id: hit.entity_id };
    const aliases = this.db
      .prepare("SELECT a.value, p.id, p.entity_id FROM person_aliases a JOIN people p ON p.id = a.person_id WHERE a.kind = 'name'")
      .all() as { value: string; id: string; entity_id: string | null }[];
    const alias = aliases.find((a) => canonicalize(a.value) === c);
    return alias ? { id: alias.id, entity_id: alias.entity_id } : null;
  }

  /** Links a person to an entity unless they already have one. */
  setPersonEntity(personId: string, entityId: string): void {
    this.db.prepare('UPDATE people SET entity_id = ?, updated_at = ? WHERE id = ? AND entity_id IS NULL').run(entityId, isoNow(), personId);
  }

  // ---- vectors ----

  private vectorTableExists(): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'item_vectors'").get());
  }

  private contextTableExists(): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'context_vectors'").get());
  }

  /** People, tasks, and events, one partition per kind so a search stays inside one (decision 77). */
  private createContextVectors(dims: number): void {
    this.db.exec('DROP TABLE IF EXISTS context_vectors');
    this.db.exec(
      `CREATE VIRTUAL TABLE context_vectors USING vec0(doc_id TEXT PRIMARY KEY, kind TEXT PARTITION KEY, embedding FLOAT[${Math.trunc(dims)}] distance_metric=cosine)`,
    );
    this.db.exec('DELETE FROM context_docs');
    this.db.prepare('DELETE FROM meta WHERE key = ?').run(CONTEXT_SYNCED_KEY);
  }

  /** Goes up on every write to people, aliases, messages, tasks, or events (migration 10's triggers). */
  contextClock(): number {
    return (this.db.prepare('SELECT n FROM context_clock').get() as { n: number } | undefined)?.n ?? 0;
  }

  /** The clock as of the last finished sync, or null when everything must be checked. */
  contextSyncedAt(): number | null {
    const v = this.getMeta(CONTEXT_SYNCED_KEY);
    return v === null ? null : Number(v);
  }

  setContextSyncedAt(clock: number): void {
    this.setMeta(CONTEXT_SYNCED_KEY, String(clock));
  }

  /**
   * Makes sure item_vectors and context_vectors match the embedding model. Returns true when
   * item_vectors was (re)created and every item needs re-embedding.
   */
  ensureVectorModel(model: string, dims: number): boolean {
    if (!this.hasVectors) return false;
    const same = this.getMeta('embedding_model') === model && this.getMeta('embedding_dims') === String(dims);
    if (same && this.vectorTableExists()) {
      // Databases from before migration 10 have item vectors but no context table yet.
      if (!this.contextTableExists()) this.tx(() => this.createContextVectors(dims));
      return false;
    }
    this.tx(() => {
      this.db.exec('DROP TABLE IF EXISTS item_vectors');
      this.db.exec(`CREATE VIRTUAL TABLE item_vectors USING vec0(item_id TEXT PRIMARY KEY, embedding FLOAT[${Math.trunc(dims)}] distance_metric=cosine)`);
      this.createContextVectors(dims);
      this.setMeta('embedding_model', model);
      this.setMeta('embedding_dims', String(dims));
    });
    return true;
  }

  /** Every embedded person, task, and event with the hash of the text it was embedded from. */
  contextHashes(): Map<string, { kind: ContextKind; hash: string }> {
    if (!this.hasVectors || !this.contextTableExists()) return new Map();
    const rows = this.db.prepare('SELECT doc_id, kind, hash FROM context_docs').all() as { doc_id: string; kind: ContextKind; hash: string }[];
    return new Map(rows.map((r) => [r.doc_id, { kind: r.kind, hash: r.hash }]));
  }

  setContextVector(docId: string, kind: ContextKind, hash: string, v: Float32Array | number[]): void {
    if (!this.hasVectors || !this.contextTableExists()) return;
    this.tx(() => {
      this.db.prepare('DELETE FROM context_vectors WHERE doc_id = ?').run(docId);
      this.db.prepare('INSERT INTO context_vectors (doc_id, kind, embedding) VALUES (?, ?, ?)').run(docId, kind, vecBytes(v));
      this.db
        .prepare('INSERT INTO context_docs (doc_id, kind, hash, embedded_at) VALUES (?, ?, ?, ?) ON CONFLICT(doc_id) DO UPDATE SET kind = excluded.kind, hash = excluded.hash, embedded_at = excluded.embedded_at')
        .run(docId, kind, hash, isoNow());
    });
  }

  deleteContextDocs(docIds: string[]): void {
    if (!this.hasVectors || !this.contextTableExists() || docIds.length === 0) return;
    this.tx(() => {
      const vec = this.db.prepare('DELETE FROM context_vectors WHERE doc_id = ?');
      const doc = this.db.prepare('DELETE FROM context_docs WHERE doc_id = ?');
      for (const id of docIds) {
        vec.run(id);
        doc.run(id);
      }
    });
  }

  /** Nearest people, tasks, or events (one kind) by cosine similarity (1 = identical). */
  searchContextVectors(v: Float32Array | number[], kind: ContextKind, k = 5): { doc_id: string; similarity: number }[] {
    if (!this.hasVectors || !this.contextTableExists()) return [];
    const rows = this.db
      .prepare('SELECT doc_id, distance FROM context_vectors WHERE embedding MATCH ? AND k = ? AND kind = ? ORDER BY distance')
      .all(vecBytes(v), k, kind) as { doc_id: string; distance: number }[];
    return rows.map((r) => ({ doc_id: r.doc_id, similarity: 1 - r.distance }));
  }

  setVector(itemId: string, v: Float32Array | number[]): void {
    if (!this.hasVectors) return;
    this.db.prepare('DELETE FROM item_vectors WHERE item_id = ?').run(itemId);
    this.db.prepare('INSERT INTO item_vectors (item_id, embedding) VALUES (?, ?)').run(itemId, vecBytes(v));
  }

  /** Nearest items by cosine similarity (1 = identical). */
  searchVectors(v: Float32Array | number[], k = 5): { item_id: string; similarity: number }[] {
    if (!this.hasVectors || !this.vectorTableExists()) return [];
    const rows = this.db
      .prepare('SELECT item_id, distance FROM item_vectors WHERE embedding MATCH ? AND k = ? ORDER BY distance')
      .all(vecBytes(v), k) as { item_id: string; distance: number }[];
    return rows.map((r) => ({ item_id: r.item_id, similarity: 1 - r.distance }));
  }

  /** Marks or clears an item whose entities no model has looked for yet (decision 44). */
  setEntitiesPending(itemId: string, pending: boolean): void {
    this.db.prepare('UPDATE items SET entities_pending = ? WHERE id = ?').run(pending ? 1 : 0, itemId);
  }

  countEntitiesPending(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM items WHERE entities_pending = 1').get() as { n: number }).n;
  }

  /** Oldest first. */
  itemsWithEntitiesPending(limit = 100): Item[] {
    return this.db.prepare('SELECT * FROM items WHERE entities_pending = 1 ORDER BY created_at LIMIT ?').all(limit) as unknown as Item[];
  }

  itemsWithoutVectors(limit = 100): Item[] {
    if (!this.hasVectors || !this.vectorTableExists()) return [];
    return this.db
      .prepare('SELECT * FROM items WHERE id NOT IN (SELECT item_id FROM item_vectors) ORDER BY created_at LIMIT ?')
      .all(limit) as unknown as Item[];
  }

  // ---- events (local metrics) ----

  // ---- model call log (decision 61) ----

  addLlmCall(c: LlmCallRow): void {
    this.db
      .prepare(
        `INSERT INTO llm_calls (id, at, action, role, model, fallback_from, status, error, ms, input_tokens, output_tokens, cached_tokens, reasoning_tokens, prompt, response)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(uuidv7(), c.at, c.action, c.role, c.model, c.fallback_from, c.status, c.error, c.ms, c.input_tokens, c.output_tokens, c.cached_tokens, c.reasoning_tokens, c.prompt, c.response);
  }

  /** Newest first, optionally one action's. */
  llmCalls(opts: { action?: string; limit?: number } = {}): (LlmCallRow & { id: string })[] {
    const limit = Math.max(1, Math.min(1000, opts.limit ?? 50));
    const rows = opts.action
      ? this.db.prepare('SELECT * FROM llm_calls WHERE action = ? ORDER BY at DESC, rowid DESC LIMIT ?').all(opts.action, limit)
      : this.db.prepare('SELECT * FROM llm_calls ORDER BY at DESC, rowid DESC LIMIT ?').all(limit);
    return rows as unknown as (LlmCallRow & { id: string })[];
  }

  /** Drops calls older than `beforeIso`; with no time, all of them (the log was turned off). Returns how many. */
  pruneLlmCalls(beforeIso?: string): number {
    const r = beforeIso ? this.db.prepare('DELETE FROM llm_calls WHERE at < ?').run(beforeIso) : this.db.prepare('DELETE FROM llm_calls').run();
    return Number(r.changes);
  }

  insertEvent(kind: string, payload: Record<string, unknown> | null = null, at = isoNow()): void {
    this.db.prepare('INSERT INTO events (id, kind, payload_json, at) VALUES (?, ?, ?, ?)').run(uuidv7(), kind, payload ? JSON.stringify(payload) : null, at);
  }

  listEvents(sinceIso?: string): EventRow[] {
    const rows = (
      sinceIso
        ? this.db.prepare('SELECT * FROM events WHERE at >= ? ORDER BY at').all(sinceIso)
        : this.db.prepare('SELECT * FROM events ORDER BY at').all()
    ) as { id: string; kind: string; payload_json: string | null; at: string }[];
    return rows.map((r) => ({ id: r.id, kind: r.kind, at: r.at, payload: r.payload_json ? JSON.parse(r.payload_json) : null }));
  }

  // ---- model catalog ----

  replaceModels(provider: string, models: Omit<StoredModel, 'provider' | 'fetched_at'>[], fetchedAt = isoNow()): void {
    const ins = this.db.prepare(
      'INSERT INTO models (provider, model_id, display_name, capabilities_json, fetched_at) VALUES (?, ?, ?, ?, ?)',
    );
    this.tx(() => {
      this.db.prepare('DELETE FROM models WHERE provider = ?').run(provider);
      for (const m of models) ins.run(provider, m.model_id, m.display_name, JSON.stringify(m.capabilities), fetchedAt);
    });
  }

  removeProviderModels(provider: string): void {
    this.db.prepare('DELETE FROM models WHERE provider = ?').run(provider);
  }

  listModels(): StoredModel[] {
    const rows = this.db.prepare('SELECT * FROM models ORDER BY provider, model_id').all() as {
      provider: string;
      model_id: string;
      display_name: string;
      capabilities_json: string;
      fetched_at: string;
    }[];
    return rows.map((r) => ({ ...r, capabilities: JSON.parse(r.capabilities_json) as Record<string, unknown> }));
  }

  // ---- export and delete-all ----

  /** Everything the user owns, as plain JSON. Vectors are derived data and are left out. */
  exportAll(): Record<string, unknown> {
    const tables: Record<string, unknown[]> = {};
    for (const t of DATA_TABLES) tables[t] = this.db.prepare(`SELECT * FROM ${t}`).all() as unknown[];
    return {
      app: 'glossly',
      schema_version: this.schemaVersion,
      exported_at: isoNow(),
      note: 'API keys are not stored in this database and are not included. Embeddings are recomputed on import.',
      tables,
    };
  }

  /**
   * "Delete all data": every saved item, entity, person, vector, event, and collection.
   * Settings, the model list, and meta stay, except the
   * Reply style notes the user removed (their text) and the edit count toward the next notes.
   */
  deleteAll(): void {
    this.tx(() => {
      for (const t of USER_DATA_TABLES) this.db.exec(`DELETE FROM ${t}`);
      this.db.exec(`DELETE FROM meta WHERE key IN ('style_notes_removed', 'style_edits_pending', '${CONTEXT_SYNCED_KEY}')`);
      if (this.hasVectors && this.vectorTableExists()) this.db.exec('DELETE FROM item_vectors');
      if (this.hasVectors && this.contextTableExists()) this.db.exec('DELETE FROM context_vectors');
    });
    this.db.exec('VACUUM');
  }

  /** "Reset settings": every stored setting goes back to its default (first run included). */
  resetSettings(): void {
    this.db.exec('DELETE FROM settings');
  }

  clearModels(): void {
    this.db.exec('DELETE FROM models');
  }
}



export type { SQLInputValue };
