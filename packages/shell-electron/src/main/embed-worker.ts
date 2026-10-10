// Utility process: loads the local embedding model and answers embed requests from main.
import type { Embedder } from '@glossly/core';
import { createTransformersEmbedder } from '@glossly/core/embed';
import type { WorkerRequest, WorkerResponse } from './embed-protocol';

const port = process.parentPort;
let embedder: Embedder | null = null;

const send = (msg: WorkerResponse) => port.postMessage(msg);

port.on('message', async (e: { data: WorkerRequest }) => {
  const msg = e.data;
  if (msg.type === 'init') {
    try {
      embedder = await createTransformersEmbedder({
        model: msg.model,
        dims: msg.dims,
        cacheDir: msg.cacheDir,
        onProgress: (p) => send({ type: 'progress', progress: p }),
      });
      send({ type: 'ready' });
    } catch (err) {
      send({ type: 'progress', progress: { status: 'error', message: (err as Error).message.slice(0, 300) } });
    }
    return;
  }
  if (msg.type === 'embed') {
    if (!embedder) {
      send({ type: 'result', id: msg.id, error: 'not_ready' });
      return;
    }
    try {
      const vectors = await embedder.embed(msg.texts);
      send({ type: 'result', id: msg.id, vectors: vectors.map((v) => Array.from(v)) });
    } catch (err) {
      send({ type: 'result', id: msg.id, error: (err as Error).name || 'error' });
    }
  }
});
