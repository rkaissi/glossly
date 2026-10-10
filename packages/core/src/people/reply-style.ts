// What Reply learns from the drafts the user picks and edits, in code: no text is kept for a
// pick, only which way it leaned on a few traits. Code measures length, greeting, sign-off,
// exclamation marks, emoji, and contractions; the model tags each draft's kind (acknowledge,
// ask, shift, ...) and tone (playful, warm, ...). A trait becomes a preference only when recent picks agree,
// so one long reply after a run of short ones changes nothing, and a new habit takes over
// as the old picks age out.

export type ReplyChannel = 'email' | 'chat' | 'other';

export const STYLE_DIMENSIONS = ['length', 'greeting', 'signoff', 'exclamation', 'emoji', 'contractions', 'kind', 'tone'] as const;
export type StyleDimension = (typeof STYLE_DIMENSIONS)[number];

/** What a draft does. The model tags each draft with one (prompts/reply.md); keep the two lists in sync. */
export const REPLY_KINDS = ['acknowledge', 'answer', 'ask', 'agree', 'decline', 'follow_up', 'shift', 'thank', 'update'] as const;
export type ReplyKind = (typeof REPLY_KINDS)[number];
export const REPLY_TONES = ['playful', 'warm', 'neutral', 'direct', 'formal'] as const;
export type ReplyTone = (typeof REPLY_TONES)[number];

/** length: shorter or longer. kind and tone: the category. Every other dimension: with or without. */
export type StylePole = 'shorter' | 'longer' | 'with' | 'without' | ReplyKind | ReplyTone;

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

/** A stored signal: where and when it was seen. */
export interface StyleSignalRow extends StyleSignal {
  channel: ReplyChannel;
  person_id: string | null;
  at: string;
}

export interface StylePreference {
  dimension: StyleDimension;
  pole: StylePole;
  /** A person's own preference wins over the channel's. */
  scope: 'person' | 'channel';
  channel: ReplyChannel | null;
  personId: string | null;
  /** Recent signals that agree, out of `of`. */
  agree: number;
  of: number;
}

const EMAIL_PROCESSES = ['outlook.exe', 'olk.exe', 'thunderbird.exe', 'hxoutlook.exe'];
const CHAT_PROCESSES = ['slack.exe', 'discord.exe', 'teams.exe', 'ms-teams.exe', 'whatsapp.exe', 'whatsapp.root.exe', 'messenger.exe', 'telegram.exe', 'signal.exe'];
const EMAIL_TITLES = /(?:- Gmail|- Outlook|Outlook$|Proton Mail|Yahoo Mail|Fastmail)\b/i;
const CHAT_TITLES = /(?:- Slack|Slack \||Discord|WhatsApp|Messenger|Microsoft Teams|Telegram|Signal)\b/i;

/** Email, chat, or anything else: register differs a lot between them, so each learns on its own. */
export function replyChannel(app: string, title: string): ReplyChannel {
  const p = app.toLowerCase();
  if (EMAIL_PROCESSES.includes(p) || EMAIL_TITLES.test(title)) return 'email';
  if (CHAT_PROCESSES.includes(p) || CHAT_TITLES.test(title)) return 'chat';
  return 'other';
}

export interface DraftTraits {
  words: number;
  greeting: boolean;
  signoff: boolean;
  exclamation: boolean;
  emoji: boolean;
  contractions: boolean;
}

const GREETING = /^(?:hi|hey|hello|hiya|yo|dear|good (?:morning|afternoon|evening)|greetings|morning)\b/i;
const SIGNOFF = /^(?:best|thanks|thank you|many thanks|cheers|regards|kind regards|best regards|warm regards|warmly|sincerely|talk soon|speak soon|take care|all the best|[-–—]\s*\S+)\b/i;
const CONTRACTION =
  /\b(?:i'm|i'll|i've|i'd|you're|you'll|you've|we're|we'll|we've|they're|they'll|it's|that's|there's|here's|let's|what's|can't|won't|don't|doesn't|didn't|isn't|aren't|wasn't|weren't|couldn't|wouldn't|shouldn't|haven't|hasn't)\b/i;
const EMOJI = /\p{Extended_Pictographic}/u;

export function draftTraits(text: string): DraftTraits {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const first = lines[0] ?? '';
  const tail = lines.slice(-2);
  const plain = text.replace(/[‘’]/g, "'");
  return {
    words: text.split(/\s+/).filter(Boolean).length,
    greeting: GREETING.test(first),
    signoff: lines.length > 1 && tail.some((l) => SIGNOFF.test(l)),
    exclamation: text.includes('!'),
    emoji: EMOJI.test(text),
    contractions: CONTRACTION.test(plain),
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

const BOOLEAN_DIMENSIONS = ['greeting', 'signoff', 'exclamation', 'emoji', 'contractions'] as const;
/** Drafts closer in length than this don't say anything about length. */
const LENGTH_SPREAD = 1.25;
const EDIT_SHORTER = 0.85;
const EDIT_LONGER = 1.15;

/**
 * Which way one pick leaned. An edit says more than a pick, so where the user changed a trait
 * (or the length), that counts twice and replaces the pick's signal for it. A pick only counts
 * on a trait when the drafts differ on it. Kind and tone come from the model's tags and count
 * once (an edit can't be read for them).
 */
export function pickSignals(input: { drafts: PickDraft[]; chosen: number; final: string }): StyleSignal[] {
  const { drafts, chosen, final } = input;
  const picked = drafts[chosen];
  if (drafts.length < 2 || !picked) return [];
  const traits = drafts.map((d) => draftTraits(d.text));
  const c = traits[chosen]!;
  const f = draftTraits(final);
  const out: StyleSignal[] = [];

  if (c.words > 0 && f.words <= c.words * EDIT_SHORTER) out.push({ dimension: 'length', pole: 'shorter', weight: 2 });
  else if (c.words > 0 && f.words >= c.words * EDIT_LONGER) out.push({ dimension: 'length', pole: 'longer', weight: 2 });
  else {
    const words = traits.map((t) => t.words);
    const min = Math.min(...words);
    const max = Math.max(...words);
    if (min > 0 && max >= min * LENGTH_SPREAD) {
      if (c.words === min) out.push({ dimension: 'length', pole: 'shorter', weight: 1 });
      else if (c.words === max) out.push({ dimension: 'length', pole: 'longer', weight: 1 });
    }
  }

  for (const d of BOOLEAN_DIMENSIONS) {
    if (c[d] !== f[d]) out.push({ dimension: d, pole: f[d] ? 'with' : 'without', weight: 2 });
    else if (traits.some((t) => t[d] !== c[d])) out.push({ dimension: d, pole: c[d] ? 'with' : 'without', weight: 1 });
  }

  const kind = asKind(picked.kind);
  if (kind && drafts.some((d) => asKind(d.kind) !== kind)) out.push({ dimension: 'kind', pole: kind, weight: 1 });
  const tone = asTone(picked.tone);
  if (tone && drafts.some((d) => asTone(d.tone) !== tone)) out.push({ dimension: 'tone', pole: tone, weight: 1 });
  return out;
}

/** The newest signals per dimension and scope that are looked at. */
const WINDOW = 20;
/** Each older signal counts this much of the one after it, so a new habit takes over. */
const DECAY = 0.9;
/** Share of the (decayed) weight one side needs. */
const AGREE = 0.7;
const MIN_SIGNALS = { person: 3, channel: 5 } as const;

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

/** The preferences for one reply: the person's own where they have enough, else the channel's. */
export function preferencesFor(rows: StyleSignalRow[], scope: { channel: ReplyChannel; personId: string | null }): StylePreference[] {
  const out: StylePreference[] = [];
  for (const dimension of STYLE_DIMENSIONS) {
    const mine = rows.filter((r) => r.dimension === dimension);
    const person = scope.personId ? judge(mine.filter((r) => r.person_id === scope.personId), MIN_SIGNALS.person) : null;
    if (person) {
      out.push({ dimension, ...person, scope: 'person', channel: null, personId: scope.personId });
      continue;
    }
    const channel = judge(
      mine.filter((r) => r.channel === scope.channel),
      MIN_SIGNALS.channel,
    );
    if (channel) out.push({ dimension, ...channel, scope: 'channel', channel: scope.channel, personId: null });
  }
  return out;
}

/** Every preference learned so far, per channel and per person, for the Profile tab. */
export function allPreferences(rows: StyleSignalRow[]): StylePreference[] {
  const out: StylePreference[] = [];
  for (const dimension of STYLE_DIMENSIONS) {
    const mine = rows.filter((r) => r.dimension === dimension);
    for (const channel of ['email', 'chat', 'other'] as const) {
      const j = judge(
        mine.filter((r) => r.channel === channel),
        MIN_SIGNALS.channel,
      );
      if (j) out.push({ dimension, ...j, scope: 'channel', channel, personId: null });
    }
    for (const personId of new Set(mine.map((r) => r.person_id).filter((p): p is string => Boolean(p)))) {
      const j = judge(
        mine.filter((r) => r.person_id === personId),
        MIN_SIGNALS.person,
      );
      if (j) out.push({ dimension, ...j, scope: 'person', channel: null, personId });
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

const CHANNEL_WORDS: Record<ReplyChannel, string> = { email: 'in email', chat: 'in chat', other: 'in other apps' };

export function preferenceLabel(p: Pick<StylePreference, 'dimension' | 'pole'>): string {
  return PHRASES[p.dimension][p.pole] ?? `${p.dimension}: ${p.pole}`;
}

/** Where it applies, for a person by name: "in email", "with Jordan Hale". */
export function preferenceScope(p: Pick<StylePreference, 'scope' | 'channel'>, personName?: string | null): string {
  return p.scope === 'person' ? `with ${personName ?? 'this person'}` : CHANNEL_WORDS[p.channel ?? 'other'];
}

/** One line for the Reply prompt, with its evidence. */
export function preferenceLine(p: StylePreference, personName?: string | null): string {
  return `${preferenceLabel(p)} (${p.agree} of the last ${p.of} picks ${preferenceScope(p, personName)})`;
}
