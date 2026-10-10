import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { uuidv7 } from 'uuidv7';
import type { KnownPerson } from '../router/types';
import { DEFAULT_COLLECTIONS, SETTINGS_MIGRATIONS, parseSettings, type Settings, type SettingsKey } from '../settings';
import { isoNow, type Collection, type Item } from '../types';
import { DATA_TABLES, MIGRATIONS, USER_DATA_TABLES } from './migrations';

export type EntityKind = 'person' | 'company' | 'product' | 'place' | 'other';

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
    this.ensureDefaultCollections();
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
        const row = this.db.prepare('SELECT value_json FROM settings WHERE key = ?').get(m.key) as { value_json: string } | undefined;
        if (!row) continue;
        let stored: unknown;
        try {
          stored = JSON.parse(row.value_json);
        } catch {
          continue;
        }
        const next = m.migrate(stored);
        if (next !== undefined) this.db.prepare('UPDATE settings SET value_json = ? WHERE key = ?').run(JSON.stringify(next), m.key);
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

  // ---- collections ----

  ensureDefaultCollections(): void {
    const count = (this.db.prepare('SELECT COUNT(*) AS n FROM collections').get() as { n: number }).n;
    if (count > 0) return;
    const ins = this.db.prepare('INSERT INTO collections (id, name, created_at) VALUES (?, ?, ?)');
    this.tx(() => {
      for (const name of DEFAULT_COLLECTIONS) ins.run(uuidv7(), name, isoNow());
    });
  }

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

  insertItem(item: Omit<Item, 'id' | 'created_at'> & { id?: string; created_at?: string }): Item {
    const row: Item = { ...item, id: item.id ?? uuidv7(), created_at: item.created_at ?? isoNow() };
    this.db
      .prepare(
        `INSERT INTO items (id, collection_id, kind, text, why, source_app, window_title, data_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.collection_id, row.kind, row.text, row.why, row.source_app, row.window_title, row.data_json, row.created_at);
    return row;
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
    const people = this.db.prepare('SELECT id, name FROM people ORDER BY name').all() as { id: string; name: string }[];
    const aliases = this.db.prepare('SELECT person_id, value FROM person_aliases').all() as { person_id: string; value: string }[];
    return people.map((p) => ({ id: p.id, name: p.name, aliases: aliases.filter((a) => a.person_id === p.id).map((a) => a.value) }));
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

  /**
   * Makes sure item_vectors matches the embedding model. Returns true when the table was
   * (re)created and every item needs re-embedding.
   */
  ensureVectorModel(model: string, dims: number): boolean {
    if (!this.hasVectors) return false;
    const same = this.getMeta('embedding_model') === model && this.getMeta('embedding_dims') === String(dims);
    if (same && this.vectorTableExists()) return false;
    this.tx(() => {
      this.db.exec('DROP TABLE IF EXISTS item_vectors');
      this.db.exec(`CREATE VIRTUAL TABLE item_vectors USING vec0(item_id TEXT PRIMARY KEY, embedding FLOAT[${Math.trunc(dims)}] distance_metric=cosine)`);
      this.setMeta('embedding_model', model);
      this.setMeta('embedding_dims', String(dims));
    });
    return true;
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

  itemsWithoutVectors(limit = 100): Item[] {
    if (!this.hasVectors || !this.vectorTableExists()) return [];
    return this.db
      .prepare('SELECT * FROM items WHERE id NOT IN (SELECT item_id FROM item_vectors) ORDER BY created_at LIMIT ?')
      .all(limit) as unknown as Item[];
  }

  // ---- events (local metrics) ----

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
   * "Delete all data": every saved item, entity, person, vector, event, and collection, then
   * re-creates the default collections. Settings, the model list, and meta stay.
   */
  deleteAll(): void {
    this.tx(() => {
      for (const t of USER_DATA_TABLES) this.db.exec(`DELETE FROM ${t}`);
      if (this.hasVectors && this.vectorTableExists()) this.db.exec('DELETE FROM item_vectors');
    });
    this.db.exec('VACUUM');
    this.ensureDefaultCollections();
  }

  /** "Reset settings": every stored setting goes back to its default (first run included). */
  resetSettings(): void {
    this.db.exec('DELETE FROM settings');
  }

  clearModels(): void {
    this.db.exec('DELETE FROM models');
  }
}

export function canonicalize(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u2019']/g, "'")
    .replace(/[^\p{L}\p{N}@.' +-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export type { SQLInputValue };
