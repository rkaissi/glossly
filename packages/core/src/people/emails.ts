// Email addresses in captured text. Accessibility trees often glue the next word onto the
// domain ("jordan@example.comCasey"), and the old pattern treated that as part of the address.

export interface FoundEmail {
  email: string;
  /** Index of the first character of the address. */
  index: number;
  /** Index just after the domain. Letters glued on after it are not included. */
  end: number;
}

/** Domains we will split even when the next word is stuck to them, longest first at match time. */
const COMMON_TLDS = [
  'info',
  'gov',
  'edu',
  'com',
  'net',
  'org',
  'app',
  'dev',
  'biz',
  'io',
  'ai',
  'me',
  'co',
  'uk',
  'ca',
  'de',
  'fr',
  'us',
  'au',
  'jp',
  'nl',
  'se',
  'no',
  'fi',
  'es',
  'it',
  'ch',
  'be',
  'nz',
  'za',
  'sg',
  'ie',
  'at',
  'pl',
  'br',
  'in',
  'mx',
  'kr',
  'cn',
  'ru',
  'mil',
];

/** Whole labels that are a domain ending, including longer ones we should not split. */
const EXACT_TLDS = new Set([
  ...COMMON_TLDS,
  'museum',
  'email',
  'careers',
  'academy',
  'company',
  'community',
  'network',
  'digital',
  'online',
  'agency',
  'studio',
  'design',
  'media',
  'cloud',
  'software',
  'xyz',
  'tech',
  'blog',
  'site',
  'world',
  'group',
  'university',
  'college',
  'school',
  'international',
  'consulting',
  'solutions',
  'systems',
  'technology',
  'example',
]);

const COMMON_BY_LENGTH = [...COMMON_TLDS].sort((a, b) => b.length - a.length);

/**
 * The domain ending of one label. "com" stays "com". "comJordan" and "comjordan" are "com"
 * plus a word the page glued on. A short ending we don't list (".cafe") is kept whole.
 */
function tldOf(label: string): string | null {
  // A capitalized word glued on ("caRiley") is the clearest split.
  const glued = /^([a-z]{2,})[A-Z]/.exec(label);
  if (glued) return tldOf(glued[1]!);
  const lower = label.toLowerCase();
  if (EXACT_TLDS.has(lower)) return lower;
  if (!/^[a-z]+$/.test(lower)) return null;
  if (lower.length <= 6) return lower;
  for (const tld of COMMON_BY_LENGTH) if (lower.startsWith(tld)) return tld;
  return lower.length <= 24 ? lower : null;
}

function readLocal(text: string, at: number): { value: string; index: number } | null {
  let i = at - 1;
  while (i >= 0 && /[\w.+-]/.test(text[i]!)) i--;
  const start = i + 1;
  const value = text.slice(start, at);
  if (!/^[A-Za-z0-9]/.test(value) || value.length > 64) return null;
  return { value, index: start };
}

function readDomain(text: string, start: number): { host: string; end: number } | null {
  let i = start;
  const labels: string[] = [];
  while (i < text.length) {
    const m = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?/.exec(text.slice(i));
    if (!m) return null;
    const label = m[0];
    const next = i + label.length;
    // A dot followed by another label continues the domain. A dot before a space or the end
    // of the text ends the sentence, not the address.
    if (text[next] === '.' && /[A-Za-z0-9]/.test(text[next + 1] ?? '')) {
      labels.push(label);
      i = next + 1;
      continue;
    }
    if (!/^[A-Za-z]+$/.test(label) || labels.length === 0) return null;
    const tld = tldOf(label);
    if (!tld) return null;
    return { host: [...labels, tld].join('.'), end: i + tld.length };
  }
  return null;
}

/** Every address in the text, with a word stuck to the domain left off. */
export function findEmails(text: string): FoundEmail[] {
  const out: FoundEmail[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '@') continue;
    const local = readLocal(text, i);
    const domain = local ? readDomain(text, i + 1) : null;
    if (!local || !domain) continue;
    const email = `${local.value}@${domain.host}`;
    const key = email.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ email, index: local.index, end: domain.end });
    }
    i = domain.end - 1;
  }
  return out;
}

/**
 * A mailbox that is not a person: no-reply, notifications, newsletters, and scheduling
 * or other shared inboxes. A long hyphenated local part is a shared alias, not a name.
 */
const ROLE_LOCAL =
  /^(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply|notifications?|notify|mailer-daemon|bounce|postmaster|communications?|info|support|hello|team|newsletter|news|updates?|admin|contact|help|sales|marketing|billing|scheduling|calendar|unsubscribe|invites?|careers|jobs|recruiting|hr|legal|press|feedback|office|accounts?|alerts?|automated|system|webmaster)$/i;
const ROLE_HINT = /no[-_.]?reply|donotreply|do-not-reply|notification|scheduling|unsubscribe|mailer-daemon|newsletter/i;

export function isRoleAddress(email: string): boolean {
  const local = email.split('@')[0] ?? '';
  if (!local) return false;
  if (ROLE_LOCAL.test(local) || ROLE_HINT.test(local)) return true;
  return local.split('-').length >= 4;
}
