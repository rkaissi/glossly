export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Point {
  x: number;
  y: number;
}

export type CaptureMethod = 'uia' | 'ax' | 'copy';
export type Trigger = 'auto' | 'hotkey';

/** The selection plus tier-1 context, as captured at trigger time. Never stored unless saved. */
export interface SelectionPayload {
  text: string;
  context_before: string;
  context_after: string;
  source_app: string;
  window_title: string;
  /** ISO 8601 with offset. */
  captured_at: string;
  method: CaptureMethod;
  trigger: Trigger;
  is_editable: boolean;
  foreground_handle: number;
}

/** Tier-2 context, read when the user clicks an action. */
export interface ContainerContext {
  text: string;
  selection_start: number;
  selection_length: number;
  source: 'container' | 'tier1';
}

export type CollectionName = string;

export interface Collection {
  id: string;
  name: string;
  created_at: string;
}

/**
 * What is around the user when the hotkey finds nothing selected: the text around the caret in
 * a field (`caret` is its offset), or the text visible on screen (`caret` -1). Read once, locally,
 * when the bar opens; sent to a model only by an action that uses it (Ask, Paste).
 */
export interface Surroundings {
  text: string;
  caret: number;
  source: 'caret' | 'visible';
}

export interface Item {
  id: string;
  collection_id: string | null;
  kind: 'selection' | 'note' | 'chart';
  text: string;
  why: string | null;
  source_app: string | null;
  window_title: string | null;
  data_json: string | null;
  created_at: string;
}

/** ISO 8601 timestamp with the local offset, e.g. 2026-10-09T20:41:00-04:00. */
export function isoNow(date: Date = new Date()): string {
  const off = -date.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const pad = (n: number, w = 2) => String(Math.trunc(Math.abs(n))).padStart(w, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(off / 60)}:${pad(off % 60)}`
  );
}
