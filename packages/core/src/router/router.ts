import type { Identity, Settings } from '../settings';
import { extractFeatures, type Features } from './features';
import { fieldReplyScore, readField, type FieldInput, type FieldRead } from './field';
import { decideByRules } from './rules';
import { assignSlots } from './slots';
import type { DecisionProvider, Decisions, KnownPerson, SelectionContext, Slots } from './types';

export interface RouteResult {
  decisions: Decisions;
  slots: Slots;
  features: Features;
  /** Total routing time, ms. */
  ms: number;
  /** Why the model decision was not used, if it was not. Never contains text. */
  fallback: null | 'local_only' | 'no_model' | 'timeout' | 'error';
  /** The call moved to the router's fallback model, so it had the longer budget (decision 60). */
  fellBack: boolean;
  /**
   * What the rules alone would show, beside a model answer, so real use measures where the two
   * disagree (decision 61). Null when the rules were what was used.
   */
  rules: { decisions: Decisions; slots: Slots } | null;
}

/** Nothing selected: whether the focused field answers someone, so the empty bar offers Reply (decision 75). */
export interface FieldRoute {
  read: FieldRead | null;
  /** The Reply score for the empty bar. */
  score: number;
  /** The model's raw score, null when the rules were what was used. */
  model: number | null;
  ms: number;
  fallback: RouteResult['fallback'];
  fellBack: boolean;
}

/** The model's read of a field with nothing selected (`decideField`). */
export type FieldDecider = (input: FieldInput, signal?: AbortSignal, onFallback?: () => void) => Promise<number>;

export interface RouterDeps {
  /** The model-backed provider, or null when no key or model is configured. */
  decision: DecisionProvider | null;
  /** The model's read of a field with nothing selected, or null without a model. */
  field?: FieldDecider | null;
  settings: () => Pick<Settings, 'router' | 'privacy'>;
  collections: () => string[];
  people?: () => KnownPerson[];
  /** The user's identity, to tell their own messages apart. */
  identity?: () => Identity;
  now?: () => number;
}

interface Budgeted<T> {
  value: T | null;
  fallback: RouteResult['fallback'];
  fellBack: boolean;
}

export class Router {
  constructor(private readonly deps: RouterDeps) {}

  /** Rules only: instant, used to paint the bar before the model answers. */
  quick(context: SelectionContext): RouteResult {
    const start = this.now();
    const features = extractFeatures(context, this.deps.people?.() ?? [], this.deps.identity?.());
    const decisions = decideByRules({ context, features, collections: this.deps.collections() });
    return {
      decisions,
      features,
      slots: assignSlots(decisions, features, this.deps.settings().router),
      ms: this.now() - start,
      fallback: null,
      fellBack: false,
      rules: null,
    };
  }

  async route(context: SelectionContext, signal?: AbortSignal): Promise<RouteResult> {
    const start = this.now();
    const settings = this.deps.settings();
    const features = extractFeatures(context, this.deps.people?.() ?? [], this.deps.identity?.());
    const input = { context, features, collections: this.deps.collections() };
    const decision = this.deps.decision;
    const { value: decisions, fallback, fellBack } = await this.withBudget(decision && ((s, f) => decision.decide(input, s, f)), start, signal);

    const rules = decideByRules(input);
    const ms = this.now() - start;
    return {
      decisions: decisions ?? rules,
      features,
      slots: assignSlots(decisions ?? rules, features, settings.router),
      ms,
      fallback,
      fellBack,
      rules: decisions ? { decisions: rules, slots: assignSlots(rules, features, settings.router) } : null,
    };
  }

  /** Nothing selected, rules only: instant, for the empty bar's first paint. */
  quickField(input: FieldInput): FieldRoute {
    const start = this.now();
    const read = this.readField(input);
    return { read, score: fieldReplyScore(read, null), model: null, ms: this.now() - start, fallback: null, fellBack: false };
  }

  /** True when `routeField` will spend a model call: there's a thread and someone to answer. */
  fieldWillCallModel(input: FieldInput): boolean {
    if (this.deps.settings().privacy === 'local' || !this.deps.field) return false;
    const read = this.readField(input);
    return Boolean(read && !read.blocked);
  }

  /**
   * Nothing selected: does the focused field answer someone? The model's read under the router's
   * budget, the rules' when it doesn't answer. No call when the rules found no thread or nobody to
   * answer, since the model couldn't change the score.
   */
  async routeField(input: FieldInput, signal?: AbortSignal): Promise<FieldRoute> {
    const start = this.now();
    const read = this.readField(input);
    const field = this.deps.field;
    const call = read && !read.blocked && field ? (s: AbortSignal, f: () => void) => field(input, s, f) : null;
    const { value: model, fallback, fellBack } = await this.withBudget(call, start, signal);
    return { read, score: fieldReplyScore(read, model), model, ms: this.now() - start, fallback, fellBack };
  }

  /**
   * The same decisions with features read from another context: more of the conversation from
   * tier 2, when tier 1 had no header to say whose message it is (decision 51). No model call.
   */
  rescore(r: RouteResult, context: SelectionContext): RouteResult {
    const features = extractFeatures(context, this.deps.people?.() ?? [], this.deps.identity?.());
    const thresholds = this.deps.settings().router;
    return {
      ...r,
      features,
      slots: assignSlots(r.decisions, features, thresholds),
      rules: r.rules && { decisions: r.rules.decisions, slots: assignSlots(r.rules.decisions, features, thresholds) },
    };
  }

  private readField(input: FieldInput): FieldRead | null {
    return readField(input, this.deps.people?.() ?? [], this.deps.identity?.());
  }

  /**
   * A model call inside the router's budget. Local only routes by rules even with a local model:
   * one rarely answers inside the budget.
   */
  private async withBudget<T>(call: ((signal: AbortSignal, onFallback: () => void) => Promise<T>) | null, start: number, signal?: AbortSignal): Promise<Budgeted<T>> {
    const settings = this.deps.settings();
    if (settings.privacy === 'local') return { value: null, fallback: 'local_only', fellBack: false };
    if (!call) return { value: null, fallback: 'no_model', fellBack: false };
    let fellBack = false;
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let expire!: () => void;
    const timeout = new Promise<'timeout'>((resolve) => {
      expire = () => resolve('timeout');
      timer = setTimeout(expire, settings.router.decisionTimeoutMs);
    });
    // Once the call moves to the fallback model (a 429, a 5xx, or a 429 remembered), it gets
    // the longer budget, counted from the start (decision 60).
    const onFallback = () => {
      if (fellBack) return;
      fellBack = true;
      clearTimeout(timer);
      timer = setTimeout(expire, Math.max(0, settings.router.fallbackTimeoutMs - (this.now() - start)));
    };
    try {
      const r = await Promise.race([call(ctl.signal, onFallback), timeout]);
      if (r === 'timeout') {
        ctl.abort();
        return { value: null, fallback: 'timeout', fellBack };
      }
      return { value: r, fallback: null, fellBack };
    } catch {
      return { value: null, fallback: 'error', fellBack };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  private now(): number {
    return (this.deps.now ?? performance.now.bind(performance))();
  }
}
