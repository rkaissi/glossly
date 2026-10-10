export interface Embedder {
  readonly model: string;
  readonly dims: number;
  /** One unit-length vector per input text. */
  embed(texts: string[]): Promise<Float32Array[]>;
}

export interface EmbedProgress {
  status: 'downloading' | 'loading' | 'ready' | 'error';
  /** 0 to 100 while downloading. */
  progress?: number;
  file?: string;
  message?: string;
}
