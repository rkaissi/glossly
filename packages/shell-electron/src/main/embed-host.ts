import { EventEmitter } from 'node:events';
import { utilityProcess, type UtilityProcess } from 'electron';
import { embedText, type Embedder, type EmbedStatus, type Store } from '@glossly/core';
import type { WorkerRequest, WorkerResponse } from './embed-protocol';
import { logger } from './log';
import { embedWorkerPath } from './paths';

const log = logger('embed');
const EMBED_TIMEOUT_MS = 30_000;
const BACKFILL_BATCH = 16;

interface Pending {
  resolve: (v: Float32Array[]) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Runs the transformers.js embedder in a utility process. `embedder()` is null until the
 * model is downloaded and loaded; Save works without it and items are backfilled later.
 */
export class EmbedHost extends EventEmitter<{ status: [EmbedStatus] }> {
  private proc: UtilityProcess | null = null;
  private status: Omit<EmbedStatus, 'pending'>;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readyEmbedder: Embedder | null = null;
  private backfilling = false;

  constructor(
    private readonly store: Store,
    private readonly model: string,
    private readonly dims: number,
    private readonly cacheDir: string,
  ) {
    super();
    const downloaded = store.getMeta('embed_downloaded') === model;
    this.status = { model, dims, state: downloaded ? 'loading' : 'not_downloaded' };
  }

  get downloaded(): boolean {
    return this.store.getMeta('embed_downloaded') === this.model;
  }

  embedder(): Embedder | null {
    return this.readyEmbedder;
  }

  getStatus(): EmbedStatus {
    return { ...this.status, pending: this.pendingCount() };
  }

  /** Starts the worker, which downloads the model on first use. Safe to call twice. */
  start(): void {
    if (this.proc) return;
    const proc = utilityProcess.fork(embedWorkerPath(), [], { serviceName: 'Glossly embeddings', stdio: 'pipe' });
    this.proc = proc;
    proc.stdout?.on('data', () => {});
    proc.stderr?.on('data', (d: Buffer) => log.warn(`worker stderr: ${d.toString().slice(0, 300)}`));
    proc.on('message', (msg: WorkerResponse) => this.onMessage(msg));
    proc.on('exit', (code) => {
      // Stopped on purpose: Glossly is quitting and the store is closed (it showed an error box at quit).
      if (this.proc !== proc) return;
      log.warn('worker exited', { code });
      this.proc = null;
      this.readyEmbedder = null;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error('worker_exited'));
      }
      this.pending.clear();
      if (this.status.state !== 'error') this.setStatus({ state: this.downloaded ? 'loading' : 'not_downloaded' });
    });
    this.setStatus({ state: this.downloaded ? 'loading' : 'downloading', progress: 0 });
    this.post({ type: 'init', model: this.model, dims: this.dims, cacheDir: this.cacheDir });
  }

  /** At quit: ends the worker and drops what was waiting on it, without touching the store. */
  stop(): void {
    const proc = this.proc;
    this.proc = null;
    this.readyEmbedder = null;
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
    proc?.kill();
  }

  private post(msg: WorkerRequest): void {
    this.proc?.postMessage(msg);
  }

  private onMessage(msg: WorkerResponse): void {
    if (msg.type === 'progress') {
      const p = msg.progress;
      this.setStatus({ state: p.status, progress: p.progress, message: p.message });
      if (p.status === 'error') log.error('embedder failed to load');
    } else if (msg.type === 'ready') {
      this.store.setMeta('embed_downloaded', this.model);
      this.readyEmbedder = { model: this.model, dims: this.dims, embed: (texts) => this.embed(texts) };
      this.setStatus({ state: 'ready', progress: undefined, message: undefined });
      log.info('embedder ready', { model: this.model });
      void this.backfill();
    } else if (msg.type === 'result') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error || !msg.vectors) p.reject(new Error(msg.error ?? 'embed_failed'));
      else p.resolve(msg.vectors.map((v) => Float32Array.from(v)));
    }
  }

  private embed(texts: string[]): Promise<Float32Array[]> {
    if (!this.proc) return Promise.reject(new Error('not_ready'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('embed_timeout'));
      }, EMBED_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.post({ type: 'embed', id, texts });
    });
  }

  /** Embeds items saved while the model was unavailable. */
  async backfill(): Promise<void> {
    if (this.backfilling || !this.readyEmbedder) return;
    this.backfilling = true;
    let done = 0;
    try {
      for (;;) {
        const items = this.store.itemsWithoutVectors(BACKFILL_BATCH);
        if (items.length === 0) break;
        const vectors = await this.embed(items.map(embedText));
        items.forEach((item, i) => {
          const v = vectors[i];
          if (v && this.store.getItem(item.id)) this.store.setVector(item.id, v);
        });
        done += items.length;
        this.emit('status', this.getStatus());
      }
    } catch (e) {
      log.error('backfill stopped', { message: (e as Error).message.slice(0, 100) });
    } finally {
      this.backfilling = false;
      if (done > 0) log.info('backfill done', { items: done });
    }
  }

  private pendingCount(): number {
    try {
      return this.store.itemsWithoutVectors(10_000).length;
    } catch {
      return 0;
    }
  }

  private setStatus(patch: Partial<Omit<EmbedStatus, 'pending'>>): void {
    this.status = { ...this.status, ...patch };
    this.emit('status', this.getStatus());
  }
}
