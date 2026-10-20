import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { desktopCapturer, session, type Session } from 'electron';
import { headDone, isFetchableAddress, parseOpenGraph, PREVIEW_IMAGE_TYPES, type LinkPreview, type PageMeta, type Settings, type Store } from '@glossly/core';
import { errorInfo, logger } from './log';

const log = logger('previews');

const FETCH_TIMEOUT_MS = 5000;
/** Enough for heads that carry a lot of inline script before their tags (YouTube's runs past 512 KB). */
const MAX_HEAD_BYTES = 1_500_000;
const MAX_IMAGE_BYTES = 3_000_000;
const SHOT_SIZE = { width: 960, height: 600 };
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

interface FetchedPage {
  meta: PageMeta;
  /** The page answered with an error or sent the request somewhere else (often a sign-in page). */
  gated: boolean;
}

/**
 * Link previews (decision 84). A page's own preview is fetched once, in a session of its own that
 * keeps nothing on disk and has none of the user's cookies or sign-ins. A picture of the browser
 * window, taken at save time, is kept only when the page gave no image or sent a sign-in page.
 * Images live in `previews/` beside the database, named by item id, and go with their item.
 * Logs carry codes, sizes, and timings, never addresses or page text.
 */
export class Previews {
  private ses: Session | null = null;

  constructor(
    private readonly store: Store,
    private readonly settings: () => Pick<Settings, 'linkPreviews'>,
    private readonly dir: string,
  ) {}

  get enabled(): boolean {
    return this.settings().linkPreviews;
  }

  /** Where a preview image is; the name comes from `LinkPreview.image`. */
  imagePath(name: string): string | null {
    return /^[\w-]+\.(png|jpg|webp|gif)$/.test(name) ? join(this.dir, name) : null;
  }

  /** A picture of the browser window now (it is on screen at save time), as JPEG; null when previews are off or it can't be had. */
  async windowShot(handle: number): Promise<Buffer | null> {
    if (!this.enabled) return null;
    const t = performance.now();
    try {
      const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: SHOT_SIZE, fetchWindowIcons: false });
      const source = sources.find((s) => s.id.startsWith(`window:${handle}:`));
      if (!source || source.thumbnail.isEmpty()) return null;
      const jpg = source.thumbnail.toJPEG(80);
      log.info('window shot', { bytes: jpg.length, ms: Math.round(performance.now() - t) });
      return jpg;
    } catch (e) {
      log.warn('window shot failed', errorInfo(e));
      return null;
    }
  }

  /**
   * Makes and stores an item's preview: the page's own, else the window picture, else nothing.
   * `shot` is the picture taken at save time (or null); `address` must pass `isFetchableAddress`
   * to be fetched at all. Returns what was stored.
   */
  async record(itemId: string, address: string | null, shot: Promise<Buffer | null> | null): Promise<LinkPreview | null> {
    if (!this.enabled) return null;
    const t = performance.now();
    const page = address && isFetchableAddress(address) ? await this.fetchPage(address) : null;
    let preview: LinkPreview | null = null;
    if (page && !page.gated && page.meta.image) {
      const image = await this.fetchImage(page.meta.image, itemId);
      preview = { source: 'page', ...page.meta, image, icon: null };
    }
    if (!preview?.image) {
      const jpg = shot ? await shot : null;
      if (jpg && this.store.getItem(itemId)) {
        const name = `${itemId}.jpg`;
        this.write(name, jpg);
        preview = { source: 'window', title: page && !page.gated ? page.meta.title : null, description: null, site: page?.meta.site ?? null, image: name, icon: null };
      } else if (page && !page.gated) {
        preview = preview ?? { source: 'page', ...page.meta, image: null, icon: null };
      }
    }
    if (!this.store.getItem(itemId)) {
      this.sweep();
      return null;
    }
    if (preview) this.store.setItemPreview(itemId, preview);
    log.info('preview', {
      fetched: Boolean(page),
      gated: page?.gated ?? null,
      source: preview?.source ?? 'none',
      image: Boolean(preview?.image),
      ms: Math.round(performance.now() - t),
    });
    return preview;
  }

  /** Removes images whose item is gone (after an undo, a delete, or Delete all data). */
  sweep(): void {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return;
    }
    for (const n of names) {
      const id = n.replace(/\.[a-z]+$/, '');
      if (!this.store.getItem(id)) rmSync(join(this.dir, n), { force: true });
    }
  }

  private session(): Session {
    // No "persist:" prefix: in memory only, nothing kept between runs, no cookies from anywhere else.
    this.ses ??= session.fromPartition('glossly-previews', { cache: false });
    return this.ses;
  }

  private async fetchPage(address: string): Promise<FetchedPage | null> {
    try {
      const res = await this.session().fetch(address, {
        redirect: 'follow',
        credentials: 'omit',
        headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': USER_AGENT },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      // A redirect onto this computer or the local network is dropped like the address itself.
      if (!isFetchableAddress(res.url)) return null;
      const gated = !res.ok || (res.redirected && new URL(res.url).pathname !== new URL(address).pathname);
      if (!/text\/html|application\/xhtml/i.test(res.headers.get('content-type') ?? '') || !res.body) return { meta: parseOpenGraph('', res.url), gated: true };
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let html = '';
      let bytes = 0;
      while (bytes < MAX_HEAD_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        html += decoder.decode(value, { stream: true });
        if (headDone(html)) break;
      }
      void reader.cancel().catch(() => undefined);
      return { meta: parseOpenGraph(html, res.url), gated };
    } catch (e) {
      log.info('page fetch failed', { code: (e as Error)?.name ?? 'unknown' });
      return null;
    }
  }

  private async fetchImage(url: string, itemId: string): Promise<string | null> {
    if (!isFetchableAddress(url)) return null;
    try {
      const res = await this.session().fetch(url, { credentials: 'omit', headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      const ext = PREVIEW_IMAGE_TYPES[(res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()];
      if (!res.ok || !ext || Number(res.headers.get('content-length') ?? 0) > MAX_IMAGE_BYTES) return null;
      const data = Buffer.from(await res.arrayBuffer());
      if (data.length === 0 || data.length > MAX_IMAGE_BYTES || !this.store.getItem(itemId)) return null;
      const name = `${itemId}.${ext}`;
      this.write(name, data);
      return name;
    } catch (e) {
      log.info('image fetch failed', { code: (e as Error)?.name ?? 'unknown' });
      return null;
    }
  }

  private write(name: string, data: Buffer): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, name), data);
  }
}
