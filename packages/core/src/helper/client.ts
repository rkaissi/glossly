import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import {
  Commands,
  EventSchema,
  ResponseSchema,
  type CommandArgs,
  type CommandName,
  type CommandResult,
  type HelperErrorCode,
  type HelperEvent,
} from './protocol';

export class HelperError extends Error {
  constructor(
    readonly code: HelperErrorCode | 'timeout' | 'closed' | 'invalid_response',
    message: string,
  ) {
    super(message);
    this.name = 'HelperError';
  }
}

/** Per-command timeouts in ms. UIA calls are bounded to about 1 s inside the helper. */
export const DEFAULT_TIMEOUTS: Record<CommandName, number> = {
  ping: 2000,
  selection: 2500,
  context: 2500,
  context_container: 3000,
  foreground: 1000,
  popups_near: 1500,
  baseline: 1500,
  copy_fallback: 2500,
  restore_focus: 2000,
  window_corners: 1000,
  paste: 4000,
  mouse_hook: 2000,
  input_watch: 2000,
};

interface Pending {
  cmd: CommandName;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface HelperClientEvents {
  event: [HelperEvent];
  ready: [Extract<HelperEvent, { event: 'ready' }>];
  close: [];
  /** A line that was not valid protocol. Contains no screen text, only the reason. */
  protocol_error: [string];
}

/**
 * JSON-lines client for the native helper over any stdin/stdout pair. Works with a child
 * process in the app and with in-memory streams in tests.
 */
export class HelperClient extends EventEmitter<HelperClientEvents> {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closed = false;

  constructor(
    private readonly input: Writable,
    output: Readable,
    private readonly timeouts: Partial<Record<CommandName, number>> = {},
  ) {
    super();
    const rl = createInterface({ input: output });
    rl.on('line', (line) => this.onLine(line));
    rl.on('close', () => this.close());
  }

  request<C extends CommandName>(cmd: C, args?: CommandArgs<C>): Promise<CommandResult<C>> {
    if (this.closed) return Promise.reject(new HelperError('closed', 'Helper is not running'));
    const id = this.nextId++;
    const ms = this.timeouts[cmd] ?? DEFAULT_TIMEOUTS[cmd];
    return new Promise<CommandResult<C>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HelperError('timeout', `${cmd} timed out after ${ms} ms`));
      }, ms);
      this.pending.set(id, { cmd, resolve: resolve as (v: unknown) => void, reject, timer });
      this.input.write(JSON.stringify({ id, cmd, ...(args ?? {}) }) + '\n');
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new HelperError('closed', 'Helper exited'));
    }
    this.pending.clear();
    this.emit('close');
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      this.emit('protocol_error', 'invalid JSON');
      return;
    }
    if (typeof msg === 'object' && msg !== null && 'event' in msg) {
      const ev = EventSchema.safeParse(msg);
      if (!ev.success) {
        this.emit('protocol_error', `bad event: ${String((msg as { event: unknown }).event)}`);
        return;
      }
      if (ev.data.event === 'ready') this.emit('ready', ev.data);
      this.emit('event', ev.data);
      return;
    }

    const res = ResponseSchema.safeParse(msg);
    if (!res.success || typeof res.data.id !== 'number') {
      this.emit('protocol_error', 'bad response');
      return;
    }
    const p = this.pending.get(res.data.id);
    if (!p) return; // timed out earlier
    this.pending.delete(res.data.id);
    clearTimeout(p.timer);

    if (!res.data.ok) {
      p.reject(new HelperError(res.data.error.code, res.data.error.message));
      return;
    }
    const parsed = Commands[p.cmd].result.safeParse(res.data.result);
    if (parsed.success) p.resolve(parsed.data);
    else p.reject(new HelperError('invalid_response', `${p.cmd}: ${parsed.error.issues[0]?.message ?? 'invalid'}`));
  }
}
