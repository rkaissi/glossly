import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type { Embedder } from '../embed/types';
import { LlmError, type ChatRequest, type LlmProvider } from '../llm/types';
import { Metrics } from '../metrics';
import { DEFAULT_SETTINGS } from '../settings';
import { Store } from '../store/store';
import type { Item, SelectionPayload } from '../types';
import { ask, buildAskPrompt, noteLabel, noteLabels } from './ask';
import { contextWindow } from './context';
import { SaveService, type SelectionItemData } from './save';

const require = createRequire(import.meta.url);
const vecExtensionPath = (require('sqlite-vec') as { getLoadablePath(): string }).getLoadablePath();

function selection(over: Partial<SelectionPayload> = {}): SelectionPayload {
  return {
    text: 'Sam said the Acme launch moves to Friday.',
    context_before: 'Earlier: ',
    context_after: ' Later.',
    source_app: 'slack.exe',
    window_title: '#launch | Acme - Slack',
    captured_at: '2026-10-09T10:00:00-04:00',
    method: 'uia',
    trigger: 'auto',
    is_editable: false,
    foreground_handle: 42,
    ...over,
  };
}

function item(over: Partial<Item> = {}): Item {
  return {
    id: 'i1',
    collection_id: null,
    kind: 'selection',
    text: 'Acme pricing is $40 per seat.',
    why: null,
    source_app: null,
    window_title: null,
    data_json: null,
    created_at: '2026-09-18T12:00:00-04:00',
    ...over,
  };
}

class FakeLlm implements LlmProvider {
  calls: ChatRequest[] = [];
  constructor(
    private readonly answer: (req: ChatRequest) => unknown = () => ({ entities: [] }),
    private readonly has = true,
  ) {}
  stream(req: ChatRequest) {
    this.calls.push(req);
    async function* gen() {
      yield 'Hello';
      yield ' world';
    }
    return { textStream: gen(), model: Promise.resolve('groq:test') };
  }
  async structured<T>(req: ChatRequest, schema: z.ZodType<T>): Promise<T> {
    this.calls.push(req);
    if (req.signal?.aborted) throw new LlmError('aborted', 'Cancelled');
    return schema.parse(await this.answer(req));
  }
  hasModel() {
    return this.has;
  }
}

function fakeEmbedder(dims = 4): Embedder & { texts: string[] } {
  const texts: string[] = [];
  return {
    model: 'fake',
    dims,
    texts,
    async embed(input) {
      texts.push(...input);
      return input.map(() => {
        const v = new Float32Array(dims);
        v[0] = 1;
        return v;
      });
    },
  };
}

describe('contextWindow', () => {
  it('returns everything when it fits', () => {
    const w = contextWindow(selection(), null, 1000);
    expect(w.source).toBe('tier1');
    expect(w.text.slice(w.selection_start, w.selection_start + w.selection_length)).toBe(selection().text);
  });

  it('centers on the selection and shifts when one side runs out', () => {
    const text = 'x'.repeat(10) + 'SEL' + 'y'.repeat(100);
    const w = contextWindow(selection({ text: 'SEL', context_before: '', context_after: '' }), {
      text,
      selection_start: 10,
      selection_length: 3,
      source: 'container',
    }, 23);
    expect(w).toEqual({ text: 'x'.repeat(10) + 'SEL' + 'y'.repeat(10), selection_start: 10, selection_length: 3, source: 'container' });

    const mid = contextWindow(selection({ text: 'SEL', context_before: 'a'.repeat(50), context_after: 'b'.repeat(50) }), null, 13);
    expect(mid.text).toBe('aaaaaSELbbbbb');
  });

  it('cuts a selection longer than the limit', () => {
    const w = contextWindow(selection({ text: 'abcdefghij' }), null, 4);
    expect(w).toMatchObject({ text: 'abcd', selection_start: 0, selection_length: 4 });
  });
});

describe('Ask', () => {
  it('uses the default question and labels sections', () => {
    const { question, prompt } = buildAskPrompt(DEFAULT_SETTINGS, { selection: selection(), question: '   ' });
    expect(question).toBe('Explain this briefly.');
    expect(prompt).toContain('## Question\nExplain this briefly.');
    expect(prompt).toContain('<selection>\nSam said the Acme launch moves to Friday.\n</selection>');
    expect(prompt).toContain('Earlier: [SELECTION] Later.');
    expect(prompt).not.toContain('Saved notes');
  });

  it('prefers tier-2 context and cites saved notes by label', () => {
    const container = { text: 'Thread start. Sam said the Acme launch moves to Friday. Thread end.', selection_start: 14, selection_length: 41, source: 'container' as const };
    const { prompt } = buildAskPrompt(DEFAULT_SETTINGS, {
      selection: selection(),
      container,
      question: 'When is launch?',
      related: [item(), item({ id: 'i2', text: 'Second', why: 'pricing' })],
    });
    expect(prompt).toContain('Thread start. [SELECTION] Thread end.');
    expect(prompt).not.toContain('Earlier:');
    expect(prompt).toContain('<note label="From your note, Sep 18">');
    expect(prompt).toContain('<note label="From your note, Sep 18 (2)">');
    expect(prompt).toContain('Why it was saved: pricing');
  });

  it('says who is asking, so a message is not read as their own', () => {
    const anon = buildAskPrompt(DEFAULT_SETTINGS, { selection: selection() }).prompt;
    expect(anon).toContain('## The person asking\nUnknown. They are reading the selection');
    const settings = { ...DEFAULT_SETTINGS, identity: { name: 'Rayan Kaissi', emails: ['Rayan@Example.com'], handles: ['@rayan'] } };
    const { prompt } = buildAskPrompt(settings, { selection: selection() });
    expect(prompt).toContain('## The person asking\nRayan Kaissi (also: rayan@example.com, @rayan). They are reading the selection; they did not write it');
  });

  it('labels notes by short date', () => {
    expect(noteLabel(item({ created_at: '2026-01-05T09:00:00-05:00' }))).toBe('From your note, Jan 5');
    expect(noteLabels([item(), item({ created_at: '2026-09-19T12:00:00-04:00' })])).toEqual([
      'From your note, Sep 18',
      'From your note, Sep 19',
    ]);
  });

  it('streams on the chat role with action ask', async () => {
    const llm = new FakeLlm();
    const res = ask(llm, DEFAULT_SETTINGS, { selection: selection() });
    let out = '';
    for await (const t of res.textStream) out += t;
    expect(out).toBe('Hello world');
    expect(llm.calls[0]).toMatchObject({ role: 'chat', action: 'ask' });
  });
});

describe('SaveService', () => {
  let store: Store;
  afterEach(() => store?.close());

  function setup(opts: { llm?: FakeLlm; embedder?: Embedder | null; now?: () => number } = {}) {
    store = new Store(':memory:', { vecExtensionPath });
    store.ensureVectorModel('fake', 4);
    const llm = opts.llm ?? new FakeLlm();
    const embedder = opts.embedder === undefined ? fakeEmbedder() : opts.embedder;
    const metrics = new Metrics(store);
    const svc = new SaveService({ store, llm, embedder: () => embedder, settings: () => DEFAULT_SETTINGS, metrics, now: opts.now });
    return { svc, llm, embedder };
  }

  it('inserts at once with an excerpt, then embeds and links entities', async () => {
    const llm = new FakeLlm(() => ({
      entities: [
        { kind: 'person', name: 'Sam' },
        { kind: 'company', name: 'Acme' },
        { kind: 'company', name: 'acme' },
        { kind: 'other', name: ' ' },
      ],
    }));
    const { svc } = setup({ llm });
    store.db.prepare("INSERT INTO people (id, name, created_at, updated_at) VALUES ('p1', 'Sam Lee', 'x', 'x')").run();
    store.db.prepare("INSERT INTO person_aliases (person_id, kind, value) VALUES ('p1', 'name', 'Sam')").run();

    const { item: saved, undoUntil, enriched } = svc.save({ selection: selection(), collection: 'Reading', why: '  launch   date ' });
    expect(store.getItem(saved.id)?.text).toBe(selection().text);
    expect(saved.why).toBe('launch date');
    expect(saved.collection_id).toBe(store.collectionByName('Reading')!.id);
    expect(undoUntil).toBeGreaterThan(Date.now());
    const data = JSON.parse(saved.data_json!) as SelectionItemData;
    expect(data).toMatchObject({ method: 'uia', trigger: 'auto', captured_at: selection().captured_at, is_editable: false });
    expect(data.excerpt.text).toBe('Earlier: Sam said the Acme launch moves to Friday. Later.');

    expect(await enriched).toEqual({ embedded: true, entities: 2, cancelled: false });
    expect(store.itemsWithoutVectors()).toHaveLength(0);
    expect(store.entitiesForItem(saved.id).map((e) => `${e.kind}:${e.display}`)).toEqual(['company:Acme', 'person:Sam']);
    const person = store.db.prepare("SELECT entity_id FROM people WHERE id = 'p1'").get() as { entity_id: string };
    expect(store.entitiesForItem(saved.id).find((e) => e.kind === 'person')!.id).toBe(person.entity_id);
    expect(llm.calls[0]).toMatchObject({ role: 'fast', action: 'save_entities' });
  });

  it('reuses the entity already linked to a matched person', async () => {
    const llm = new FakeLlm(() => ({ entities: [{ kind: 'person', name: 'Sam Lee' }] }));
    const { svc } = setup({ llm });
    const existing = store.upsertEntity('person', 'Samuel Lee');
    store.db.prepare("INSERT INTO people (id, entity_id, name, created_at, updated_at) VALUES ('p1', ?, 'Sam Lee', 'x', 'x')").run(existing);
    const { item: saved, enriched } = svc.save({ selection: selection(), collection: 'Notes' });
    await enriched;
    expect(store.entitiesForItem(saved.id).map((e) => e.id)).toEqual([existing]);
  });

  it('saves and embeds but skips entities, with no error event, when Local only refuses the call', async () => {
    const llm = new FakeLlm(() => {
      throw new LlmError('local_only', 'Local only is on');
    });
    const { svc } = setup({ llm });
    const { item: saved, enriched } = svc.save({ selection: selection(), collection: 'Notes' });
    expect(await enriched).toEqual({ embedded: true, entities: 0, entitiesSkipped: 'local_only', cancelled: false });
    expect(store.getItem(saved.id)).not.toBeNull();
    expect(store.itemsWithoutVectors()).toHaveLength(0);
    expect(store.entitiesForItem(saved.id)).toEqual([]);
    expect(store.listEvents().map((e) => e.kind)).toEqual(['save_done']);
  });

  it('creates a missing collection', () => {
    const { svc } = setup();
    const { item: saved } = svc.save({ selection: selection(), collection: 'Recipes' });
    expect(store.collectionByName('Recipes')?.id).toBe(saved.collection_id);
  });

  it('undoes within the window and not after', async () => {
    let t = 1_000_000;
    const { svc } = setup({ now: () => t });
    const a = svc.save({ selection: selection(), collection: 'Notes' });
    t += 10_500;
    expect(svc.undo(a.item.id)).toBe(true);
    expect(store.getItem(a.item.id)).toBeNull();
    expect(svc.undo(a.item.id)).toBe(false);

    const b = svc.save({ selection: selection(), collection: 'Notes' });
    t += 12_000;
    expect(svc.undo(b.item.id)).toBe(false);
    expect(store.getItem(b.item.id)).not.toBeNull();
    await svc.idle();
    expect(store.listEvents().map((e) => e.kind)).toEqual(['save_done', 'save_undone', 'save_done']);
  });

  it('leaves no vector or entities behind when undone mid-enrichment', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const llm = new FakeLlm(async () => {
      await gate;
      return { entities: [{ kind: 'company', name: 'Acme' }] };
    });
    const { svc } = setup({ llm });
    const { item: saved, enriched } = svc.save({ selection: selection(), collection: 'Notes' });
    await new Promise((r) => setTimeout(r, 0));
    expect(svc.undo(saved.id)).toBe(true);
    release();
    expect((await enriched).cancelled).toBe(true);
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM item_vectors').get()).toEqual({ n: 0 });
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM entities').get()).toEqual({ n: 0 });
  });

  it('skips what is not set up and logs errors without text', async () => {
    const llm = new FakeLlm(() => {
      throw new LlmError('provider', 'Sam said something secret', 500);
    });
    const { svc } = setup({ llm, embedder: null });
    const { enriched } = svc.save({ selection: selection(), collection: 'Notes' });
    expect(await enriched).toEqual({ embedded: false, entities: 0, cancelled: false });
    const err = store.listEvents().find((e) => e.kind === 'save_enrich_error')!;
    expect(err.payload).toEqual({ stage: 'entities', code: 'provider' });
    expect(JSON.stringify(store.listEvents())).not.toContain('Sam');

    const noModel = setup({ llm: new FakeLlm(undefined, false) });
    await noModel.svc.save({ selection: selection(), collection: 'Notes' }).enriched;
    expect(noModel.llm.calls).toHaveLength(0);
  });

  it('sets why and re-embeds with it', async () => {
    const embedder = fakeEmbedder();
    const { svc } = setup({ embedder });
    const { item: saved } = svc.save({ selection: selection(), collection: 'Notes' });
    expect(await svc.setWhy(saved.id, 'for the launch post')).toBe(true);
    expect(store.getItem(saved.id)?.why).toBe('for the launch post');
    expect(embedder.texts.at(-1)).toBe(`${selection().text}\nfor the launch post`);
    expect(await svc.setWhy('missing', 'x')).toBe(false);
  });
});
