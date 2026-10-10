import { describe, expect, it } from 'vitest';
import {
  allPreferences,
  draftTraits,
  editRatio,
  isMeaningfulEdit,
  pickSignals,
  preferenceLine,
  preferencesFor,
  replyChannel,
  type StyleSignal,
  type StyleSignalRow,
} from './reply-style';

const short = 'Sounds good, see you Friday.';
const d = (text: string, kind?: string, tone?: string) => ({ text, kind, tone });
const medium = "Hi Jordan,\n\nThat works for me. I'll bring the slides on Friday and we can go through them together.\n\nBest,\nAlex";
const long =
  'Hi Jordan,\n\nThanks for the note! Friday works well for me. I will bring the slides from the review and a short summary of the open questions, so we can go through them together and decide on next steps.\n\nBest regards,\nAlex';

describe('replyChannel', () => {
  it('groups apps by kind of platform: email, messaging, and work chat', () => {
    expect(replyChannel('chrome.exe', 'Inbox (3) - alex.morgan@example.com - Gmail')).toBe('email');
    expect(replyChannel('msedge.exe', 'Mail - Alex Morgan - Outlook')).toBe('email');
    expect(replyChannel('olk.exe', 'Mail')).toBe('email');
    expect(replyChannel('chrome.exe', 'Inbox - Yahoo Mail')).toBe('email');
    expect(replyChannel('slack.exe', 'design')).toBe('work_chat');
    expect(replyChannel('ms-teams.exe', 'Chat | Microsoft Teams')).toBe('work_chat');
    expect(replyChannel('chrome.exe', 'Discord | #general')).toBe('messaging');
    expect(replyChannel('whatsapp.root.exe', 'WhatsApp')).toBe('messaging');
    expect(replyChannel('notepad.exe', 'notes.txt')).toBe('other');
  });
});

describe('draftTraits', () => {
  it('reads length, greeting, sign-off, exclamation marks, emoji, and contractions', () => {
    expect(draftTraits(short)).toEqual({ words: 5, greeting: false, signoff: false, exclamation: false, emoji: false, contractions: false });
    expect(draftTraits(medium)).toMatchObject({ greeting: true, signoff: true, contractions: true, exclamation: false });
    expect(draftTraits('Hey! Love it 🎉')).toMatchObject({ greeting: true, exclamation: true, emoji: true, signoff: false });
    expect(draftTraits('On it.\n- A')).toMatchObject({ signoff: true });
  });
});

describe('editRatio', () => {
  it('measures the share of words changed', () => {
    expect(editRatio('a b c d', 'a b c d')).toBe(0);
    expect(editRatio('a b c d', 'a x c d')).toBe(0.25);
    expect(isMeaningfulEdit(medium, medium.replace('Jordan', 'Jordan,'))).toBe(false);
    expect(isMeaningfulEdit(medium, short)).toBe(true);
  });
});

describe('pickSignals', () => {
  it('counts a pick only on traits where the drafts differ', () => {
    const s = pickSignals({ drafts: [d(short), d(medium), d(long)], chosen: 0, final: short });
    expect(s).toContainEqual({ dimension: 'length', pole: 'shorter', weight: 1 });
    expect(s).toContainEqual({ dimension: 'greeting', pole: 'without', weight: 1 });
    expect(s.find((x) => x.dimension === 'emoji')).toBeUndefined();
  });

  it('counts an edit twice and lets it replace the pick', () => {
    const final = medium.replace('Hi Jordan,\n\n', '');
    const s = pickSignals({ drafts: [d(short), d(medium), d(long)], chosen: 1, final });
    expect(s).toContainEqual({ dimension: 'greeting', pole: 'without', weight: 2 });
    expect(s.filter((x) => x.dimension === 'greeting')).toHaveLength(1);
  });

  it('reads a cut by more than 15% as wanting it shorter', () => {
    const s = pickSignals({ drafts: [d(short), d(long)], chosen: 1, final: 'Hi Jordan,\n\nFriday works. I will bring the slides.\n\nBest regards,\nAlex' });
    expect(s).toContainEqual({ dimension: 'length', pole: 'shorter', weight: 2 });
  });

  it("counts the model's kind and tone tags when the drafts differ, and ignores unknown tags", () => {
    const drafts = [d('Haha, sounds like a legend', 'acknowledge', 'playful'), d('Who is that?', 'ask', 'neutral'), d('Anyway, any news?', 'shift', 'neutral')];
    const s = pickSignals({ drafts, chosen: 0, final: drafts[0]!.text });
    expect(s).toContainEqual({ dimension: 'kind', pole: 'acknowledge', weight: 1 });
    expect(s).toContainEqual({ dimension: 'tone', pole: 'playful', weight: 1 });
    const same = pickSignals({ drafts: [d('a b', 'ask', 'warm'), d('c d', 'ask', 'warm')], chosen: 0, final: 'a b' });
    expect(same.filter((x) => x.dimension === 'kind' || x.dimension === 'tone')).toEqual([]);
    expect(pickSignals({ drafts: [d('a', 'gossip'), d('b', 'ask')], chosen: 0, final: 'a' }).find((x) => x.dimension === 'kind')).toBeUndefined();
  });
});

const rows = (signals: StyleSignal[], over: Partial<StyleSignalRow> = {}, startDay = 1): StyleSignalRow[] =>
  signals.map((s, i) => ({ ...s, channel: 'email', person_id: null, relationship: null, at: `2026-10-${String(startDay + i).padStart(2, '0')}T12:00:00-04:00`, ...over }));
const shorter = (n: number): StyleSignal[] => Array.from({ length: n }, () => ({ dimension: 'length', pole: 'shorter', weight: 1 }));
const longer = (n: number): StyleSignal[] => Array.from({ length: n }, () => ({ dimension: 'length', pole: 'longer', weight: 1 }));

describe('preferencesFor', () => {
  it('needs several agreeing picks; one pick is not a preference', () => {
    expect(preferencesFor(rows(shorter(1)), { channel: 'email', personId: null, relationship: null })).toEqual([]);
    expect(preferencesFor(rows(shorter(4)), { channel: 'email', personId: null, relationship: null })).toEqual([]);
    const p = preferencesFor(rows(shorter(5)), { channel: 'email', personId: null, relationship: null });
    expect(p).toEqual([{ dimension: 'length', pole: 'shorter', scope: 'channel', channel: 'email', relationship: null, personId: null, agree: 5, of: 5 }]);
    expect(preferenceLine(p[0]!)).toBe('Keeps replies short (5 of the last 5 picks in email)');
  });

  it('does not flip on one long reply, and a new habit takes over as old picks age', () => {
    const base = rows(shorter(8));
    const oneLong = [...base, ...rows(longer(1), {}, 9)];
    expect(preferencesFor(oneLong, { channel: 'email', personId: null, relationship: null })[0]?.pole).toBe('shorter');
    const mixed = [...base, ...rows(longer(4), {}, 9)];
    expect(preferencesFor(mixed, { channel: 'email', personId: null, relationship: null })).toEqual([]);
    const switched = [...base, ...rows(longer(10), {}, 9)];
    expect(preferencesFor(switched, { channel: 'email', personId: null, relationship: null })[0]?.pole).toBe('longer');
  });

  it('keeps platforms apart, and a person with enough picks wins over the platform', () => {
    const data = [...rows(shorter(6)), ...rows(longer(3), { person_id: 'p1', channel: 'other' }, 10), ...rows(longer(6), { channel: 'messaging' }, 20)];
    const to = (channel: StyleSignalRow['channel'], personId: string | null) => ({ channel, personId, relationship: null });
    expect(preferencesFor(data, to('messaging', null))[0]).toMatchObject({ pole: 'longer', scope: 'channel', channel: 'messaging' });
    expect(preferencesFor(data, to('email', 'p1'))[0]).toMatchObject({ pole: 'longer', scope: 'person', personId: 'p1' });
    expect(preferencesFor(data, to('email', 'p2'))[0]).toMatchObject({ pole: 'shorter', scope: 'channel' });
    expect(allPreferences(data).map((p) => `${p.scope}:${p.channel ?? p.personId}:${p.pole}`)).toEqual(['channel:email:shorter', 'channel:messaging:longer', 'person:p1:longer']);
  });

  it('learns per relationship on a platform, from replies to several people', () => {
    // Short replies to friends in messaging (spread over people), longer ones to colleagues there.
    const friends = rows(shorter(5), { channel: 'messaging', relationship: 'friend', person_id: 'f1' });
    friends.forEach((r, i) => (r.person_id = `f${i % 3}`));
    const colleagues = rows(longer(5), { channel: 'messaging', relationship: 'colleague', person_id: 'c1' }, 10);
    const data = [...friends, ...colleagues];
    const pref = preferencesFor(data, { channel: 'messaging', personId: 'f9', relationship: 'friend' })[0]!;
    expect(pref).toMatchObject({ scope: 'group', relationship: 'friend', channel: 'messaging', pole: 'shorter' });
    expect(preferenceLine(pref)).toBe('Keeps replies short (5 of the last 5 picks with friends in messaging apps)');
    // The platform as a whole is split, so nothing is learned for someone with no relationship set.
    expect(preferencesFor(data, { channel: 'messaging', personId: null, relationship: null })).toEqual([]);
    // A person with enough of their own picks still wins.
    expect(preferencesFor(data, { channel: 'messaging', personId: 'c1', relationship: 'colleague' })[0]).toMatchObject({ scope: 'person', pole: 'longer' });
    expect(allPreferences(data).map((p) => `${p.scope}:${p.relationship ?? p.personId}:${p.pole}`)).toEqual([
      'group:friend:shorter',
      'group:colleague:longer',
      'person:c1:longer',
    ]);
  });
});
