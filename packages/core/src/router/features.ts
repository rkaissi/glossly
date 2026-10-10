import { countWords } from '../capture/gating';
import { isMe } from '../people/names';
import type { Identity } from '../settings';
import type { KnownPerson, SelectionContext } from './types';

/** Deterministic, local features of a selection. Must stay well under 5 ms. */
export interface Features {
  wordCount: number;
  lineCount: number;
  sentences: number;
  emails: string[];
  handles: string[];
  phones: string[];
  namePairs: string[];
  /** IDs of known people whose name or alias appears. */
  knownPeople: string[];
  tableShape: boolean;
  numericDensity: number;
  chatLines: number;
  messengerApp: boolean;
  codeEditorApp: boolean;
  commitmentPhrases: string[];
  hasDateWord: boolean;
  endsWithQuestion: boolean;
  codeScore: number;
  ideaWords: boolean;
  /** Automated or broadcast mail (no-reply, receipts, shipping, one-time codes, notices to everyone): nobody to reply to. */
  automated: boolean;
  /** The last chat header up to the end of the selection is the user's own. */
  authorIsMe: boolean;
}

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const HANDLE = /(?:^|[\s(])@([A-Za-z0-9_][\w.-]{1,30})/g;
const PHONE = /(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g;
const NAME_PAIR = /\b([A-Z][a-z]{1,15})\s([A-Z][a-z]{1,20})\b/g;
const NOT_FIRST_NAMES = new Set(
  'The This That These Those There Then When Where What Which While With From Into Over Under About After Before Hello Hi Hey Thanks Thank Cheers Regards Please Sorry Congrats Yes Yeah Sure Okay Dear Best Good Happy New Next Last Senior Junior Head Chief Monday Tuesday Wednesday Thursday Friday Saturday Sunday January February March April May June July August September October November December Google Microsoft Apple United North South East West Read More Sign Log Open Save Learn See Click'.split(
    ' ',
  ),
);

// "Sam Lee  10:42 AM", "[10:42] Sam:", "Sam — Today at 10:42", "Priya 3:05 PM"
const CHAT_LINE =
  /^\s*(?:\[\d{1,2}:\d{2}(?::\d{2})?\s*(?:[AaPp][Mm])?\]\s*[\w .'-]{1,40}:|[A-Z][\w.'-]*(?:\s[A-Z][\w.'-]*){0,3}\s*(?:[—–-]\s*)?(?:(?:Today|Yesterday)\s+at\s+)?\d{1,2}:\d{2}\s*(?:[AaPp][Mm])?\s*$|[A-Z][\w.'-]*(?:\s[A-Z][\w.'-]*){0,2}:\s+\S)/;

const MESSENGER_PROCESSES = [
  'slack.exe',
  'discord.exe',
  'teams.exe',
  'ms-teams.exe',
  'whatsapp.exe',
  'whatsapp.root.exe',
  'messenger.exe',
  'telegram.exe',
  'signal.exe',
  'outlook.exe',
  'olk.exe',
  'thunderbird.exe',
];
const MESSENGER_TITLES = /(?:- Gmail|- Outlook|Outlook$|- Slack|Discord|WhatsApp|Messenger|Microsoft Teams|Telegram)\b/i;
const CODE_EDITORS = ['code.exe', 'cursor.exe', 'devenv.exe', 'idea64.exe', 'pycharm64.exe', 'webstorm64.exe', 'rider64.exe', 'sublime_text.exe', 'notepad++.exe', 'zed.exe'];

const COMMITMENT =
  /\b(?:I'll|I will|I'm going to|I am going to|we'll|we will|will do|I can|can you|could you|would you|please|let me know|get back to (?:you|me)|follow up|remind me|send (?:you|over|it)|by (?:eod|end of (?:day|week|month)|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next week)|due|deadline|promise|owe you)\b/gi;
const DATE_WORD =
  /\b(?:today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next week|end of (?:day|week|month)|eod|eow|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|\d{1,2}(?::\d{2})?\s?[ap]m)\b/i;
const AUTOMATED =
  /\b(?:no-?reply|do not reply|don't reply to this|this is an automated|automated (?:message|email|notification)|automatically generated|unsubscribe|one-time (?:pass)?code|passcode|verification code|security code|sign-in attempt|confirm your email|verify your email|reset your password|your order|order #|has shipped|out for delivery|tracking number|track your (?:order|package)|your receipt|receipt for|invoice #|payment (?:received|confirmation))\b/i;
// "Hi all, a reminder that..." is a notice to everyone, not a message to answer.
const BROADCAST_GREETING = /^\s*(?:hi|hello|hey|dear|good morning)\s+(?:all|everyone|everybody|colleagues)\b/i;
const BROADCAST_WORDS = /\b(?:reminder|announce|announcement|please note|heads up|fyi)\b/i;
const IDEA = /\b(?:idea|what if|we could|imagine|brainstorm|concept|maybe we|someday)\b/i;
// Keywords are also common English words ("can you return my drill"), so they only count
// on a line that also has code punctuation.
const CODE_KEYWORD =
  /\b(?:function|const|let|var|def|class|import|export|return|public|private|static|void|async|await|fn|impl|struct|package|#include|SELECT|FROM|WHERE|try|except|raise|elif|lambda|yield)\b/;
const CODE_PUNCT = /[(){}[\];=<>]/;
const CODE_STRONG = /(?:=>|::|[{};]\s*$|^\s*(?:\/\/|#!|<\/?\w+[^>]*>)|^\s*(?:if|for|while|elif|else|try|except|finally|with|def|class)\b.*:\s*$)/;
const isCodeLine = (l: string) => CODE_STRONG.test(l) || (CODE_KEYWORD.test(l) && CODE_PUNCT.test(l));
const SENTENCE_END = /[.!?](?:\s|$)/g;

function detectTable(lines: string[]): boolean {
  const rows = lines.filter((l) => l.trim());
  if (rows.length < 3) return false;
  for (const delim of ['\t', '|', ',', ';']) {
    const counts = rows.map((l) => l.split(delim).length - 1);
    const first = counts[0]!;
    if (first >= 1 && counts.filter((c) => c === first).length >= Math.max(3, Math.ceil(rows.length * 0.8))) return true;
  }
  // Aligned columns: two or more runs of 2+ spaces on most lines.
  const aligned = rows.filter((l) => (l.trim().match(/\S\s{2,}\S/g) ?? []).length >= 1).length;
  return aligned >= Math.max(3, Math.ceil(rows.length * 0.8));
}

function numericDensity(text: string): number {
  const tokens = text.split(/[\s,;|\t]+/).filter(Boolean);
  if (tokens.length < 6) return 0;
  // Plain numbers plus short unit suffixes: 42ms, 2.3s, 12.1k, 40%, $4.2M.
  const numeric = tokens.filter((t) => /^[-+$€£(]?\d[\d.,:%)]*(?:[a-zA-Z]{1,3})?[.%)]?$/.test(t)).length;
  return numeric / tokens.length;
}

/** Labels that look like "Name: text" lines but aren't speakers. */
const NOT_SPEAKERS = new Set(
  'from to cc bcc subject re fwd fw date sent note notes ps update edit q a step warning error todo tip question answer summary reminder agenda action'.split(' '),
);

/** The speaker of a chat header line ("Sam Lee  10:42 AM", "[10:42] sam:", "Sam: hi"), or null. */
export function chatSpeaker(line: string): string | null {
  if (!CHAT_LINE.test(line)) return null;
  const m =
    /^\s*\[[^\]]*\]\s*([\w .'-]{1,40}):/.exec(line) ??
    /^\s*([A-Z][\w.'-]*(?:\s[A-Z][\w.'-]*){0,3})\s*(?:[—–-]\s*)?(?:(?:Today|Yesterday)\s+at\s+)?\d{1,2}:\d{2}\s*(?:[AaPp][Mm])?\s*$/.exec(line) ??
    /^\s*([A-Z][\w.'-]*(?:\s[A-Z][\w.'-]*){0,2}):\s+\S/.exec(line);
  const name = m?.[1]?.trim();
  if (!name || NOT_SPEAKERS.has(name.toLowerCase())) return null;
  return name;
}

/** "[10:42] Sam: hi" and "Sam: hi" keep "hi"; a header-only line ("Sam Lee  10:42 AM") becomes empty. */
function stripSpeaker(line: string): string {
  return line.match(/^\s*(?:\[[^\]]*\]\s*)?[\w .'-]{1,40}:\s+(.*)$/)?.[1] ?? '';
}

function unique(xs: Iterable<string>): string[] {
  return [...new Set(xs)];
}

function lastSpeaker(text: string): string | null {
  let speaker: string | null = null;
  for (const line of text.split(/\r?\n/)) speaker = chatSpeaker(line) ?? speaker;
  return speaker;
}

export function extractFeatures(ctx: SelectionContext, people: KnownPerson[] = [], me?: Identity): Features {
  const text = ctx.text;
  const lines = text.split(/\r?\n/);
  const app = ctx.source_app.toLowerCase();

  const emails = unique(text.match(EMAIL) ?? []);
  const handles = unique([...text.matchAll(HANDLE)].map((m) => m[1]!));
  const phones = unique(text.match(PHONE) ?? []);
  // Speaker names in chat headers ("Sam Lee  10:42 AM") are who wrote it, not who it mentions.
  const body = lines.map((l) => (CHAT_LINE.test(l) ? stripSpeaker(l) : l)).join('\n');
  const namePairs = unique(
    [...body.matchAll(NAME_PAIR)].filter((m) => !NOT_FIRST_NAMES.has(m[1]!) && !NOT_FIRST_NAMES.has(m[2]!)).map((m) => m[0]),
  );

  const lower = text.toLowerCase();
  const knownPeople = people
    .filter((p) => [p.name, ...p.aliases].some((a) => a.length >= 3 && lower.includes(a.toLowerCase())))
    .map((p) => p.id);

  const codeLines = lines.filter(isCodeLine).length;
  const nonEmpty = lines.filter((l) => l.trim()).length || 1;
  const symbols = (text.match(/[{}();=<>[\]]/g) ?? []).length;
  const codeScore = Math.min(1, (codeLines / nonEmpty) * 0.7 + Math.min(0.3, (symbols / Math.max(text.length, 1)) * 3));

  return {
    wordCount: countWords(text),
    lineCount: nonEmpty,
    sentences: (text.match(SENTENCE_END) ?? []).length,
    emails,
    handles,
    phones,
    namePairs,
    knownPeople,
    tableShape: detectTable(lines),
    numericDensity: numericDensity(text),
    chatLines: lines.filter((l) => CHAT_LINE.test(l)).length,
    messengerApp: MESSENGER_PROCESSES.includes(app) || MESSENGER_TITLES.test(ctx.window_title),
    codeEditorApp: CODE_EDITORS.includes(app),
    commitmentPhrases: unique((text.match(COMMITMENT) ?? []).map((m) => m.toLowerCase())),
    hasDateWord: DATE_WORD.test(text),
    endsWithQuestion: /\?\s*$/.test(text),
    codeScore,
    ideaWords: IDEA.test(text),
    automated: AUTOMATED.test(text) || AUTOMATED.test(ctx.window_title) || (BROADCAST_GREETING.test(text) && BROADCAST_WORDS.test(text)),
    authorIsMe: me ? isMe(lastSpeaker(`${ctx.context_before}${text}`), me) : false,
  };
}
