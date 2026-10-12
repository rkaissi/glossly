import type { ModelRef, RoleAssignment, RoleName, Settings } from '../settings';
import { LOCAL_PROVIDER, parseRef, pickDefault, type CatalogModel } from './catalog';

export interface RoleUpdate {
  roles: Settings['roles'];
  changed: boolean;
  /** One-line notices for the bar, e.g. a model the user picked went away. */
  notices: string[];
}

const ROLE_LABEL: Record<RoleName, string> = { fast: 'Fast', chat: 'Chat', decision: 'Decision' };

/**
 * Best default from a different provider than `primary`, so a provider outage has a way out.
 * A cloud model never gets a local one as its automatic fallback: a local model is slow and
 * loads the machine, so it is only a fallback when picked by hand.
 */
function pickFallback(role: RoleName, models: CatalogModel[], primary: ModelRef | null, avoid: ModelRef[] = []): ModelRef | null {
  if (!primary) return null;
  const { provider } = parseRef(primary);
  if (provider !== LOCAL_PROVIDER) models = models.filter((m) => m.provider !== LOCAL_PROVIDER);
  models = models.filter((m) => m.ref !== primary);
  const pick = (pool: CatalogModel[]) => pickDefault(role, pool.filter((m) => m.provider !== provider)) ?? pickDefault(role, pool);
  const any = pick(models);
  const kept = pick(models.filter((m) => !avoid.includes(m.ref)));
  // Avoiding a model is worth it only at no extra cost.
  const cost = (m: CatalogModel | null) => COST_RANK[m?.capabilities?.cost ?? 'low'];
  return (kept && cost(kept) <= cost(any) ? kept : any)?.ref ?? null;
}

const COST_RANK = { low: 0, medium: 1, high: 2 } as const;

/**
 * The default for a role, avoiding `avoid` while another model fits. Never trades a cloud model
 * for a local one to do it: a local model is slower than sharing a rate limit.
 */
function pickPrimary(role: RoleName, models: CatalogModel[], avoid: ModelRef[]): ModelRef | null {
  const best = pickDefault(role, models);
  const local = !best || best.provider === LOCAL_PROVIDER;
  const other = pickDefault(role, models.filter((m) => !avoid.includes(m.ref) && (local || m.provider !== LOCAL_PROVIDER)));
  return (other ?? best)?.ref ?? null;
}

/**
 * Called on launch and whenever keys or the model catalog change. A role picked by hand keeps
 * its model while it is available (a model that went away switches the role back to automatic,
 * with a notice); an automatic role follows the defaults in capabilities.json. Decision gets the
 * fastest model, and Fast and its fallback avoid that model, so the router, which runs on every
 * bar open, and Who, Tasks, and Save don't share one model's rate limit (decision 60).
 */
export function updateRoles(current: Settings['roles'], models: CatalogModel[]): RoleUpdate {
  const available = new Set(models.map((m) => m.ref));
  const notices: string[] = [];
  const roles = structuredClone(current);

  for (const role of ['decision', 'fast', 'chat'] as const) {
    const r: RoleAssignment = roles[role];
    const avoid = role === 'fast' && roles.decision.model ? [roles.decision.model] : [];
    if (r.model && !available.has(r.model)) {
      const def = pickPrimary(role, models, avoid);
      notices.push(
        def
          ? `${ROLE_LABEL[role]} model ${parseRef(r.model).modelId} is no longer available. Switched to ${parseRef(def).modelId}.`
          : `${ROLE_LABEL[role]} model ${parseRef(r.model).modelId} is no longer available. Add a key in Settings.`,
      );
      r.manual = false;
    }
    if (!r.manual) {
      r.model = pickPrimary(role, models, avoid);
      r.fallback = pickFallback(role, models, r.model, avoid);
    } else if (r.fallback && (!available.has(r.fallback) || r.fallback === r.model)) r.fallback = null;
  }

  return { roles, changed: JSON.stringify(roles) !== JSON.stringify(current), notices };
}

export interface LocalModelUpdate {
  local: Settings['local'];
  changed: boolean;
  notices: string[];
}

/**
 * Keeps the Local only model in step with the local catalog, like `updateRoles`: fills it when
 * empty, keeps a hand pick while it is available, and switches a model that went away.
 */
export function updateLocalModel(current: Settings['local'], models: CatalogModel[]): LocalModelUpdate {
  const local = { ...current };
  const notices: string[] = [];
  // Every local model has the same generic capabilities, so the pick is the first by name.
  const mine = models.filter((m) => m.provider === LOCAL_PROVIDER).sort((a, b) => a.modelId.localeCompare(b.modelId));
  if (local.model && !mine.some((m) => m.ref === local.model)) {
    // Only a notice while a server is set up: removing the server clears the model quietly.
    if (local.baseUrl && mine.length > 0) notices.push(`Local model ${parseRef(local.model).modelId} is no longer available. Switched to ${pickDefault('chat', mine)?.modelId}.`);
    local.model = null;
    local.manual = false;
  }
  if (!local.model) {
    local.model = pickDefault('chat', mine)?.ref ?? null;
    local.manual = false;
  }
  return { local, changed: JSON.stringify(local) !== JSON.stringify(current), notices };
}

/** The models to try for a call, in order: per-action override or role model, then fallback. */
export function modelChain(role: RoleName, settings: Pick<Settings, 'roles' | 'actionModels'>, action?: string): ModelRef[] {
  const chain: (ModelRef | null)[] = [];
  const override = action ? settings.actionModels[action] : undefined;
  if (override) chain.push(override);
  if (role === 'decision' && !settings.roles.decision.model) {
    chain.push(settings.roles.fast.model, settings.roles.decision.fallback ?? settings.roles.fast.fallback);
  } else {
    chain.push(settings.roles[role].model, settings.roles[role].fallback);
  }
  return [...new Set(chain.filter((m): m is ModelRef => Boolean(m)))];
}
