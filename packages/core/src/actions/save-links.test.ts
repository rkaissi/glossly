import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import { syncContext } from '../context/sync';
import type { Embedder } from '../embed/types';
import type { DetectedPerson } from '../people/detect';
import { DEFAULT_SETTINGS } from '../settings';
import { CalendarRepo } from '../store/calendar';
import { PeopleRepo } from '../store/people';
import { Store } from '../store/store';
import { isoNow } from '../types';
import { extractUrls, isLinkText } from './save';
import { saveOpen } from './save-links';

const require = createRequire(import.meta.url);
const vecExtensionPath = (require('sqlite-vec') as { getLoadablePath(): string }).getLoadablePath();

let store: Store | null = null;
afterEach(() => {
  store?.close();
  store = null;
});

describe('extractUrls and isLinkText (decision 84)', () => {
  it('finds http(s) and www. addresses in order, once each, without trailing punctuation', () => {
    expect(extractUrls('See https://acme.example.com/a?b=1, then www.northwind.example.com/x. And https://acme.example.com/a?b=1 again!')).toEqual([
      'https://acme.example.com/a?b=1',
      'https://www.northwind.example.com/x',
    ]);
    expect(extractUrls('(https://docs.example.com/d/1)')).toEqual(['https://docs.example.com/d/1']);
    expect(extractUrls('no links, just example.com and http://intranet/wiki')).toEqual([]);
    expect(extractUrls('local http://localhost:3000/app')).toEqual(['http://localhost:3000/app']);
  });

  it('calls a selection a link only when it is one address and nothing else', () => {
    expect(isLinkText(' https://acme.example.com/blog/design-reviews ')).toBe(true);
    expect(isLinkText('www.acme.example.com.')).toBe(true);
    expect(isLinkText('read https://acme.example.com')).toBe(false);
    expect(isLinkText('https://a.example.com https://b.example.com')).toBe(false);
    expect(isLinkText('acme.example.com')).toBe(false);
  });
});

/** "deck" and "lunch" texts share a direction; any other text gets its own. */
const TOPICS = ['deck', 'lunch'];
const DIMS = 32;
const own = (t: string) => TOPICS.length + ([...t].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % (DIMS - TOPICS.length));
const embedder: Embedder = {
  model: 'fake',
  dims: DIMS,
  embed: async (texts) =>
    texts.map((t) => {
      const v = new Float32Array(DIMS);
      const i = TOPICS.findIndex((w) => t.toLowerCase().includes(w));
      v[i < 0 ? own(t) : i] = 1;
      return v;
    }),
};

function setup() {
  store = new Store(':memory:', { vecExtensionPath });
  store.ensureVectorModel('fake', DIMS);
  const people = new PeopleRepo(store);
  const calendar = new CalendarRepo(store);
  const deps = {
    store,
    people,
    calendar,
    embedder: () => embedder,
    settings: () => ({ recall: DEFAULT_SETTINGS.recall, context: DEFAULT_SETTINGS.context }),
    sync: () => syncContext({ store: store!, embedder: () => embedder }),
  };
  return { people, calendar, deps };
}

const inDays = (n: number, h = 13) => {
  const d = new Date();
  return isoNow(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, h));
};
const unknown = (name: string, email: string | null = null): DetectedPerson => ({ name, email, handle: null, role: 'mentioned', knownId: null });

describe('saveOpen (decision 84)', () => {
  it('links saved people named in the text and tasks and events close in meaning, and offers the rest', async () => {
    const { people, calendar, deps } = setup();
    const jordan = people.create({ name: 'Jordan Hale' });
    const task = people.addCommitment({ person_id: jordan.id, owner: 'me', text: 'Send the deck to Jordan', due_at: null });
    people.addCommitment({ person_id: jordan.id, owner: 'me', text: 'Book the flights', due_at: null });
    const lunch = calendar.add({ title: 'Lunch with Jordan', starts_at: inDays(2), ends_at: inDays(2, 14), all_day: false, location: null, attendees: [], personIds: [jordan.id] }, null);

    const deck = await saveOpen(deps, {
      text: 'Jordan Hale: the deck is ready. Casey Lin will review it.',
      detected: [unknown('Casey Lin')],
      commitment: 0.7,
      hasDateWord: false,
    });
    // The other open task with Jordan isn't linked: it's theirs, but not about this text.
    expect(deck).toEqual({
      kind: 'selection',
      links: [
        { kind: 'person', id: jordan.id, label: 'Jordan Hale' },
        { kind: 'task', id: task.id, label: 'Send the deck to Jordan' },
      ],
      addPerson: 'Casey Lin',
      addTask: true,
    });

    const meal = await saveOpen(deps, { text: 'Lunch spot: the noodle bar on 5th', detected: [], commitment: 0.1, hasDateWord: false });
    expect(meal.links).toEqual([{ kind: 'event', id: lunch.id, label: 'Lunch with Jordan' }]);
  });

  it('offers nothing for a lone first name or a plain note, and calls an address a Link', async () => {
    const { deps } = setup();
    const plain = await saveOpen(deps, { text: 'Remember to water the plants', detected: [unknown('Sam')], commitment: 0.1, hasDateWord: false });
    expect(plain).toEqual({ kind: 'selection', links: [], addPerson: null, addTask: false });
    const link = await saveOpen(deps, { text: 'https://acme.example.com/pricing', detected: [], commitment: 0, hasDateWord: false });
    expect(link.kind).toBe('link');
    const dated = await saveOpen(deps, { text: 'Offsite on Friday', detected: [unknown('Alex Morgan', 'alex@example.com')], commitment: 0.2, hasDateWord: true });
    expect(dated).toMatchObject({ addPerson: 'Alex Morgan', addTask: true });
  });
});
