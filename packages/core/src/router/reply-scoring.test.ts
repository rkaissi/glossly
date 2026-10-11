// Reply's scoring for automated mail (Step 4's remaining misses) and the user's own messages.
// Rules only, so it runs offline; the full router eval stays in `pnpm eval`.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_COLLECTIONS, DEFAULT_SETTINGS } from '../settings';
import { extractFeatures } from './features';
import { decideByRules } from './rules';
import { assignSlots, scoreActions } from './slots';
import type { Decisions, SelectionContext } from './types';

interface Fixture {
  id: string;
  context: SelectionContext;
  expected: { content_type: string; slots: string[] };
}

const load = (name: string): Fixture[] => {
  const raw = JSON.parse(readFileSync(new URL(`../../../../fixtures/${name}.json`, import.meta.url), 'utf8')) as Fixture[] | { cases: Fixture[] };
  return Array.isArray(raw) ? raw : raw.cases;
};
const cases = ['messages', 'commitments', 'tables', 'articles', 'code', 'contacts'].flatMap(load);

const ctx = (over: Partial<SelectionContext>): SelectionContext => ({
  text: '',
  context_before: '',
  context_after: '',
  source_app: 'slack.exe',
  window_title: '',
  is_editable: false,
  ...over,
});

describe('Reply scoring', () => {
  it.each(cases.map((c) => [c.id, c] as const))('%s offers Reply only where expected', (_id, c) => {
    const f = extractFeatures(c.context);
    const d = decideByRules({ context: c.context, features: f, collections: [...DEFAULT_COLLECTIONS] });
    const s = assignSlots(d, f, DEFAULT_SETTINGS.router);
    const shown = [s.slot3, s.slot4].some((x) => x?.action === 'reply');
    expect(shown).toBe(c.expected.slots.includes('reply'));
  });

  it('flags automated and broadcast mail', () => {
    const auto = (text: string, window_title = '') => extractFeatures(ctx({ text, window_title, source_app: 'olk.exe' })).automated;
    expect(auto('Your order #A-1 has shipped and should arrive Friday.')).toBe(true);
    expect(auto('Your one-time passcode expires in 10 minutes.')).toBe(true);
    expect(auto('Hi all, a reminder that the office is closed Monday.')).toBe(true);
    expect(auto('Please do not reply to this email.')).toBe(true);
    expect(auto('hello', 'Sign-in attempt - Gmail')).toBe(true);
    expect(auto("Hey team, I'm out sick today, ping Ravi for anything urgent.")).toBe(false);
    expect(auto('Can you send the deck before Friday?')).toBe(false);
  });

  it('drops Reply for the user’s own message, even when the model says otherwise', () => {
    const me = { name: 'Alex Morgan', emails: [], handles: [] };
    const c = ctx({ context_before: 'Alex Morgan  9:41 AM\n', text: "I'll send the slides before Friday, ok?" });
    const f = extractFeatures(c, [], me);
    expect(f.authorIsMe).toBe(true);
    expect(extractFeatures(c).authorIsMe).toBe(false);
    const model: Decisions = {
      content_type: 'single_message',
      authored_by_other: 0.9,
      mentions_people: 0.1,
      contains_commitment: 0.8,
      best_collection: 'Notes',
      provider: 'llm_structured',
    };
    expect(scoreActions(model, f).reply).toBe(0);
    expect(scoreActions(model, extractFeatures(c)).reply).toBe(0.9);
  });

  it("offers Reply and Who is this on someone else's chat message the model reads as a bare question (decision 45)", () => {
    const me = { name: 'Alex Morgan', emails: [], handles: [] };
    const c = ctx({
      source_app: 'discord.exe',
      window_title: 'Discord',
      context_before: 'Alex\n8/31/26, 9:10 PM\nim in the city for work rn\nJordanZ2\nGEN2\n7:02 PM\n',
      text: 'what kinda job are you doing currently?',
    });
    const f = extractFeatures(c, [], me);
    const model: Decisions = { content_type: 'question', authored_by_other: 0.3, mentions_people: 0.05, contains_commitment: 0.05, best_collection: 'Notes', provider: 'llm_structured' };
    const s = assignSlots(model, f, DEFAULT_SETTINGS.router);
    expect([s.slot3?.action, s.slot4?.action]).toEqual(['reply', 'who']);
    // Not in a text field (a draft), and not the user's own message.
    expect(scoreActions(model, extractFeatures({ ...c, is_editable: true }, [], me)).reply).toBe(0);
    const mine = extractFeatures({ ...c, context_before: 'Alex Morgan  9:41 AM\n' }, [], me);
    expect(scoreActions({ ...model, content_type: 'single_message' }, mine).reply).toBe(0);
  });
});
