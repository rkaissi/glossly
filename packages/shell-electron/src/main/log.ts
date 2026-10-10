import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Diagnostics only. Callers pass codes, counts, and timings; never selection, context, or keys.

let file: string | null = null;

export function initLog(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  file = path;
}

function write(level: string, scope: string, msg: string, extra?: Record<string, unknown>): void {
  const line = `${new Date().toISOString()} ${level} [${scope}] ${msg}${extra ? ` ${JSON.stringify(extra)}` : ''}`;
  (level === 'ERROR' ? console.error : console.log)(line);
  if (file) {
    try {
      appendFileSync(file, line + '\n');
    } catch {
      /* best effort */
    }
  }
}

export function logger(scope: string) {
  return {
    info: (msg: string, extra?: Record<string, unknown>) => write('INFO', scope, msg, extra),
    warn: (msg: string, extra?: Record<string, unknown>) => write('WARN', scope, msg, extra),
    error: (msg: string, extra?: Record<string, unknown>) => write('ERROR', scope, msg, extra),
  };
}

export function errorInfo(e: unknown): { name: string; code?: string } {
  const err = e as { name?: unknown; code?: unknown };
  return {
    name: typeof err?.name === 'string' ? err.name : 'unknown',
    ...(typeof err?.code === 'string' && { code: err.code }),
  };
}
