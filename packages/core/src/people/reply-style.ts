// What Reply learns from the drafts the user picks and edits, in code: no text is kept for a
// pick, only which way it leaned on a few traits. Code measures length, greeting, sign-off,
// exclamation marks, emoji, contractions, capitalization, the final period, apostrophes,
// dashes, ellipses, line breaks, sentence and word length, and how much punctuation; the
// model tags each draft's kind (acknowledge, ask, shift, ...) and tone (playful, warm, ...).
// An edit is read by comparing the draft before and after. A trait becomes a preference only when recent picks agree,
// so one long reply after a run of short ones changes nothing, and a new habit takes over
// as the old picks age out. It is learned at three levels: the person, the relationship
// (friends, colleagues, ...) on that kind of platform, and the kind of platform.

import { RELATIONSHIP_PLURALS, type Relationship } from './relationship';

/** The kind of platform, not the app: Gmail and Outlook are both email, Discord and WhatsApp messaging, Slack and Teams work chat. */
export type ReplyChannel = 'email' | 'messaging' | 'work_chat' | 'other';
export const REPLY_CHANNELS = ['email', 'messaging', 'work_chat', 'other'] as const satisfies readonly ReplyChannel[];

export const STYLE_DIMENSIONS = [
  'length',
  'greeting',
  'signoff',
  'exclamation',
  'emoji',
  'contractions',
  'capitals',
  'end_period',
  'apostrophes',
  'dashes',
  'ellipsis',
  'line_breaks',
  'sentence_length',
  'word_length',
  'punctuation',
  'kind',
  'tone',
] as const;
export type StyleDimension = (typeof STYLE_DIMENSIONS)[number];

/** What a draft does. The model tags each draft with one (prompts/reply.md); keep the two lists in sync. */
export const REPLY_KINDS = ['acknowledge', 'answer', 'ask', 'agree', 'decline', 'follow_up', 'shift', 'thank', 'update'] as const;
export type ReplyKind = (typeof REPLY_KINDS)[number];
export const REPLY_TONES = ['playful', 'warm', 'neutral', 'direct', 'formal'] as const;
export type ReplyTone = (typeof REPLY_TONES)[number];

/**
 * length, sentence_length, word_length: shorter or longer. punctuation: lighter or heavier.
 * kind and tone: the category. Every other dimension: with or without.
 */
export type StylePole = 'shorter' | 'longer' | 'with' | 'without' | 'lighter' | 'heavier' | ReplyKind | ReplyTone;

/** What the user can ask for when none of the drafts fit ("None of these"). The panel has a label for each. */
export const REPLY_REDO_ASKS = ['shorter', 'longer', 'casual', 'formal', 'different'] as const;
export type ReplyRedoAsk = (typeof REPLY_REDO_ASKS)[number];

export interface ReplyRedo {
  /** The drafts as shown, label and text. */
  passedOn: { intent: string; text: string }[];
  asks: ReplyRedoAsk[];
  /** What the user typed ("say I'm out until Monday"), if anything. */
  note?: string | null;
}

/** A draft as the panel showed it: its text, and the kind and tone the model tagged it with. */
export interface PickDraft {
  text: string;
  kind?: string | null;
  tone?: string | null;
}

export const asKind = (v: unknown): ReplyKind | null => (REPLY_KINDS as readonly unknown[]).includes(v) ? (v as ReplyKind) : null;
export const asTone = (v: unknown): ReplyTone | null => (REPLY_TONES as readonly unknown[]).includes(v) ? (v as ReplyTone) : null;

export interface StyleSignal {
  dimension: StyleDimension;
  pole: StylePole;
  /** 1 for a pick between drafts that differ; 2 for an edit, which shows what the user would send. */
  weight: number;
}

/** A stored signal: where and when it was seen, and the person's relationship as it is now. */
export interface StyleSignalRow extends StyleSignal {
  channel: ReplyChannel;
  person_id: string | null;
  relationship: Relationship | null;
  at: string;
}

export interface StylePreference {
  dimension: StyleDimension;
  pole: StylePole;
  /** The person's own wins, then their relationship on this kind of platform, then the platform. */
  scope: 'person' | 'group' | 'channel';
  channel: ReplyChannel | null;
  relationship: Relationship | null;
  personId: string | null;
  /** Recent signals that agree, out of `of`. */
  agree: number;
  of: number;
}

const EMAIL_PROCESSES = ['outlook.exe', 'olk.exe', 'hxoutlook.exe', 'thunderbird.exe', 'mailspring.exe', 'mailclient.exe'];
const WORK_PROCESSES = ['slack.exe', 'teams.exe', 'ms-teams.exe', 'mattermost.exe', 'zoom.exe'];
const MESSAGING_PROCESSES = ['discord.exe', 'whatsapp.exe', 'whatsapp.root.exe', 'messenger.exe', 'telegram.exe', 'signal.exe'];
// Web mail: Gmail, Outlook (also Hotmail and Live, whose tabs say Outlook), Yahoo, Proton, Fastmail, iCloud, AOL, Zoho.
const EMAIL_TITLES = /(?:- Gmail|- Outlook|Outlook$|Yahoo Mail|Proton Mail|Fastmail|iCloud Mail|AOL Mail|Zoho Mail)\b/i;
const WORK_TITLES = /(?:- Slack|Slack \||Microsoft Teams|Google Chat|Mattermost)\b/i;
const MESSAGING_TITLES = /(?:Discord|WhatsApp|Messenger|Telegram|Instagram|Snapchat)\b/i;

/** The kind of platform: register differs a lot between them, so each learns on its own. */
export function replyChannel(app: string, title: string): ReplyChannel {
  const p = app.toLowerCase();
  if (EMAIL_PROCESSES.includes(p) || EMAIL_TITLES.test(title)) return 'email';
  if (WORK_PROCESSES.includes(p) || WORK_TITLES.test(title)) return 'work_chat';
  if (MESSAGING_PROCESSES.includes(p) || MESSAGING_TITLES.test(title)) return 'messaging';
  return 'other';
}

export interface DraftTraits {
  words: number;
  greeting: boolean;
  signoff: boolean;
  exclamation: boolean;
  emoji: boolean;
  /** Any contraction, with or without its apostrophe ("don't" or "dont"). */
  contractions: boolean;
  /** Sentences (and "I") start with a capital; false when two thirds start lowercase; null when it can't tell. */
  capitals: boolean | null;
  /** The message body ends on a period; null when it ends on ? or !, an ellipsis, or nothing readable. */
  end_period: boolean | null;
  /** Contractions keep their apostrophes; false for "dont" and "im"; null with no contractions. */
  apostrophes: boolean | null;
  /** Em or en dashes, or a spaced hyphen, in the body. */
  dashes: boolean;
  ellipsis: boolean;
  /** The body (without a greeting line or sign-off) is more than one line or paragraph. */
  line_breaks: boolean;
  /** Words per sentence, on average (0 with no sentence). */
  sentenceWords: number;
  /** Letters per word, on average (0 with no words). */
  wordLetters: number;
  /** Punctuation marks per 10 words in the body; apostrophes don't count. */
  punctuation: number;
}

const GREETING = /^(?:hi|hey|hello|hiya|yo|dear|good (?:morning|afternoon|evening)|greetings|morning)\b/i;
const SIGNOFF = /^(?:best|thanks|thank you|many thanks|cheers|regards|kind regards|best regards|warm regards|warmly|sincerely|talk soon|speak soon|take care|all the best|[-–—]\s*\S+)\b/i;
const CONTRACTION =
  /\b(?:i'm|i'll|i've|i'd|you're|you'll|you've|we're|we'll|we've|they're|they'll|it's|that's|there's|here's|let's|what's|can't|won't|don't|doesn't|didn't|isn't|aren't|wasn't|weren't|couldn't|wouldn't|shouldn't|haven't|hasn't)\b/i;
/** Contractions written without the apostrophe. Only forms that aren't also words ("its", "wont", "lets", "ill" are left out). */
const BARE_CONTRACTION = /\b(?:im|ive|dont|doesnt|didnt|isnt|arent|wasnt|werent|cant|couldnt|wouldnt|shouldnt|havent|hasnt|youre|theyre|thats|whats|theres|heres)\b/i;
const EMOJI = /\p{Extended_Pictographic}/u;
const PUNCTUATION = /[,.;:!?—–…()"“”]/g;

/** How a sentence starts: a capital, a lowercase letter, or neither (a number, a link, an @mention). */
function startCase(sentence: string): 'upper' | 'lower' | null {
  const s = sentence.replace(/^[^\p{L}\p{N}@#]+/u, '');
  if (/^(?:[@#]|https?:|www\.)/i.test(s)) return null;
  const c = s[0];
  if (!c || !/\p{L}/u.test(c)) return null;
  if (c !== c.toLowerCase()) return 'upper';
  if (c !== c.toUpperCase()) return 'lower';
  return null;
}

const sentencesOf = (text: string) =>
  text
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => /\p{L}/u.test(s));

function capitalsOf(text: string): boolean | null {
  let upper = 0;
  let lower = 0;
  for (const s of sentencesOf(text)) {
    const c = startCase(s);
    if (c === 'upper') upper++;
    else if (c === 'lower') lower++;
  }
  // "I" on its own says the same thing ("i think so").
  upper += (text.match(/\bI\b/g) ?? []).length;
  lower += (text.match(/\bi\b/g) ?? []).length;
  const all = upper + lower;
  if (all === 0) return null;
  if (upper / all >= 2 / 3) return true;
  if (lower / all >= 2 / 3) return false;
  return null;
}

function endPeriodOf(lastLine: string | undefined): boolean | null {
  const end = (lastLine ?? '').replace(/[\s\p{Extended_Pictographic}\u{FE0F}\u{200D}]+$/u, '');
  if (!end || /(?:\.\.\.|…)$/.test(end)) return null;
  const c = end[end.length - 1]!;
  if (c === '.') return true;
  if (/[\p{L}\p{N})"'’”]/u.test(c)) return false;
  return null;
}

export function draftTraits(text: string): DraftTraits {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const first = lines[0] ?? '';
  const signoffAt = lines.length > 1 ? lines.findIndex((l, i) => i >= lines.length - 2 && SIGNOFF.test(l)) : -1;
  const plain = text.replace(/[‘’]/g, "'");
  // The body: without the sign-off, and without a greeting that sits on its own line ("Hi Jordan,").
  let bodyLines = signoffAt >= 0 ? lines.slice(0, signoffAt) : lines;
  if (bodyLines.length > 1 && GREETING.test(first) && first.split(/\s+/).length <= 4) bodyLines = bodyLines.slice(1);
  const body = bodyLines.join('\n').replace(/[‘’]/g, "'");
  const bodyWords = body.split(/\s+/).filter(Boolean).length;
  const sentences = sentencesOf(body);
  const tokens = plain.match(/[\p{L}']+/gu)?.filter((w) => /\p{L}/u.test(w)) ?? [];
  const letters = tokens.reduce((n, w) => n + w.replace(/'/g, '').length, 0);
  const withApostrophe = CONTRACTION.test(plain);
  const bare = BARE_CONTRACTION.test(plain);
  return {
    words: text.split(/\s+/).filter(Boolean).length,
    greeting: GREETING.test(first),
    signoff: signoffAt >= 0,
    exclamation: text.includes('!'),
    emoji: EMOJI.test(text),
    contractions: withApostrophe || bare,
    capitals: capitalsOf(plain),
    end_period: endPeriodOf(bodyLines[bodyLines.length - 1]),
    apostrophes: bare && !withApostrophe ? false : withApostrophe && !bare ? true : null,
    dashes: /[—–]|\S[^\S\n]-[^\S\n]/.test(body),
    ellipsis: /\.\.\.|…/.test(text),
    line_breaks: bodyLines.length > 1,
    sentenceWords: sentences.length ? Math.round((bodyWords / sentences.length) * 10) / 10 : 0,
    wordLetters: tokens.length ? Math.round((letters / tokens.length) * 100) / 100 : 0,
    punctuation: bodyWords ? Math.round(((body.replace(/\.\.\./g, '…').match(PUNCTUATION) ?? []).length / bodyWords) * 100) / 10 : 0,
  };
}

/** Share of words changed between two versions (word-level edit distance over the longer one). */
export function editRatio(before: string, after: string): number {
  const a = before.split(/\s+/).filter(Boolean);
  const b = after.split(/\s+/).filter(Boolean);
  if (a.length === 0 && b.length === 0) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]! / Math.max(a.length, b.length);
}

/** Below this, an edit is a typo or a name fix and the draft is still the model's writing. */
export const MEANINGFUL_EDIT = 0.15;

export const isMeaningfulEdit = (original: string, final: string) => editRatio(original, final) >= MEANINGFUL_EDIT;

type Flag = 'greeting' | 'signoff' | 'exclamation' | 'emoji' | 'contractions' | 'capitals' | 'end_period' | 'apostrophes' | 'dashes' | 'ellipsis' | 'line_breaks';
const FLAGS: readonly Flag[] = ['greeting', 'signoff', 'exclamation', 'emoji', 'contractions', 'capitals', 'end_period', 'apostrophes', 'dashes', 'ellipsis', 'line_breaks'];

/** A measured trait with two directions: which way an edit moved it, and whether drafts differ enough on it for a pick to say anything. */
interface Scale {
  dimension: 'length' | 'sentence_length' | 'word_length' | 'punctuation';
  value: (t: DraftTraits) => number;
  down: StylePole;
  up: StylePole;
  /** -1, 0, or 1: the direction an edit from `a` to `b` moved it, past noise. */
  moved: (a: number, b: number) => number;
  /** The drafts differ enough for a pick between them to count. */
  spread: (min: number, max: number) => boolean;
}

const ratio = (down: number, up: number) => (a: number, b: number) => (a <= 0 ? 0 : b <= a * down ? -1 : b >= a * up ? 1 : 0);
const SCALES: Scale[] = [
  { dimension: 'length', value: (t) => t.words, down: 'shorter', up: 'longer', moved: ratio(0.85, 1.15), spread: (min, max) => min > 0 && max >= min * 1.25 },
  { dimension: 'sentence_length', value: (t) => t.sentenceWords, down: 'shorter', up: 'longer', moved: ratio(0.8, 1.25), spread: (min, max) => min > 0 && max >= min * 1.3 },
  {
    dimension: 'word_length',
    value: (t) => t.wordLetters,
    down: 'shorter',
    up: 'longer',
    moved: (a, b) => (a <= 0 || b <= 0 ? 0 : b - a <= -0.4 ? -1 : b - a >= 0.4 ? 1 : 0),
    spread: (min, max) => min > 0 && max - min >= 0.5,
  },
  {
    dimension: 'punctuation',
    value: (t) => t.punctuation,
    down: 'lighter',
    up: 'heavier',
    moved: (a, b) => (b - a <= -0.5 && b <= a * 0.7 ? -1 : b - a >= 0.5 && b >= a * 1.4 ? 1 : 0),
    spread: (min, max) => max - min >= 1 && max >= min * 1.4,
  },
];

/** What an edit from `a` to `b` changed, each worth 2: an edit shows what the user would send. */
function editSignals(a: DraftTraits, b: DraftTraits): StyleSignal[] {
  const out: StyleSignal[] = [];
  for (const s of SCALES) {
    const dir = s.moved(s.value(a), s.value(b));
    if (dir) out.push({ dimension: s.dimension, pole: dir < 0 ? s.down : s.up, weight: 2 });
  }
  for (const d of FLAGS) {
    const x = a[d];
    const y = b[d];
    if (x !== null && y !== null && x !== y) out.push({ dimension: d, pole: y ? 'with' : 'without', weight: 2 });
  }
  return out;
}

/** Where the picked draft stands among the others, each worth 1; only traits the drafts differ on. */
function spreadSignals(traits: DraftTraits[], chosen: number, skip: Set<StyleDimension>): StyleSignal[] {
  const c = traits[chosen]!;
  const out: StyleSignal[] = [];
  for (const s of SCALES) {
    if (skip.has(s.dimension)) continue;
    const values = traits.map(s.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    if (!s.spread(min, max)) continue;
    if (s.value(c) === min) out.push({ dimension: s.dimension, pole: s.down, weight: 1 });
    else if (s.value(c) === max) out.push({ dimension: s.dimension, pole: s.up, weight: 1 });
  }
  for (const d of FLAGS) {
    const v = c[d];
    if (skip.has(d) || v === null) continue;
    if (traits.some((t) => t[d] !== null && t[d] !== v)) out.push({ dimension: d, pole: v ? 'with' : 'without', weight: 1 });
  }
  return out;
}

/** `chosen` for a reply the user wrote themselves instead of taking a draft. */
export const WROTE_OWN = -1;

/**
 * Which way one pick leaned. An edit says more than a pick, so where the user changed a trait
 * (or the length), that counts twice and replaces the pick's signal for it. A pick only counts
 * on a trait when the drafts differ on it. Kind and tone come from the model's tags and count
 * once (an edit can't be read for them). A reply the user wrote themselves (`WROTE_OWN`)
 * counts twice on whatever it does differently from every draft.
 */
export function pickSignals(input: { drafts: PickDraft[]; chosen: number; final: string }): StyleSignal[] {
  const { drafts, chosen, final } = input;
  if (drafts.length === 0) return [];
  const traits = drafts.map((d) => draftTraits(d.text));
  const f = draftTraits(final);
  const key = (s: StyleSignal) => `${s.dimension}:${s.pole}`;

  if (chosen === WROTE_OWN) {
    // Only what the user's reply does against all of the drafts: the drafts had it wrong together.
    const [firstEdits, ...rest] = traits.map((t) => editSignals(t, f));
    const everywhere = rest.map((r) => new Set(r.map(key)));
    return (firstEdits ?? []).filter((s) => everywhere.every((set) => set.has(key(s))));
  }

  const picked = drafts[chosen];
  if (!picked) return [];
  const out = editSignals(traits[chosen]!, f);
  if (drafts.length < 2) return out;
  out.push(...spreadSignals(traits, chosen, new Set(out.map((s) => s.dimension))));

  const kind = asKind(picked.kind);
  if (kind && drafts.some((d) => asKind(d.kind) !== kind)) out.push({ dimension: 'kind', pole: kind, weight: 1 });
  const tone = asTone(picked.tone);
  if (tone && drafts.some((d) => asTone(d.tone) !== tone)) out.push({ dimension: 'tone', pole: tone, weight: 1 });
  return out;
}

/** What an edit changed, measured in code, for the style notes ("words 42 → 18", "Writes in lowercase"). */
export function measuredChanges(original: string, final: string): string[] {
  const a = draftTraits(original);
  const b = draftTraits(final);
  const out = [`words ${a.words} → ${b.words}`];
  for (const s of editSignals(a, b)) if (s.dimension !== 'length') out.push(preferenceLabel(s));
  return out;
}

/** The newest signals per dimension and scope that are looked at. */
const WINDOW = 20;
/** Each older signal counts this much of the one after it, so a new habit takes over. */
const DECAY = 0.9;
/** Share of the (decayed) weight one side needs. */
const AGREE = 0.7;
const MIN_SIGNALS = { person: 3, group: 5, channel: 5 } as const;

function judge(rows: StyleSignalRow[], min: number): { pole: StylePole; agree: number; of: number } | null {
  const recent = [...rows].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, WINDOW);
  if (recent.length < min) return null;
  const totals = new Map<StylePole, number>();
  let all = 0;
  recent.forEach((r, age) => {
    const w = r.weight * DECAY ** age;
    totals.set(r.pole, (totals.get(r.pole) ?? 0) + w);
    all += w;
  });
  const [pole, weight] = [...totals.entries()].sort((a, b) => b[1] - a[1])[0]!;
  if (all === 0 || weight / all < AGREE) return null;
  return { pole, agree: recent.filter((r) => r.pole === pole).length, of: recent.length };
}

/** The preferences for one reply: the person's own where they have enough, else their relationship on this platform, else the platform's. */
export function preferencesFor(
  rows: StyleSignalRow[],
  to: { channel: ReplyChannel; personId: string | null; relationship: Relationship | null },
): StylePreference[] {
  const out: StylePreference[] = [];
  for (const dimension of STYLE_DIMENSIONS) {
    const mine = rows.filter((r) => r.dimension === dimension);
    const base = { dimension, channel: null, relationship: null, personId: null };
    const person = to.personId ? judge(mine.filter((r) => r.person_id === to.personId), MIN_SIGNALS.person) : null;
    if (person) {
      out.push({ ...base, ...person, scope: 'person', personId: to.personId });
      continue;
    }
    const onPlatform = mine.filter((r) => r.channel === to.channel);
    const group = to.relationship ? judge(onPlatform.filter((r) => r.relationship === to.relationship), MIN_SIGNALS.group) : null;
    if (group) {
      out.push({ ...base, ...group, scope: 'group', channel: to.channel, relationship: to.relationship });
      continue;
    }
    const channel = judge(onPlatform, MIN_SIGNALS.channel);
    if (channel) out.push({ ...base, ...channel, scope: 'channel', channel: to.channel });
  }
  return out;
}

/** Every preference learned so far, per platform, per relationship on a platform, and per person, for the Profile tab. */
export function allPreferences(rows: StyleSignalRow[]): StylePreference[] {
  const out: StylePreference[] = [];
  for (const dimension of STYLE_DIMENSIONS) {
    const mine = rows.filter((r) => r.dimension === dimension);
    const base = { dimension, channel: null, relationship: null, personId: null };
    for (const channel of REPLY_CHANNELS) {
      const onPlatform = mine.filter((r) => r.channel === channel);
      const j = judge(onPlatform, MIN_SIGNALS.channel);
      if (j) out.push({ ...base, ...j, scope: 'channel', channel });
      for (const relationship of new Set(onPlatform.map((r) => r.relationship).filter((x): x is Relationship => Boolean(x)))) {
        const g = judge(
          onPlatform.filter((r) => r.relationship === relationship),
          MIN_SIGNALS.group,
        );
        if (g) out.push({ ...base, ...g, scope: 'group', channel, relationship });
      }
    }
    for (const personId of new Set(mine.map((r) => r.person_id).filter((p): p is string => Boolean(p)))) {
      const j = judge(
        mine.filter((r) => r.person_id === personId),
        MIN_SIGNALS.person,
      );
      if (j) out.push({ ...base, ...j, scope: 'person', personId });
    }
  }
  return out;
}

const PHRASES: Record<StyleDimension, Partial<Record<StylePole, string>>> = {
  length: { shorter: 'Keeps replies short', longer: 'Writes fuller replies' },
  greeting: { with: 'Opens with a greeting', without: 'Skips the greeting' },
  signoff: { with: 'Ends with a sign-off', without: 'Skips the sign-off' },
  exclamation: { with: 'Uses exclamation marks', without: 'Avoids exclamation marks' },
  emoji: { with: 'Uses emoji', without: 'Avoids emoji' },
  contractions: { with: 'Writes casually, with contractions', without: 'Writes formally, without contractions' },
  capitals: { with: 'Capitalizes sentences', without: 'Writes in lowercase' },
  end_period: { with: 'Ends with a period', without: 'Leaves off the final period' },
  apostrophes: { with: 'Keeps apostrophes in contractions', without: "Drops apostrophes (dont, im)" },
  dashes: { with: 'Uses dashes', without: 'Avoids dashes' },
  ellipsis: { with: 'Uses ellipses (...)', without: 'Avoids ellipses' },
  line_breaks: { with: 'Splits replies into separate lines', without: 'Writes one block of text' },
  sentence_length: { shorter: 'Writes short sentences', longer: 'Writes longer sentences' },
  word_length: { shorter: 'Uses short, plain words', longer: 'Uses longer words' },
  punctuation: { lighter: 'Uses little punctuation', heavier: 'Uses more punctuation' },
  kind: {
    acknowledge: 'Usually picks a reply that acknowledges',
    answer: 'Usually picks a reply that answers',
    ask: 'Usually picks a reply that asks a question',
    agree: 'Usually picks a reply that agrees',
    decline: 'Usually picks a reply that declines',
    follow_up: 'Usually picks a reply that follows up',
    shift: 'Usually picks a reply that changes the subject',
    thank: 'Usually picks a reply that thanks them',
    update: 'Usually picks a reply that gives an update',
  },
  tone: {
    playful: 'Usually picks a playful tone',
    warm: 'Usually picks a warm tone',
    neutral: 'Usually picks a neutral tone',
    direct: 'Usually picks a direct tone',
    formal: 'Usually picks a formal tone',
  },
};

const CHANNEL_WORDS: Record<ReplyChannel, string> = { email: 'in email', messaging: 'in messaging apps', work_chat: 'in work chat', other: 'in other apps' };

export function preferenceLabel(p: Pick<StylePreference, 'dimension' | 'pole'>): string {
  return PHRASES[p.dimension][p.pole] ?? `${p.dimension}: ${p.pole}`;
}

/** Where it applies, for a person by name: "in email", "with friends in messaging apps", "with Jordan Hale". */
export function preferenceScope(p: Pick<StylePreference, 'scope' | 'channel' | 'relationship'>, personName?: string | null): string {
  if (p.scope === 'person') return `with ${personName ?? 'this person'}`;
  const where = CHANNEL_WORDS[p.channel ?? 'other'];
  return p.scope === 'group' && p.relationship ? `with ${RELATIONSHIP_PLURALS[p.relationship]} ${where}` : where;
}

/** One line for the Reply prompt, with its evidence. */
export function preferenceLine(p: StylePreference, personName?: string | null): string {
  return `${preferenceLabel(p)} (${p.agree} of the last ${p.of} picks ${preferenceScope(p, personName)})`;
}
