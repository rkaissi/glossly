import type { Store } from './store/store';
import { isoNow } from './types';

/** Kinds the shell and actions record. Any identifier is accepted; these are the ones summarized. */
export type MetricKind =
  | 'hotkey'
  | 'pill_shown'
  | 'bar_shown'
  | 'action_clicked'
  | 'router_done'
  | 'llm_fallback'
  | 'ask_done'
  | 'ask_error'
  | 'save_done'
  | 'save_undone'
  | 'save_enrich_error'
  | (string & {});

export type MetricValue = number | boolean | string;
export type MetricPayload = Record<string, MetricValue>;

const IDENT = /^[\w.:-]{1,40}$/;
const MAX_KEYS = 20;

/**
 * Keeps only finite numbers, booleans, and short identifier strings. Anything that could be
 * user text (spaces, long strings, objects, arrays) is dropped, so selections never reach the log.
 */
export function sanitizePayload(payload: Record<string, unknown> | null | undefined): MetricPayload | null {
  if (!payload || typeof payload !== 'object') return null;
  const out: MetricPayload = {};
  let n = 0;
  for (const [k, v] of Object.entries(payload)) {
    if (n >= MAX_KEYS) break;
    if (!IDENT.test(k)) continue;
    if (typeof v === 'number' ? Number.isFinite(v) : typeof v === 'boolean' || (typeof v === 'string' && IDENT.test(v))) {
      out[k] = v as MetricValue;
      n++;
    }
  }
  return n > 0 ? out : null;
}

export interface DayMetrics {
  /** Local date, YYYY-MM-DD. */
  date: string;
  hotkey: number;
  pill_shown: number;
  bar_shown: number;
  /** action_clicked counts by action name. */
  actions: Record<string, number>;
}

export interface ActionMetrics {
  clicks: number;
  /** Clicks divided by triggers (hotkey presses plus pills shown). */
  click_rate: number;
  /** Median ms from the trigger to the click, or null without timing data. */
  median_ms: number | null;
}

/** How the Phase 2 and 3 features were used (spec: Evals and local metrics). Counts over the range. */
export interface FeatureMetrics {
  /** Saves by how they were made: panel, hotkey, autosave, ask, visualize. */
  saves: Record<string, number>;
  undone: number;
  recall: { shown: number; opened: number; dismissed: number };
  /** Reply: draft sets written, then what happened to them. `own` replies are in `inserted` too. */
  reply: { drafts: number; inserted: number; edited: number; own: number; copied: number; discarded: number; redo: number };
  paste: { composed: number; inserted: number };
  promises: { extracted: number; saved: number };
  search: { inserted: number };
  /** Failed model calls across actions (rate limits, bad output, provider errors), and switches to a fallback model. */
  errors: number;
  fallbacks: number;
  /** Model calls and their tokens by action ("who", "reply", ...), from `llm_tokens` (decision 48). */
  tokens: Record<string, TokenTotals>;
}

export interface TokenTotals {
  calls: number;
  input: number;
  output: number;
  cached: number;
}

export interface MetricsSummary {
  days: DayMetrics[];
  totals: { hotkey: number; pill_shown: number; bar_shown: number; triggers: number };
  /** Bars opened from a pill (bar_shown with trigger "auto") divided by pills shown. */
  expand_rate: number;
  actions: Record<string, ActionMetrics>;
  features: FeatureMetrics;
}

const ERROR_KINDS = new Set(['ask_error', 'reply_error', 'paste_error', 'promises_error', 'visualize_error']);

function emptyFeatures(): FeatureMetrics {
  return {
    saves: {},
    undone: 0,
    recall: { shown: 0, opened: 0, dismissed: 0 },
    reply: { drafts: 0, inserted: 0, edited: 0, own: 0, copied: 0, discarded: 0, redo: 0 },
    paste: { composed: 0, inserted: 0 },
    promises: { extracted: 0, saved: 0 },
    search: { inserted: 0 },
    errors: 0,
    fallbacks: 0,
    tokens: {},
  };
}

/** Adds one event to the feature counts. */
function countFeature(f: FeatureMetrics, kind: string, p: Record<string, unknown>): void {
  switch (kind) {
    case 'save_done': {
      const via = typeof p.via === 'string' ? p.via : 'panel';
      f.saves[via] = (f.saves[via] ?? 0) + 1;
      break;
    }
    case 'save_undone':
      f.undone++;
      break;
    case 'recall_shown':
      f.recall.shown++;
      break;
    case 'recall_opened':
      f.recall.opened++;
      break;
    case 'recall_dismissed':
      f.recall.dismissed++;
      break;
    case 'reply_drafts':
      f.reply.drafts++;
      break;
    case 'reply_inserted':
      f.reply.inserted++;
      if (p.edited === true) f.reply.edited++;
      if (p.own === true) f.reply.own++;
      break;
    case 'reply_copied':
      f.reply.copied++;
      break;
    case 'reply_discarded':
      f.reply.discarded++;
      break;
    case 'reply_redo':
      f.reply.redo++;
      break;
    case 'paste_composed':
      f.paste.composed++;
      break;
    case 'paste_inserted':
      f.paste.inserted++;
      break;
    case 'promises_extracted':
      f.promises.extracted++;
      break;
    case 'promises_saved':
      f.promises.saved++;
      break;
    case 'search_inserted':
      f.search.inserted++;
      break;
    case 'llm_fallback':
      f.fallbacks++;
      break;
    case 'llm_tokens': {
      const action = typeof p.action === 'string' ? p.action : 'other';
      const t = (f.tokens[action] ??= { calls: 0, input: 0, output: 0, cached: 0 });
      const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
      t.calls++;
      t.input += n(p.input);
      t.output += n(p.output);
      t.cached += n(p.cached);
      break;
    }
    default:
      if (ERROR_KINDS.has(kind) && p.code !== 'aborted') f.errors++;
  }
}

function localDate(d: Date): string {
  return isoNow(d).slice(0, 10);
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Local usage metrics in the events table. Nothing here is ever sent anywhere. */
export class Metrics {
  constructor(
    private readonly store: Store,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Records one event. For action_clicked, pass `action` and `ms` (time since the trigger).
   * Never throws: metrics must not break the feature they measure.
   */
  record(kind: MetricKind, payload?: Record<string, unknown> | null): void {
    if (!IDENT.test(kind)) return;
    try {
      this.store.insertEvent(kind, sanitizePayload(payload), isoNow(this.now()));
    } catch {
      /* best effort */
    }
  }

  /** Per-day counts for the last `days` local days, including today. */
  summary(days = 7): MetricsSummary {
    const count = Math.max(1, Math.trunc(days));
    const today = this.now();
    const dates: string[] = [];
    for (let i = count - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      dates.push(localDate(d));
    }
    const byDate = new Map<string, DayMetrics>(dates.map((date) => [date, { date, hotkey: 0, pill_shown: 0, bar_shown: 0, actions: {} }]));
    const totals = { hotkey: 0, pill_shown: 0, bar_shown: 0, triggers: 0 };
    let expanded = 0;
    const clicks: Record<string, number> = {};
    const timings: Record<string, number[]> = {};
    const features = emptyFeatures();

    for (const e of this.store.listEvents(dates[0])) {
      const day = byDate.get(e.at.slice(0, 10));
      if (!day) continue;
      const p = e.payload ?? {};
      if (e.kind === 'hotkey' || e.kind === 'pill_shown' || e.kind === 'bar_shown') {
        day[e.kind]++;
        totals[e.kind]++;
        if (e.kind === 'bar_shown' && p.trigger === 'auto') expanded++;
      } else if (e.kind === 'action_clicked' && typeof p.action === 'string') {
        day.actions[p.action] = (day.actions[p.action] ?? 0) + 1;
        clicks[p.action] = (clicks[p.action] ?? 0) + 1;
        if (typeof p.ms === 'number' && p.ms >= 0) (timings[p.action] ??= []).push(p.ms);
      } else countFeature(features, e.kind, p);
    }
    totals.triggers = totals.hotkey + totals.pill_shown;

    const actions: Record<string, ActionMetrics> = {};
    for (const [action, n] of Object.entries(clicks)) {
      actions[action] = {
        clicks: n,
        click_rate: totals.triggers > 0 ? n / totals.triggers : 0,
        median_ms: median(timings[action] ?? []),
      };
    }
    return {
      days: dates.map((d) => byDate.get(d)!),
      totals,
      expand_rate: totals.pill_shown > 0 ? expanded / totals.pill_shown : 0,
      actions,
      features,
    };
  }
}
