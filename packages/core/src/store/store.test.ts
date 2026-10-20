import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../settings';
import { canonicalize } from '../people/names';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from './migrations';
import { CalendarRepo } from './calendar';
import { PeopleRepo } from './people';
import { toLlmCallRow } from './llm-call-row';
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
  it('migrates and seeds no collections (decision 84)', () => {
    store = new Store(':memory:');
    expect(store.schemaVersion).toBe(MIGRATIONS.length);
    expect(store.listCollections()).toEqual([]);
    store.createCollection('Reading');
    expect(store.collectionByName('reading')?.name).toBe('Reading');
  });

  it('drops every stored contractions vote and gives style notes a platform (migration 8, decision 49)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'glossly-m8-'));
    const path = join(dir, 'db.sqlite');
    try {
      const old = new DatabaseSync(path);
      MIGRATIONS.slice(0, 7).forEach((m) => old.exec(m));
      old.exec('PRAGMA user_version = 7');
      const add = old.prepare("INSERT INTO style_signals (id, dimension, pole, weight, channel, person_id, at) VALUES (?, ?, ?, 1, 'messaging', NULL, '2026-10-10T20:00:00-04:00')");
      add.run('a', 'contractions', 'without');
      add.run('b', 'contractions', 'with');
      add.run('c', 'length', 'shorter');
      old.exec("INSERT INTO style_notes (id, text, created_at) VALUES ('n', 'Writes in lowercase', '2026-10-10T20:00:00-04:00')");
      old.close();
      store = new Store(path);
      expect(store.schemaVersion).toBe(MIGRATIONS.length);
      const people = new PeopleRepo(store);
      expect(people.styleSignals().map((s) => s.dimension)).toEqual(['length']);
      expect(people.styleNotes()).toMatchObject([{ text: 'Writes in lowercase', channel: null }]);
    } finally {
      store?.close();
      rmSync(dir, { recursive: true, force: true });
    }
    // A file on disk, migrated from 7 to the latest: over 5 s on GitHub's Windows runner (v0.1.7 build).
  }, 30_000);

  it('splits person notes into facts, one per line, and keeps the note (migration 12, decision 84)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'glossly-m12-'));
    const path = join(dir, 'db.sqlite');
    try {
      const old = new DatabaseSync(path);
      MIGRATIONS.slice(0, 11).forEach((m) => old.exec(m));
      old.exec('PRAGMA user_version = 11');
      const add = old.prepare("INSERT INTO people (id, entity_id, name, note, created_at, updated_at) VALUES (?, NULL, ?, ?, '2026-10-01T09:00:00-04:00', ?)");
      add.run('p1', 'Jordan Hale', 'Leads the pricing project at Acme\r\n- Vegetarian\n\n  • Moving to the Berlin office in January  ', '2026-10-15T09:00:00-04:00');
      add.run('p2', 'Casey Lin', null, '2026-10-02T09:00:00-04:00');
      add.run('p3', 'Maya Chen', '   ', '2026-10-03T09:00:00-04:00');
      add.run('p4', 'Alex Morgan', 'Prefers a call over email', '2026-10-04T09:00:00-04:00');
      old.close();
      store = new Store(path);
      const people = new PeopleRepo(store);
      expect(people.facts('p1').map((f) => f.text)).toEqual(['Leads the pricing project at Acme', 'Vegetarian', 'Moving to the Berlin office in January']);
      expect(people.facts('p1').every((f) => f.source === 'note' && f.created_at === '2026-10-15T09:00:00-04:00')).toBe(true);
      expect(people.facts('p2')).toEqual([]);
      expect(people.facts('p3')).toEqual([]);
      expect(people.facts('p4').map((f) => f.text)).toEqual(['Prefers a call over email']);
      expect(people.get('p1')?.note).toContain('Vegetarian');
    } finally {
      store?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('keeps an item page, addresses, and preview (decision 84)', () => {
    store = new Store(':memory:');
    const plain = store.insertItem({ collection_id: null, kind: 'selection', text: 'plain', why: null, source_app: null, window_title: null, data_json: null });
    expect(store.getItem(plain.id)).toMatchObject({ page_url: null, page_title: null, urls_json: null, preview_json: null });
    const link = store.insertItem({
      collection_id: null,
      kind: 'link',
      text: 'https://acme.example.com/blog/design-reviews',
      why: null,
      source_app: 'chrome.exe',
      window_title: 'How we run design reviews - Google Chrome',
      data_json: null,
      page_url: 'https://acme.example.com/blog/design-reviews',
      page_title: 'How we run design reviews',
      urls_json: JSON.stringify(['https://acme.example.com/blog/design-reviews']),
    });
    expect(store.getItem(link.id)).toMatchObject({ kind: 'link', page_title: 'How we run design reviews', preview_json: null });
    const preview = { source: 'page' as const, title: 'How we run design reviews', description: null, site: 'Acme blog', image: 'a.png', icon: null };
    store.setItemPreview(link.id, preview);
    expect(JSON.parse(store.getItem(link.id)!.preview_json!)).toEqual(preview);
    store.setItemPage(plain.id, { url: 'https://docs.example.com/d/1', title: 'Acme pricing 2026' });
    expect(store.getItem(plain.id)).toMatchObject({ page_url: 'https://docs.example.com/d/1', page_title: 'Acme pricing 2026' });
    store.setItemPreview(link.id, null);
    expect(store.getItem(link.id)!.preview_json).toBeNull();
  });

  it('links items to people, tasks, and events, and drops a link when its target goes (decision 84)', () => {
    store = new Store(':memory:');
    const people = new PeopleRepo(store);
    const calendar = new CalendarRepo(store);
    const jordan = people.create({ name: 'Jordan Hale' });
    const task = people.addCommitment({ person_id: jordan.id, owner: 'me', text: 'Send pricing to Jordan', due_at: null });
    const event = calendar.add({ title: 'Lunch with Jordan', starts_at: '2026-10-23T13:00:00-04:00', ends_at: '2026-10-23T14:00:00-04:00', all_day: false, location: null, attendees: [], personIds: [] }, null);
    const item = (text: string) => store.insertItem({ collection_id: null, kind: 'selection', text, why: null, source_app: null, window_title: null, data_json: null });
    const a = item('Q3 pricing tiers');
    const b = item('Lunch spot');

    store.linkItem(a.id, 'event', event.id);
    store.linkItem(a.id, 'task', task.id);
    store.linkItem(a.id, 'person', jordan.id);
    store.linkItem(a.id, 'person', jordan.id);
    store.linkItem(b.id, 'person', jordan.id);
    expect(store.itemLinks(a.id)).toEqual([
      { kind: 'person', target_id: jordan.id },
      { kind: 'task', target_id: task.id },
      { kind: 'event', target_id: event.id },
    ]);
    expect(store.itemsLinkedTo('person', jordan.id).sort()).toEqual([a.id, b.id].sort());

    store.unlinkItem(b.id, 'person', jordan.id);
    expect(store.itemLinks(b.id)).toEqual([]);
    people.deleteCommitment(task.id);
    calendar.delete(event.id);
    expect(store.itemLinks(a.id)).toEqual([{ kind: 'person', target_id: jordan.id }]);
    people.delete(jordan.id);
    expect(store.itemLinks(a.id)).toEqual([]);

    store.linkItem(b.id, 'person', people.create({ name: 'Casey Lin' }).id);
    store.deleteItem(b.id);
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM item_links').get()).toEqual({ n: 0 });
  });

  it('keeps facts per person, moves them and person links on merge, and drops them with the person (decision 84)', () => {
    store = new Store(':memory:');
    let t = 0;
    const people = new PeopleRepo(store, () => `2026-10-19T09:00:${String(t++).padStart(2, '0')}-04:00`);
    const jordan = people.create({ name: 'Jordan Hale' });
    const dup = people.create({ name: 'J. Hale' });
    const first = people.addFact(jordan.id, '  Leads the pricing\n project  ', 'ask')!;
    expect(first.text).toBe('Leads the pricing project');
    expect(people.addFact(jordan.id, '   ', 'you')).toBeNull();
    expect(people.addFact('gone', 'x', 'you')).toBeNull();
    people.addFact(dup.id, 'Vegetarian', 'you');
    expect(people.updateFact(first.id, 'Leads the pricing project at Acme')).toBe(true);
    expect(people.facts(jordan.id).map((f) => f.text)).toEqual(['Leads the pricing project at Acme']);

    const item = store.insertItem({ collection_id: null, kind: 'selection', text: 'x', why: null, source_app: null, window_title: null, data_json: null });
    store.linkItem(item.id, 'person', jordan.id);
    store.linkItem(item.id, 'person', dup.id);
    people.merge(jordan.id, dup.id);
    expect(people.facts(jordan.id).map((f) => f.text)).toEqual(['Leads the pricing project at Acme', 'Vegetarian']);
    expect(store.itemLinks(item.id)).toEqual([{ kind: 'person', target_id: jordan.id }]);

    const vegetarian = people.facts(jordan.id)[1]!;
    expect(people.updateFact(vegetarian.id, '')).toBe(true);
    expect(people.facts(jordan.id)).toHaveLength(1);
    expect(people.removeFact('gone')).toBe(false);
    people.delete(jordan.id);
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM person_facts').get()).toEqual({ n: 0 });
  });

  it('round-trips settings with defaults for missing and corrupt keys', () => {
    store = new Store(':memory:');
    expect(store.getSettings()).toEqual(DEFAULT_SETTINGS);
    store.setSetting('privacy', 'local');
    store.setSetting('appModes', { 'slack.exe': 'hotkey' });
    store.db.prepare("INSERT INTO settings (key, value_json) VALUES ('hotkey', '42')").run();
    const s = store.getSettings();
    expect(s.privacy).toBe('local');
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

  it('moves a stored word minimum of exactly 3 to 0, once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'glossly-store-'));
    const path = join(dir, 'g.db');
    try {
      const capture = (minWords: number) => ({ ...DEFAULT_SETTINGS.capture, minWords });
      store = new Store(path);
      store.setSetting('capture', capture(3));
      store.db.prepare("DELETE FROM meta WHERE key = 'settings_migrations'").run();
      store.close();
      store = new Store(path);
      expect(store.getSettings().capture.minWords).toBe(0);
      store.setSetting('capture', capture(3));
      store.close();
      store = new Store(path);
      expect(store.getSettings().capture.minWords).toBe(3);
      store.setSetting('capture', capture(5));
      store.db.prepare("DELETE FROM meta WHERE key = 'settings_migrations'").run();
      store.close();
      store = new Store(path);
      expect(store.getSettings().capture.minWords).toBe(5);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('renames stored title keys in appModes to plain site names, once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'glossly-store-'));
    const path = join(dir, 'g.db');
    try {
      store = new Store(path);
      store.setSetting('appModes', { 'Discord |': 'hotkey', '- Google Docs': 'off', '| Medium': 'hotkey', 'slack.exe': 'hotkey', Notion: 'auto', '- Notion': 'hotkey' });
      store.db.prepare("DELETE FROM meta WHERE key = 'settings_migrations'").run();
      store.close();
      store = new Store(path);
      // A name already present wins over a title key that maps to it.
      expect(store.getSettings().appModes).toEqual({ Discord: 'hotkey', 'Google Docs': 'off', Medium: 'hotkey', 'slack.exe': 'hotkey', Notion: 'auto' });
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('turns the old Local only checkbox into the privacy choice, once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'glossly-store-'));
    const path = join(dir, 'g.db');
    try {
      store = new Store(path);
      store.db.prepare("INSERT INTO settings (key, value_json) VALUES ('localOnly', 'true')").run();
      store.db.prepare("DELETE FROM meta WHERE key = 'settings_migrations'").run();
      store.close();
      store = new Store(path);
      expect(store.getSettings().privacy).toBe('local');
      expect(store.db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'localOnly'").get()).toEqual({ n: 0 });
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stores items with entities and deletes orphans with the item', () => {
    store = new Store(':memory:');
    const notes = store.createCollection('Notes');
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
    store.setSetting('privacy', 'local');
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
    expect(store.listCollections()).toEqual([]);
    expect(store.getSettings()).toMatchObject({ privacy: 'local', firstRunComplete: true });
    expect(store.listModels()).toHaveLength(1);
    expect(store.getMeta('key_test:groq')).toBe('{"ok":true}');
  });

  it('reset settings keeps saved data', () => {
    store = new Store(':memory:', { vecExtensionPath });
    const id = fill();
    store.resetSettings();
    expect(store.getSettings()).toEqual(DEFAULT_SETTINGS);
    expect(store.getItem(id)).not.toBeNull();
    expect(store.listCollections()).toHaveLength(1);
    store.clearModels();
    expect(store.listModels()).toHaveLength(0);
  });

  it('records events', () => {
    store = new Store(':memory:');
    store.insertEvent('action_clicked', { action: 'ask' }, '2026-10-09T10:00:00-04:00');
    store.insertEvent('hotkey', null, '2026-10-10T10:00:00-04:00');
    expect(store.listEvents('2026-10-10').map((e) => e.kind)).toEqual(['hotkey']);
  });

  it('keeps the model call log apart: pruned by age, cleared with the data, never exported (decision 61)', () => {
    store = new Store(':memory:');
    const call = (at: string, action: string) =>
      store.addLlmCall(
        toLlmCallRow(
          { action, role: 'fast', model: 'groq:openai/gpt-oss-20b', fallbackFrom: null, status: 'ok', error: null, ms: 312, prompt: 'Who is Jordan Hale?', response: '{}', usage: null },
          at,
        ),
      );
    call('2026-09-01T10:00:00Z', 'who');
    call('2026-10-11T10:00:00Z', 'promises');
    call('2026-10-12T10:00:00Z', 'who');
    expect(store.llmCalls({ action: 'who' }).map((c) => c.at)).toEqual(['2026-10-12T10:00:00Z', '2026-09-01T10:00:00Z']);
    expect(store.pruneLlmCalls('2026-09-12T10:00:00Z')).toBe(1);
    expect(store.llmCalls()).toHaveLength(2);
    expect(Object.keys((store.exportAll() as { tables: Record<string, unknown> }).tables)).not.toContain('llm_calls');
    store.deleteAll();
    expect(store.llmCalls()).toEqual([]);
  });
});

describe('canonicalize', () => {
  it('normalizes case, spacing, and punctuation', () => {
    expect(canonicalize('  Sam   LEE ')).toBe('sam lee');
    expect(canonicalize('O\u2019Brien, Inc.')).toBe("o'brien inc.");
  });
});
