import capabilitiesFile from '../../models/capabilities.json';
import type { ModelRef, RoleName } from '../settings';

export type Tier = 'low' | 'medium' | 'high';
export type Speed = 'slow' | 'medium' | 'fast';

export interface Capabilities {
  structured: 'json_schema' | 'json' | 'none';
  streaming: boolean;
  tools: boolean;
  context: number;
  cost: Tier;
  speed: Speed;
  tier: number;
  /** Reasoning effort for structured calls on reasoning models; reasoning tokens count against the output cap. */
  reasoning?: 'none' | 'minimal' | 'low';
}

/** Dollars per million tokens, from the provider's own model list. */
export interface Price {
  input: number;
  output: number;
}

export interface CatalogModel {
  provider: string;
  modelId: string;
  ref: ModelRef;
  displayName: string;
  /**
   * Null means "Untested": selectable by hand, never auto-assigned. Its `speed` is the measured
   * one once there is one (decision 79).
   */
  capabilities: Capabilities | null;
  /** The price the provider lists, when its model list has one. */
  price: Price | null;
  /** Cost from `capabilities`, else from `price`, else null. */
  cost: Tier | null;
  /** Speed worked out from this computer's own calls to the model, once there are enough (decision 79). */
  measured: Speed | null;
}

interface CapabilityEntry extends Capabilities {
  provider: string;
  pattern: string;
}

interface CapabilityFile {
  exclude: string[];
  models: CapabilityEntry[];
}

const file = capabilitiesFile as unknown as CapabilityFile;
const exclude = file.exclude.map((p) => new RegExp(p, 'i'));
const entries = file.models.map((m) => ({ ...m, re: new RegExp(m.pattern, 'i') }));

/** Provider id of the local model server in model refs ("local:llama3.2:latest"). */
export const LOCAL_PROVIDER = 'local';

export const toRef = (provider: string, modelId: string): ModelRef => `${provider}:${modelId}`;

export function parseRef(ref: ModelRef): { provider: string; modelId: string } {
  const i = ref.indexOf(':');
  return { provider: ref.slice(0, i), modelId: ref.slice(i + 1) };
}

/** Text chat models only: drops embeddings, audio, image, moderation, and deprecated models. */
export function isChatModel(modelId: string): boolean {
  return !exclude.some((re) => re.test(modelId));
}

/** Providers with their own entries in the capabilities file. */
const listedProviders = new Set(entries.map((e) => e.provider));

/** A gateway's vendor prefix ("x-ai/grok-4", "deepseek-ai/DeepSeek-V3") → the maker's provider id in the file. */
const VENDORS: Record<string, string> = {
  openai: 'openai',
  anthropic: 'anthropic',
  google: 'google',
  'x-ai': 'xai',
  xai: 'xai',
  deepseek: 'deepseek',
  'deepseek-ai': 'deepseek',
  moonshotai: 'moonshot',
  moonshot: 'moonshot',
  mistralai: 'mistral',
  mistral: 'mistral',
  minimax: 'minimax',
  minimaxai: 'minimax',
};

function direct(provider: string, modelId: string): Capabilities | null {
  const e = entries.find((m) => m.provider === provider && m.re.test(modelId));
  if (!e) return null;
  const { provider: _p, pattern: _pat, re: _re, ...caps } = e;
  return caps;
}

/**
 * A model's known capabilities, or null ("Untested"). A gateway, host, or custom provider has no
 * entries of its own, so its model ids drop their vendor prefix ("openai/gpt-5-mini", Ramp's
 * "openai:gpt-5-mini") and are looked up under the maker (decision 79).
 */
export function lookupCapabilities(provider: string, modelId: string): Capabilities | null {
  const own = direct(provider, modelId);
  if (own || listedProviders.has(provider)) return own;
  const m = /^([^/:]+)[/:](.+)$/.exec(modelId);
  const maker = m && VENDORS[m[1]!.toLowerCase()];
  return maker ? direct(maker, m[2]!) : null;
}

/** Below these blended prices (3 parts input to 1 part output, per million tokens) a model counts as low, then medium cost. */
const COST_LIMITS = { low: 1.5, medium: 8 };

/** Low, medium, or high cost from a listed price (decision 79). */
export function costFromPrice(p: Price): Tier {
  const blended = (3 * p.input + p.output) / 4;
  return blended < COST_LIMITS.low ? 'low' : blended < COST_LIMITS.medium ? 'medium' : 'high';
}

export function toCatalogModel(provider: string, modelId: string, displayName?: string, extra: { price?: Price | null; measured?: Speed | null } = {}): CatalogModel {
  const known = lookupCapabilities(provider, modelId);
  const measured = extra.measured ?? null;
  const price = extra.price ?? null;
  const capabilities = known && measured ? { ...known, speed: measured } : known;
  return {
    provider,
    modelId,
    ref: toRef(provider, modelId),
    displayName: displayName || modelId,
    capabilities,
    price,
    cost: capabilities?.cost ?? (price ? costFromPrice(price) : null),
    measured,
  };
}

const COST: Record<Tier, number> = { low: 0, medium: 1, high: 2 };
const SPEED: Record<Speed, number> = { fast: 0, medium: 1, slow: 2 };

/**
 * Default pick for a role from the available models, or null. Untested models are skipped.
 * Decision (the router, after every bar open) takes the fastest structured model, preferring one
 * that doesn't reason, then the smallest among equals, which answers soonest (decision 60). Fast takes the cheapest,
 * fastest structured model; Chat the highest tier.
 */
export function pickDefault(role: RoleName, models: CatalogModel[]): CatalogModel | null {
  const tested = models.filter((m): m is CatalogModel & { capabilities: Capabilities } => m.capabilities !== null);
  // Among equals, the maker's own key before a gateway's copy of the same model.
  const order = (m: CatalogModel) => {
    const i = entries.findIndex((e) => e.provider === m.provider && e.re.test(m.modelId));
    return i >= 0 ? i : entries.length;
  };
  if (role === 'decision') {
    const reasons = (c: Capabilities) => (c.reasoning && c.reasoning !== 'none' ? 1 : 0);
    const ok = tested.filter((m) => m.capabilities.structured !== 'none');
    ok.sort(
      (a, b) =>
        SPEED[a.capabilities.speed] - SPEED[b.capabilities.speed] ||
        reasons(a.capabilities) - reasons(b.capabilities) ||
        COST[a.capabilities.cost] - COST[b.capabilities.cost] ||
        Number(b.capabilities.structured === 'json_schema') - Number(a.capabilities.structured === 'json_schema') ||
        a.capabilities.tier - b.capabilities.tier ||
        order(a) - order(b),
    );
    return ok[0] ?? null;
  }
  if (role === 'fast') {
    const ok = tested.filter((m) => m.capabilities.structured !== 'none');
    ok.sort(
      (a, b) =>
        COST[a.capabilities.cost] - COST[b.capabilities.cost] ||
        SPEED[a.capabilities.speed] - SPEED[b.capabilities.speed] ||
        a.capabilities.tier - b.capabilities.tier ||
        order(a) - order(b),
    );
    return ok[0] ?? null;
  }
  const ok = tested.filter((m) => m.capabilities.streaming);
  ok.sort((a, b) => b.capabilities.tier - a.capabilities.tier || COST[a.capabilities.cost] - COST[b.capabilities.cost] || order(a) - order(b));
  return ok[0] ?? null;
}
