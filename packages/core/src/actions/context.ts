import type { ContainerContext, SelectionPayload } from '../types';

export interface ContextWindow {
  text: string;
  /** Where the selection sits inside `text`. */
  selection_start: number;
  selection_length: number;
  source: 'container' | 'tier1';
}

/**
 * The selection with the surrounding text, at most `maxChars` long and centered on the
 * selection. Uses tier-2 context when it was read, else tier 1. A selection longer than
 * `maxChars` is cut to its first `maxChars` characters.
 */
export function contextWindow(selection: SelectionPayload, container: ContainerContext | null | undefined, maxChars: number): ContextWindow {
  let full: string;
  let start: number;
  let len: number;
  let source: ContextWindow['source'];
  if (container && container.source === 'container' && container.text) {
    full = container.text;
    start = Math.min(Math.max(container.selection_start, 0), full.length);
    len = Math.min(Math.max(container.selection_length, 0), full.length - start);
    source = 'container';
  } else {
    full = selection.context_before + selection.text + selection.context_after;
    start = selection.context_before.length;
    len = selection.text.length;
    source = 'tier1';
  }

  const n = Math.max(0, Math.trunc(maxChars));
  if (full.length <= n) return { text: full, selection_start: start, selection_length: len, source };
  if (len >= n) return { text: full.slice(start, start + n), selection_start: 0, selection_length: n, source };

  const spare = n - len;
  let before = Math.floor(spare / 2);
  let after = spare - before;
  const availBefore = start;
  const availAfter = full.length - (start + len);
  if (availBefore < before) {
    after += before - availBefore;
    before = availBefore;
  } else if (availAfter < after) {
    before += after - availAfter;
    after = availAfter;
  }
  const from = start - before;
  return { text: full.slice(from, start + len + after), selection_start: before, selection_length: len, source };
}
