import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import {
  HelperClient,
  HelperError,
  type CommandArgs,
  type CommandName,
  type CommandResult,
  type HelperEvent,
} from '@glossly/core';
import { errorInfo, logger } from './log';
import { helperExists, helperPath } from './paths';

const log = logger('helper');

const MIN_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 10_000;
/** A helper that stayed up this long resets the backoff. */
const HEALTHY_MS = 60_000;

interface HelperManagerEvents {
  event: [HelperEvent];
  ready: [];
  down: [];
}

/**
 * Owns the native helper process: spawns it, restarts it with backoff when it exits, and
 * turns the mouse hook back on after every start.
 */
export class HelperManager extends EventEmitter<HelperManagerEvents> {
  private child: ChildProcessWithoutNullStreams | null = null;
  private client: HelperClient | null = null;
  private ready = false;
  private stopped = false;
  private backoff = MIN_BACKOFF_MS;
  private startedAt = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private mouseHook = true;

  get isReady(): boolean {
    return this.ready;
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  start(): void {
    this.stopped = false;
    if (this.child) return;
    const path = helperPath();
    if (!helperExists()) {
      log.error('helper binary not found; run pnpm helper:build', { path });
      return;
    }
    this.startedAt = Date.now();
    const child = spawn(path, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;
    const client = new HelperClient(child.stdin, child.stdout);
    this.client = client;

    createInterface({ input: child.stderr }).on('line', (line) => log.info(`stderr: ${line.slice(0, 300)}`));
    client.on('protocol_error', (reason) => log.warn('protocol error', { reason }));
    client.on('event', (ev) => this.emit('event', ev));
    client.on('ready', (ev) => {
      this.ready = true;
      log.info('ready', { version: ev.version, protocol: ev.protocol, pid: ev.pid });
      void this.applyMouseHook();
      this.emit('ready');
    });
    child.stdin.on('error', () => {
      /* EPIPE when the helper dies; the exit handler restarts it */
    });
    child.on('error', (e) => log.error('spawn failed', errorInfo(e)));
    child.on('exit', (code, signal) => this.onExit(child, code, signal));
  }

  stop(): void {
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const child = this.child;
    this.client?.close();
    // Closing stdin makes the helper exit on its own; kill it if it doesn't.
    child?.stdin.end();
    if (child) setTimeout(() => child.exitCode === null && child.kill(), 1000).unref();
  }

  async request<C extends CommandName>(cmd: C, args?: CommandArgs<C>): Promise<CommandResult<C>> {
    if (!this.client || !this.ready) throw new HelperError('closed', 'Helper is not running');
    return this.client.request(cmd, args);
  }

  async setMouseHook(enabled: boolean): Promise<void> {
    this.mouseHook = enabled;
    if (this.ready) await this.applyMouseHook();
  }

  private async applyMouseHook(): Promise<void> {
    try {
      await this.request('mouse_hook', { enabled: this.mouseHook });
    } catch (e) {
      log.error('mouse_hook failed', { code: (e as HelperError).code });
    }
  }

  private onExit(child: ChildProcessWithoutNullStreams, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.child !== child) return;
    this.child = null;
    this.client?.close();
    this.client = null;
    const wasReady = this.ready;
    this.ready = false;
    if (wasReady) this.emit('down');
    if (this.stopped) return;

    if (Date.now() - this.startedAt > HEALTHY_MS) this.backoff = MIN_BACKOFF_MS;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    log.warn('helper exited; restarting', { code, signal, delay });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.start();
    }, delay);
  }
}
