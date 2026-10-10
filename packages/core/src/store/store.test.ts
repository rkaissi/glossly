import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../settings';
import { canonicalize } from '../people/names';
import { Store } from './store';

const require = createRequire(import.meta.url);
const vecExtensionPath = (require('sqlite-vec') as { getLoadablePath(): string }).getLoadablePath();

let store: Store;
afterEach(() => store?.close());

function unit(dims: number, hot: number): Float32Array {
  const v = new Float32Array(dims);
  v[hot] = 1;
  return v;
}

describe('Store', () => {
  it('migrates and seeds default collections', () => {
    store = new Store(':memory:');
    expect(store.schemaVersion).toBe(1);
    expect(store.listCollections().map((c) => c.name)).toEqual(['Notes', 'Reading', 'Ideas', 'People notes']);
    expect(store.collectionByName('reading')?.name).toBe('Reading');
  });

  it('round-trips settings with defaults for missing and corrupt keys', () => {
    store = new Store(':memory:');
    expect(store.getSettings()).toEqual(DEFAULT_SETTINGS);
    store.setSetting('localOnly', true);
    store.setSetting('appModes', { 'slack.exe': 'hotkey' });
    store.db.prepare("INSERT INTO settings (key, value_json) VALUES ('hotkey', '42')").run();
    const s = store.getSettings();
    expect(s.localOnly).toBe(true);
    expect(s.appModes).toEqual({ 'slack.exe': 'hotkey' });
    expect(s.hotkey).toBe(DEFAULT_SETTINGS.hotkey);
  });

  it('moves a stored router timeout of exactly 400 ms to 600 ms, once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'glossly-store-'));
    const path = join(dir, 'g.db');
    try {
      const router = (ms: number) => ({ ...DEFAULT_SETTINGS.router, decisionTimeoutMs: ms });
      // A database from before the migration existed.
      store = new Store(path);
      store.setSetting('router', router(400));
      store.db.prepare("DELETE FROM meta WHERE key = 'settings_migrations'").run();
      store.close();
      store = new Store(path);
      expect(store.getSettings().router.decisionTimeoutMs).toBe(600);
      // A 400 the user picks afterwards is kept.
      store.setSetting('router', router(400));
      store.close();
      store = new Store(path);
      expect(store.getSettings().router.decisionTimeoutMs).toBe(400);
      // Any other stored value is left alone.
      store.setSetting('router', router(450));
      store.db.prepare("DELETE FROM meta WHERE key = 'settings_migrations'").run();
      store.close();
      store = new Store(path);
      expect(store.getSettings().router.decisionTimeoutMs).toBe(450);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stores items with entities and deletes orphans with the item', () => {
    store = new Store(':memory:');
    const notes = store.collectionByName('Notes')!;
    const item = store.insertItem({
      collection_id: notes.id,
      kind: 'selection',
      text: 'Sam from Acme',
      why: null,
      source_app: 'slack.exe',
      window_title: '#design',
      data_json: null,
    });
    const sam = store.upsertEntity('person', 'Sam Lee');
    expect(store.upsertEntity('person', '  sam   LEE ')).toBe(sam);
    store.linkItemEntity(item.id, sam);
    store.linkItemEntity(item.id, store.upsertEntity('company', 'Acme'));
    expect(store.entitiesForItem(item.id).map((e) => e.display)).toEqual(['Acme', 'Sam Lee']);

    expect(store.deleteItem(item.id)).toBe(true);
    expect(store.getItem(item.id)).toBeNull();
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM entities').get()).toEqual({ n: 0 });
  });

  it('searches vectors with sqlite-vec by cosine similarity', () => {
    store = new Store(':memory:', { vecExtensionPath });
    expect(store.ensureVectorModel('test-model', 8)).toBe(true);
    expect(store.ensureVectorModel('test-model', 8)).toBe(false);
    const ids = [0, 1, 2].map((i) =>
      store.insertItem({ collection_id: null, kind: 'note', text: `n${i}`, why: null, source_app: null, window_title: null, data_json: null }).id,
    );
    ids.forEach((id, i) => store.setVector(id, unit(8, i)));
    const hits = store.searchVectors(unit(8, 1), 2);
    expect(hits[0]).toEqual({ item_id: ids[1], similarity: expect.closeTo(1, 5) });
    expect(hits[1]!.similarity).toBeCloseTo(0, 5);

    // Changing the model resets the table so everything is re-embedded.
    expect(store.ensureVectorModel('other-model', 8)).toBe(true);
    expect(store.itemsWithoutVectors().length).toBe(3);
  });

  function fill(): string {
    store.ensureVectorModel('m', 4);
    store.createCollection('Recipes');
    const item = store.insertItem({ collection_id: null, kind: 'note', text: 'x', why: 'y', source_app: null, window_title: null, data_json: null });
    store.setVector(item.id, unit(4, 0));
    store.linkItemEntity(item.id, store.upsertEntity('person', 'Sam Lee'));
    store.insertEvent('hotkey', { ms: 3 });
    store.setSetting('localOnly', true);
    store.setSetting('firstRunComplete', true);
    store.replaceModels('groq', [{ model_id: 'qwen/qwen3.8-27b', display_name: 'Qwen', capabilities: {} }]);
    store.setMeta('key_test:groq', '{"ok":true}');
    return item.id;
  }

  it('exports everything', () => {
    store = new Store(':memory:', { vecExtensionPath });
    fill();
    const dump = store.exportAll() as { tables: Record<string, unknown[]> };
    expect(dump.tables.items).toHaveLength(1);
    expect(dump.tables.events).toHaveLength(1);
    expect(dump.tables.settings).toHaveLength(2);
    expect(JSON.stringify(dump)).not.toContain('apiKey');
  });

  it('delete all data keeps settings, the model list, and meta', () => {
    store = new Store(':memory:', { vecExtensionPath });
    fill();
    store.deleteAll();
    expect(store.listItems()).toHaveLength(0);
    expect(store.listEvents()).toHaveLength(0);
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM entities').get()).toEqual({ n: 0 });
    expect(store.searchVectors(unit(4, 0))).toHaveLength(0);
    expect(store.listCollections().map((c) => c.name)).toEqual(['Notes', 'Reading', 'Ideas', 'People notes']);
    expect(store.getSettings()).toMatchObject({ localOnly: true, firstRunComplete: true });
    expect(store.listModels()).toHaveLength(1);
    expect(store.getMeta('key_test:groq')).toBe('{"ok":true}');
  });

  it('reset settings keeps saved data', () => {
    store = new Store(':memory:', { vecExtensionPath });
    const id = fill();
    store.resetSettings();
    expect(store.getSettings()).toEqual(DEFAULT_SETTINGS);
    expect(store.getItem(id)).not.toBeNull();
    expect(store.listCollections()).toHaveLength(5);
    store.clearModels();
    expect(store.listModels()).toHaveLength(0);
  });

  it('records events', () => {
    store = new Store(':memory:');
    store.insertEvent('action_clicked', { action: 'ask' }, '2026-10-09T10:00:00-04:00');
    store.insertEvent('hotkey', null, '2026-10-10T10:00:00-04:00');
    expect(store.listEvents('2026-10-10').map((e) => e.kind)).toEqual(['hotkey']);
  });
});

describe('canonicalize', () => {
  it('normalizes case, spacing, and punctuation', () => {
    expect(canonicalize('  Sam   LEE ')).toBe('sam lee');
    expect(canonicalize('O\u2019Brien, Inc.')).toBe("o'brien inc.");
  });
});
