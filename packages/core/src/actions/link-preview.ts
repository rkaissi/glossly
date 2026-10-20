/**
 * Link previews (decision 84): which addresses may be fetched, and what a page's head says about
 * itself (Open Graph and friends). Pure functions; the fetch itself is the shell's.
 */

/** What a page's head gives for its preview; the image is still a URL here. */
export interface PageMeta {
  title: string | null;
  description: string | null;
  site: string | null;
  image: string | null;
}

const MAX_TITLE = 200;
const MAX_DESCRIPTION = 400;
const MAX_SITE = 80;

const PRIVATE_V4 = [/^10\./, /^127\./, /^169\.254\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./];
const LOCAL_SUFFIXES = ['.local', '.localhost', '.internal', '.lan', '.home.arpa', '.corp', '.intranet'];

/**
 * Whether Glossly may fetch an address on its own for a preview: http(s) on a public name. Never
 * this computer or the local network (localhost, private and link-local IPs, names with no dot,
 * .local and similar), so a save can't reach into a router page or an intranet.
 */
export function isFetchableAddress(address: string | null | undefined): boolean {
  if (!address) return false;
  let u: URL;
  try {
    u = new URL(address);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost') return false;
  if (host.includes(':')) {
    // IPv6: loopback, unique local (fc00::/7), link-local (fe80::/10), and IPv4-mapped are all off limits.
    return !(host === '::1' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || host.startsWith('::ffff:') || host === '::');
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return !PRIVATE_V4.some((re) => re.test(host));
  if (!host.includes('.')) return false;
  return !LOCAL_SUFFIXES.some((s) => host.endsWith(s));
}

/** True once the head has been read: its end, or the body's start. */
export const headDone = (html: string): boolean => /<\/head\s*>|<body[\s>]/i.test(html);

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (m, e: string) => {
    const k = e.toLowerCase();
    if (k.startsWith('#x')) return String.fromCodePoint(Number.parseInt(k.slice(2), 16) || 32);
    if (k.startsWith('#')) return String.fromCodePoint(Number(k.slice(1)) || 32);
    return ENTITIES[k] ?? m;
  });
}

const clean = (s: string | undefined, max: number): string | null => {
  const t = s ? decode(s).replace(/\s+/g, ' ').trim() : '';
  return t ? (t.length > max ? `${t.slice(0, max - 1)}…` : t) : null;
};

/** Every <meta> tag's attributes, lower-cased names, in order. */
function metaTags(html: string): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  for (const m of html.matchAll(/<meta\b([^>]*)>/gi)) {
    const attrs: Record<string, string> = {};
    for (const a of m[1]!.matchAll(/([a-z:_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi)) attrs[a[1]!.toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? '';
    out.push(attrs);
  }
  return out;
}

/**
 * A page's preview from its head: Open Graph first, then Twitter cards, then plain <title> and
 * description. The image is made absolute against the page's address, and kept only when http(s).
 * The site falls back to the host without "www.".
 */
export function parseOpenGraph(html: string, pageUrl: string): PageMeta {
  const meta = new Map<string, string>();
  for (const t of metaTags(html)) {
    const key = (t.property ?? t.name ?? '').toLowerCase();
    if (key && t.content !== undefined && !meta.has(key)) meta.set(key, t.content);
  }
  const first = (...keys: string[]) => keys.map((k) => meta.get(k)).find((v) => v && v.trim());
  const titleTag = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1];

  let image: string | null = null;
  const rawImage = first('og:image:secure_url', 'og:image', 'og:image:url', 'twitter:image', 'twitter:image:src');
  if (rawImage) {
    try {
      const u = new URL(decode(rawImage.trim()), pageUrl);
      if (u.protocol === 'https:' || u.protocol === 'http:') image = u.href;
    } catch {
      image = null;
    }
  }
  let host: string | null = null;
  try {
    host = new URL(pageUrl).hostname.replace(/^www\./, '') || null;
  } catch {
    host = null;
  }
  return {
    title: clean(first('og:title', 'twitter:title') ?? titleTag, MAX_TITLE),
    description: clean(first('og:description', 'twitter:description', 'description'), MAX_DESCRIPTION),
    site: clean(first('og:site_name', 'application-name'), MAX_SITE) ?? host,
    image,
  };
}

/** The image types a preview keeps, by content type, with the file extension to save them under. */
export const PREVIEW_IMAGE_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
