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
}

export interface RouterDeps {
  /** The model-backed provider, or null when no key or model is configured. */
  decision: DecisionProvider | null;
  settings: () => Pick<Settings, 'router' | 'localOnly'>;
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
    };
  }

  async route(context: SelectionContext, signal?: AbortSignal): Promise<RouteResult> {
    const start = this.now();
    const settings = this.deps.settings();
    const features = extractFeatures(context, this.deps.people?.() ?? [], this.deps.identity?.());
    const input = { context, features, collections: this.deps.collections() };

    let decisions: Decisions | null = null;
    let fallback: RouteResult['fallback'] = null;
    if (settings.localOnly) fallback = 'local_only';
    else if (!this.deps.decision) fallback = 'no_model';
    else {
      const ctl = new AbortController();
      const onAbort = () => ctl.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), settings.router.decisionTimeoutMs);
      });
      try {
        const r = await Promise.race([this.deps.decision.decide(input, ctl.signal), timeout]);
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

    decisions ??= decideByRules(input);
    return {
      decisions,
      features,
      slots: assignSlots(decisions, features, settings.router),
      ms: this.now() - start,
      fallback,
    };
  }

  private now(): number {
    return (this.deps.now ?? performance.now.bind(performance))();
  }
}
