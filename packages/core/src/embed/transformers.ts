import { env, pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';
import type { Embedder, EmbedProgress } from './types';

export interface TransformersEmbedderOptions {
  model: string;
  dims: number;
  /** Where downloaded model files are cached (the app data dir). */
  cacheDir: string;
  onProgress?: (p: EmbedProgress) => void;
}

/**
 * Local embeddings with transformers.js. Runs in the Electron utility process so the UI never
 * blocks. The model is downloaded once into cacheDir on first use.
 */
export async function createTransformersEmbedder(opts: TransformersEmbedderOptions): Promise<Embedder> {
  env.cacheDir = opts.cacheDir;
  env.allowRemoteModels = true;
  env.allowLocalModels = true;

  // The host shows "loading" or "downloading" from the start; this only reports the download.
  let extractor: FeatureExtractionPipeline;
  try {
    extractor = (await pipeline('feature-extraction', opts.model, {
      dtype: 'fp32',
      // `progress_total` covers every file, sized before any starts, so it only goes up; the
      // per-file `progress` events restarted the bar for each file. Once all bytes are in, the
      // model still has to load.
      progress_callback: (p: { status: string; progress?: number }) => {
        if (p.status !== 'progress_total' || p.progress === undefined) return;
        opts.onProgress?.(p.progress >= 100 ? { status: 'loading' } : { status: 'downloading', progress: p.progress });
      },
    })) as FeatureExtractionPipeline;
  } catch (e) {
    opts.onProgress?.({ status: 'error', message: (e as Error).message });
    throw e;
  }
  opts.onProgress?.({ status: 'ready' });

  return {
    model: opts.model,
    dims: opts.dims,
    async embed(texts: string[]): Promise<Float32Array[]> {
      if (texts.length === 0) return [];
      const out = await extractor(texts, { pooling: 'mean', normalize: true });
      const data = out.data as Float32Array;
      const dims = out.dims[out.dims.length - 1]!;
      if (dims !== opts.dims) throw new Error(`Embedding model returned ${dims} dims, expected ${opts.dims}`);
      return texts.map((_, i) => data.slice(i * dims, (i + 1) * dims));
    },
  };
}
