import capabilitiesFile from '../../models/capabilities.json';
import type { ModelRef } from '../settings';

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
}

export interface CatalogModel {
  provider: string;
  modelId: string;
  ref: ModelRef;
  displayName: string;
  /** Null means "Untested": selectable by hand, never auto-assigned. */
  capabilities: Capabilities | null;
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

export const toRef = (provider: string, modelId: string): ModelRef => `${provider}:${modelId}`;

export function parseRef(ref: ModelRef): { provider: string; modelId: string } {
  const i = ref.indexOf(':');
  return { provider: ref.slice(0, i), modelId: ref.slice(i + 1) };
}

/** Text chat models only: drops embeddings, audio, image, moderation, and deprecated models. */
export function isChatModel(modelId: string): boolean {
  return !exclude.some((re) => re.test(modelId));
}

export function lookupCapabilities(provider: string, modelId: string): Capabilities | null {
  const e = entries.find((m) => m.provider === provider && m.re.test(modelId));
  if (!e) return null;
  const { provider: _p, pattern: _pat, re: _re, ...caps } = e;
  return caps;
}

export function toCatalogModel(provider: string, modelId: string, displayName?: string): CatalogModel {
  return {
    provider,
    modelId,
    ref: toRef(provider, modelId),
    displayName: displayName || modelId,
    capabilities: lookupCapabilities(provider, modelId),
  };
}

const COST: Record<Tier, number> = { low: 0, medium: 1, high: 2 };
const SPEED: Record<Speed, number> = { fast: 0, medium: 1, slow: 2 };

/** Default pick for a role from the available models, or null. Untested models are skipped. */
export function pickDefault(role: 'fast' | 'chat', models: CatalogModel[]): CatalogModel | null {
  const tested = models.filter((m): m is CatalogModel & { capabilities: Capabilities } => m.capabilities !== null);
  const order = (m: CatalogModel) => entries.findIndex((e) => e.provider === m.provider && e.re.test(m.modelId));
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
