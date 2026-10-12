import { describe, expect, it } from 'vitest';
import {
  allPreferences,
  draftTraits,
  editRatio,
  isMeaningfulEdit,
  measuredChanges,
  pickSignals,
  WROTE_OWN,
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
    expect(draftTraits(short)).toMatchObject({ words: 5, greeting: false, signoff: false, exclamation: false, emoji: false, contractions: false });
    expect(draftTraits(medium)).toMatchObject({ greeting: true, signoff: true, contractions: true, exclamation: false });
    expect(draftTraits('Hey! Love it 🎉')).toMatchObject({ greeting: true, exclamation: true, emoji: true, signoff: false });
    expect(draftTraits('On it.\n- A')).toMatchObject({ signoff: true });
  });

  it('reads capitalization, the final period, and apostrophes', () => {
    expect(draftTraits('Sounds good. See you then.')).toMatchObject({ capitals: true, end_period: true });
    expect(draftTraits('sounds good, i think we can do friday')).toMatchObject({ capitals: false, end_period: false });
    expect(draftTraits('Can you send it?')).toMatchObject({ end_period: null });
    expect(draftTraits('42 is the number')).toMatchObject({ capitals: null });
    expect(draftTraits("I don't know yet.")).toMatchObject({ contractions: true, apostrophes: true });
    expect(draftTraits('i dont know yet')).toMatchObject({ contractions: true, apostrophes: false });
    expect(draftTraits('I do not know yet.')).toMatchObject({ contractions: false, apostrophes: null });
  });

  it('reads the body without the greeting line and sign-off', () => {
    // Email: the body ends on a period even though the message ends on a name.
    expect(draftTraits(medium)).toMatchObject({ end_period: true, line_breaks: false, dashes: false });
    expect(draftTraits('Hi Jordan,\n\nYes, Friday works.\n\nI will bring the slides.\n\nBest,\nAlex')).toMatchObject({ line_breaks: true });
    expect(draftTraits('Friday works — I will bring them.')).toMatchObject({ dashes: true });
    expect(draftTraits('Friday works - see you.')).toMatchObject({ dashes: true });
    expect(draftTraits('Okay...')).toMatchObject({ ellipsis: true, end_period: null });
  });

  it('measures sentence length, word length, and punctuation', () => {
    const t = draftTraits('Yes. Friday works for me. See you.');
    expect(t.sentenceWords).toBe(2.3);
    expect(draftTraits('yes ok').wordLetters).toBe(2.5);
    expect(draftTraits('Yes, absolutely; Friday works: see you!').punctuation).toBeGreaterThan(draftTraits('yes friday works see you').punctuation);
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
    expect(s.find((x) => x.dimension === 'emoji')).toBeUndefined();
  });

  it('never reads a pick as a choice against something the draft had no place for (decision 49)', () => {
    // The short draft has no greeting, contraction, or exclamation mark; picking it says nothing about them.
    const drafts = [d('sure, saturday works'), d("Hi Jordan! Yes, I'm around on Saturday afternoon."), d("Sounds great, I'll be there!")];
    const s = pickSignals({ drafts, chosen: 0, final: 'sure, saturday works' });
    expect(s.map((x) => x.dimension)).not.toContain('greeting');
    expect(s.map((x) => x.dimension)).not.toContain('exclamation');
    expect(s.map((x) => x.dimension)).not.toContain('contractions');
    // Choices every draft makes still count.
    expect(s).toContainEqual({ dimension: 'capitals', pole: 'without', weight: 1 });
  });

  it('reads "Im" for "I’m" as dropping the apostrophe, never as dropping contractions', () => {
    const s = pickSignals({ drafts: [d('sure, I’m around saturday afternoon')], chosen: 0, final: 'sure Im around saturday' });
    expect(s).toContainEqual({ dimension: 'apostrophes', pole: 'without', weight: 2 });
    expect(s.map((x) => x.dimension)).not.toContain('contractions');
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

  it('reads capitalization, punctuation, and apostrophes from an edit', () => {
    const drafts = [d("Sure, I'll send it over by Friday."), d('No problem, it will be there by Friday.')];
    const s = pickSignals({ drafts, chosen: 0, final: 'sure ill send it over by friday' });
    expect(s).toContainEqual({ dimension: 'capitals', pole: 'without', weight: 2 });
    expect(s).toContainEqual({ dimension: 'end_period', pole: 'without', weight: 2 });
    expect(s).toContainEqual({ dimension: 'punctuation', pole: 'lighter', weight: 2 });
    // "ill" is also a word, so it doesn't count as a contraction without its apostrophe.
    expect(s.find((x) => x.dimension === 'apostrophes')).toBeUndefined();
    const t = pickSignals({ drafts, chosen: 0, final: "Sure, I'll send it — by Friday." });
    expect(t).toContainEqual({ dimension: 'dashes', pole: 'with', weight: 2 });
    expect(pickSignals({ drafts, chosen: 0, final: 'Sure, Im on it, dont worry.' })).toContainEqual({ dimension: 'apostrophes', pole: 'without', weight: 2 });
  });

  it('learns from a reply the user wrote themselves only what every draft got wrong', () => {
    const drafts = [d('Hi Maya, thanks so much! I will send it by Friday.'), d('Hi Maya, sure thing. It will be with you by Friday.'), d('Thanks Maya. Sending it Friday.')];
    const s = pickSignals({ drafts, chosen: WROTE_OWN, final: 'yep friday' });
    expect(s).toContainEqual({ dimension: 'capitals', pole: 'without', weight: 2 });
    expect(s).toContainEqual({ dimension: 'end_period', pole: 'without', weight: 2 });
    expect(s).toContainEqual({ dimension: 'length', pole: 'shorter', weight: 2 });
    // Two drafts had a greeting and one didn't, so the greeting says nothing.
    expect(s.find((x) => x.dimension === 'greeting')).toBeUndefined();
    expect(s.find((x) => x.dimension === 'kind' || x.dimension === 'tone')).toBeUndefined();
  });

  it('describes an edit in measured terms for the style notes', () => {
    expect(measuredChanges('Hi Jordan,\n\nThat works for me. See you Friday.\n\nBest,\nAlex', 'that works, see you friday')).toEqual(
      expect.arrayContaining(['words 11 → 5', 'Skips the greeting', 'Skips the sign-off', 'Writes in lowercase', 'Leaves off the final period']),
    );
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
