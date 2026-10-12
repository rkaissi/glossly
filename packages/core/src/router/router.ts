import type { Identity, Settings } from '../settings';
import { extractFeatures, type Features } from './features';
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

export interface RouterDeps {
  /** The model-backed provider, or null when no key or model is configured. */
  decision: DecisionProvider | null;
  settings: () => Pick<Settings, 'router' | 'privacy'>;
  collections: () => string[];
  people?: () => KnownPerson[];
  /** The user's identity, to tell their own messages apart. */
  identity?: () => Identity;
  now?: () => number;
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

    let decisions: Decisions | null = null;
    let fallback: RouteResult['fallback'] = null;
    let fellBack = false;
    // Local only routes by rules even with a local model: one rarely answers inside the budget.
    if (settings.privacy === 'local') fallback = 'local_only';
    else if (!this.deps.decision) fallback = 'no_model';
    else {
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
        const r = await Promise.race([this.deps.decision.decide(input, ctl.signal, onFallback), timeout]);
        if (r === 'timeout') {
          fallback = 'timeout';
          ctl.abort();
        } else decisions = r;
      } catch {
        fallback = 'error';
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }
    }

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

  private now(): number {
    return (this.deps.now ?? performance.now.bind(performance))();
  }
}
