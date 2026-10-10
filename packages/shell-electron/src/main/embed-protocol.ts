import type { EmbedProgress } from '@glossly/core';

export type WorkerRequest =
  | { type: 'init'; model: string; dims: number; cacheDir: string }
  | { type: 'embed'; id: number; texts: string[] };

export type WorkerResponse =
  | { type: 'progress'; progress: EmbedProgress }
  | { type: 'ready' }
  | { type: 'result'; id: number; vectors?: number[][]; error?: string };
