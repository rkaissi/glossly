import { EventEmitter } from 'node:events';
import { app } from 'electron';
import { getLoadablePath } from 'sqlite-vec';
import {
  AiSdkLlm,
  CalendarRepo,
  DEFAULT_BLOCK_LIST,
  DEFAULT_HOTKEY_ONLY,
  CUSTOM_PRESET,
  LEGACY_PROVIDERS,
  LOCAL_PRESETS,
  LOCAL_PROVIDER,
  LocalProvider,
  Metrics,
  PRESET_BY_ID,
  PRESETS,
  PeopleRepo,
  ProviderKeyError,
  SaveService,
  SettingsSchema,
  Store,
  createModel as createProviderModel,
  detectApi,
  isLoopbackUrl,
  isoNow,
  listModels as listProviderModels,
  sdkOf,
  toLlmCallRow,
  toRef,
  CALL_LOG_DAYS,
  normalizeBaseUrl,
  parseRef,
  toCatalogModel,
  updateLocalModel,
  updateRoles,
  type CatalogModel,
  type KeyTestResult,
  type LocalFound,
  type LocalStatus,
  type ModelRef,
  type ModelsRefreshResult,
  type PresetInfo,
  type Price,
  type ProviderAddArgs,
  type ProviderConnection,
  type ProviderStatus,
  type RoleSetArgs,
  type Settings,
  type SettingsKey,
  type SettingsView,
  type Speed,
} from '@glossly/core';
import { EmbedHost } from './embed-host';
import { KeyStore } from './keys';
import { logger } from './log';
import { userDataPath } from './paths';

const log = logger('services');
const CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Measured speeds are worked out from the metrics at most this often. */
const SPEEDS_MAX_AGE_MS = 10 * 60 * 1000;

/** The listed price a model row keeps (decision 79); rows saved before it hold other fields. */
function storedPrice(stored: Record<string, unknown>): Price | null {
  const p = stored.price as Partial<Price> | undefined;
  return p && typeof p.input === 'number' && typeof p.output === 'number' ? { input: p.input, output: p.output } : null;
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

const fail = (error: string): KeyTestResult => ({ ok: false, models: 0, error, at: isoNow() });

/** sqlite-vec's DLL lives inside app.asar.unpacked when packaged. */
function vecPath(): string {
  return getLoadablePath().replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
}

/**
 * Everything the main process owns besides windows and capture: the store, settings, keys,
 * the model catalog and roles, the LLM provider, Save, embeddings, and metrics.
 */
/** `people`: tasks, events, or people changed outside an IPC handler (Ask's tools, decision 78). */
export class Services extends EventEmitter<{ settings: [Settings]; people: [] }> {
  readonly store: Store;
  readonly metrics: Metrics;
  readonly keys: KeyStore;
  readonly llm: AiSdkLlm;
  readonly save: SaveService;
  readonly people: PeopleRepo;
  readonly calendar: CalendarRepo;
  readonly embed: EmbedHost;
  private settingsCache: Settings;
  private readonly lastTests = new Map<string, KeyTestResult>();
  private speedCache: { at: number; speeds: Record<string, Speed> } | null = null;

  constructor() {
    super();
    let store: Store;
    try {
      store = new Store(userDataPath('glossly.db'), { vecExtensionPath: vecPath() });
    } catch (e) {
      log.error('sqlite-vec failed to load; vectors disabled', { message: (e as Error).message.slice(0, 200) });
      store = new Store(userDataPath('glossly.db'));
    }
    this.store = store;
    this.people = new PeopleRepo(store);
    // Samples pasted before decision 59 get a suggested platform, once.
    const labeled = this.people.labelPastedVoice();
    if (labeled) log.info('pasted voice samples labeled', { count: labeled });
    this.calendar = new CalendarRepo(store);
    this.metrics = new Metrics(store);
    this.keys = new KeyStore(userDataPath('keys'));
    this.settingsCache = store.getSettings();
    this.addLegacyProviders();
    for (const p of [...this.settingsCache.providers.map((c) => c.id), LOCAL_PROVIDER]) {
      const test = JSON.parse(store.getMeta(`key_test:${p}`) ?? 'null') as KeyTestResult | null;
      if (test) this.lastTests.set(p, test);
    }

    this.llm = new AiSdkLlm({
      settings: () => this.settingsCache,
      // The local server needs no key; it is usable once an address is saved. So is a Custom provider added without one.
      apiKey: (p) => {
        if (p === LOCAL_PROVIDER) return this.settingsCache.local.baseUrl === null ? null : '';
        const conn = this.connection(p);
        if (!conn) return null;
        return this.keys.get(p) ?? (conn.preset === CUSTOM_PRESET ? '' : null);
      },
      createModel: (ref, key) => {
        const { provider, modelId } = parseRef(ref);
        const baseUrl = this.settingsCache.local.baseUrl;
        if (provider === LOCAL_PROVIDER && baseUrl) return LocalProvider.createModel(baseUrl, modelId);
        const conn = this.connection(provider);
        if (!conn) throw new Error(`Unknown provider: ${provider}`);
        return createProviderModel(conn, key, modelId);
      },
      // Ramp Router and a Custom provider on the Responses API take OpenAI's options (decision 79).
      optionsKey: (p) => {
        const conn = this.connection(p);
        if (!conn) return null;
        const sdk = sdkOf(conn);
        return sdk === 'groq' ? 'groq' : sdk === 'openai' || sdk === 'responses' ? 'openai' : null;
      },
      // Which call moved from which model, and why (decision 60): codes only.
      onFallback: (f) => this.metrics.record('llm_fallback', { ...f, status: f.status ?? 'none' }),
      // Token counts per call (decision 48): codes and counts only.
      onUsage: (u) => this.metrics.record('llm_tokens', { ...u }),
      // The call log holds the user's text, so only while it is on (decision 61); never in main.log.
      onCall: (c) => {
        if (!this.settingsCache.callLog) return;
        try {
          this.store.addLlmCall(toLlmCallRow(c, isoNow()));
        } catch (e) {
          log.warn('call log write failed', { name: (e as Error)?.name ?? 'error' });
        }
      },
    });
    this.pruneCallLog();

    const { model, dims } = this.settingsCache.embeddings;
    store.ensureVectorModel(model, dims);
    this.embed = new EmbedHost(store, model, dims, userDataPath('models'));
    this.save = new SaveService({
      store,
      llm: this.llm,
      embedder: () => this.embed.embedder(),
      settings: () => this.settingsCache,
      metrics: this.metrics,
    });
  }

  get settings(): Settings {
    return this.settingsCache;
  }

  /** Validates one key, stores it, and notifies listeners. Throws on an invalid value. */
  setSetting(key: SettingsKey, value: unknown): Settings {
    const shape = SettingsSchema.shape[key];
    if (!shape) throw new Error(`Unknown setting: ${String(key)}`);
    const parsed = shape.parse(value);
    this.store.setSetting(key, parsed as never);
    // Turning the call log off deletes it (decision 61).
    if (key === 'callLog' && parsed === false) this.store.pruneLlmCalls();
    this.settingsCache = { ...this.settingsCache, [key]: parsed };
    this.emit('settings', this.settingsCache);
    return this.settingsCache;
  }

  collections(): string[] {
    return this.store.listCollections().map((c) => c.name);
  }

  /** Each model's measured speed (decision 79), worked out from the metrics at most every 10 minutes. */
  private speeds(): Record<string, Speed> {
    const now = Date.now();
    if (!this.speedCache || now - this.speedCache.at > SPEEDS_MAX_AGE_MS) {
      let speeds: Record<string, Speed> = {};
      try {
        speeds = this.metrics.modelSpeeds();
      } catch (e) {
        log.warn('measured speeds failed', { name: (e as Error)?.name ?? 'error' });
      }
      this.speedCache = { at: now, speeds };
    }
    return this.speedCache.speeds;
  }

  catalog(): CatalogModel[] {
    const speeds = this.speeds();
    return this.store
      .listModels()
      .map((m) => toCatalogModel(m.provider, m.model_id, m.display_name, { price: storedPrice(m.capabilities), measured: speeds[toRef(m.provider, m.model_id)] ?? null }));
  }

  /** An added hosted provider by id. */
  private connection(id: string): ProviderConnection | undefined {
    return this.settingsCache.providers.find((c) => c.id === id);
  }

  /** Keys saved before providers were added from a list (decision 79) become added providers, once. */
  private addLegacyProviders(): void {
    const have = new Set(this.settingsCache.providers.map((c) => c.id));
    const add = LEGACY_PROVIDERS.filter((p) => !have.has(p) && this.keys.has(p)).map((p): ProviderConnection => ({ id: p, preset: p }));
    if (add.length === 0) return;
    this.setSetting('providers', [...this.settingsCache.providers, ...add]);
    log.info('keys moved to added providers', { count: add.length });
  }

  providerStatuses(): ProviderStatus[] {
    return this.settingsCache.providers.map((c) => {
      const p = PRESET_BY_ID[c.preset];
      return {
        id: c.id,
        preset: c.preset,
        label: c.label ?? p?.label ?? c.id,
        baseUrl: c.preset === CUSTOM_PRESET ? (c.baseUrl ?? null) : null,
        api: c.preset === CUSTOM_PRESET ? (c.api ?? null) : null,
        via: p?.via ?? true,
        free: p?.free ?? false,
        keyUrl: p?.keyUrl ?? '',
        keyPlaceholder: p?.keyPlaceholder ?? '',
        hasKey: this.keys.has(c.id),
        lastTest: this.lastTests.get(c.id) ?? null,
      };
    });
  }

  presets(): PresetInfo[] {
    return PRESETS.map(({ knownModels: _known, ...p }) => p);
  }

  localStatus(): LocalStatus {
    const { baseUrl } = this.settingsCache.local;
    return { baseUrl, loopback: baseUrl !== null && isLoopbackUrl(baseUrl), lastTest: this.lastTests.get(LOCAL_PROVIDER) ?? null, presets: LOCAL_PRESETS };
  }

  view(): SettingsView {
    return {
      settings: this.settingsCache,
      collections: this.collections(),
      providers: this.providerStatuses(),
      presets: this.presets(),
      local: this.localStatus(),
      models: this.catalog(),
      embed: this.embed.getStatus(),
      entitiesPending: this.store.countEntitiesPending(),
      platform: process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : 'win32',
      installed: app.isPackaged,
      builtins: { blockList: DEFAULT_BLOCK_LIST, hotkeyOnly: DEFAULT_HOTKEY_ONLY },
    };
  }

  /**
   * "Delete all data": saved items, entities, people, vectors, usage events, and collections
   * (the defaults come back). Keys, settings, the model list, and the embedding model stay.
   */
  async deleteAll(): Promise<void> {
    // A save still being enriched would write its vector and entities after the wipe.
    await Promise.race([this.save.idle(), new Promise((r) => setTimeout(r, 2000))]);
    this.store.deleteAll();
  }

  /**
   * "Reset settings": removes every saved key, its test result, and the model list, and puts
   * settings back to their defaults, so the app is back at first-run setup. Saved data stays.
   */
  resetSettings(): void {
    for (const p of new Set([...this.settingsCache.providers.map((c) => c.id), ...LEGACY_PROVIDERS, ...this.keys.providers()])) {
      this.keys.remove(p);
      this.store.setMeta(`key_test:${p}`, 'null');
    }
    this.store.setMeta(`key_test:${LOCAL_PROVIDER}`, 'null');
    this.lastTests.clear();
    this.store.clearModels();
    this.store.resetSettings();
    this.settingsCache = this.store.getSettings();
    this.emit('settings', this.settingsCache);
  }

  // ---- keys and catalog ----

  private recordTest(provider: string, r: KeyTestResult): KeyTestResult {
    this.lastTests.set(provider, r);
    this.store.setMeta(`key_test:${provider}`, JSON.stringify(r));
    return r;
  }

  /** Lists the provider's models with the key: the live key test. Stores the catalog, with any listed prices, on success. */
  private async testWith(conn: ProviderConnection, key: string): Promise<KeyTestResult> {
    try {
      const models = await listProviderModels(conn, key);
      if (models.length === 0) return fail('The key works, but it has no chat models to use.');
      this.store.replaceModels(
        conn.id,
        models.map((m) => ({ model_id: m.modelId, display_name: m.displayName, capabilities: m.price ? { price: m.price } : {} })),
      );
      return { ok: true, models: models.length, at: isoNow() };
    } catch (e) {
      if (e instanceof ProviderKeyError) return { ok: false, models: 0, error: e.message, status: e.status, at: isoNow() };
      return fail('The key test failed unexpectedly.');
    }
  }

  /** The next free "custom-N". */
  private nextCustomId(): string {
    const used = this.settingsCache.providers.map((c) => /^custom-(\d+)$/.exec(c.id)?.[1]).filter(Boolean).map(Number);
    return `custom-${Math.max(0, ...used) + 1}`;
  }

  /**
   * Adds a hosted provider, or replaces the key or address of one already added (decision 79).
   * Saved only when listing its models with the key works. A Custom provider with no way of
   * talking given finds out first; one with no key typed keeps the key it had.
   */
  async addProvider(a: ProviderAddArgs): Promise<KeyTestResult> {
    const preset = PRESET_BY_ID[a.preset];
    if (!preset || preset.group === 'local') return fail('Unknown provider.');
    const custom = preset.id === CUSTOM_PRESET;
    const existing = a.id ? this.connection(a.id) : custom ? undefined : this.connection(preset.id);
    if (a.id && (!existing || existing.preset !== preset.id)) return fail('That provider is no longer added.');
    const id = existing?.id ?? (custom ? this.nextCustomId() : preset.id);
    const key = a.key?.trim() || (existing ? (this.keys.get(id) ?? '') : '');
    if (!custom && !key) return fail('Paste a key first.');

    let conn: ProviderConnection = { id, preset: preset.id };
    if (custom) {
      const baseUrl = normalizeBaseUrl(a.baseUrl ?? existing?.baseUrl ?? '');
      if (!baseUrl) return fail('Type an address, such as https://llm.example.com/v1.');
      const label = ((a.label ?? existing?.label ?? '').trim() || hostOf(baseUrl)).slice(0, 60);
      let api = a.api;
      if (!api) {
        try {
          api = await detectApi(baseUrl, key);
        } catch (e) {
          return fail(e instanceof ProviderKeyError ? e.message : "Couldn't tell how that address talks.");
        }
      }
      conn = { id, preset: CUSTOM_PRESET, label, baseUrl, api };
    }

    const r = await this.testWith(conn, key);
    // A failed first try leaves nothing behind; a failed replace keeps the provider as it was.
    if (!r.ok) return existing ? this.recordTest(id, r) : r;
    if (key) this.keys.set(id, key);
    else this.keys.remove(id);
    const list = this.settingsCache.providers;
    this.setSetting('providers', existing ? list.map((c) => (c.id === id ? conn : c)) : [...list, conn]);
    this.applyRoleUpdate();
    log.info(existing ? 'provider changed' : 'provider added', { provider: id, preset: preset.id, models: r.models, ...(conn.api && { api: conn.api }) });
    return this.recordTest(id, { ...r, id });
  }

  async testProvider(id: string): Promise<KeyTestResult> {
    const conn = this.connection(id);
    if (!conn) return fail('That provider is no longer added.');
    const key = this.keys.get(id) ?? '';
    if (!key && conn.preset !== CUSTOM_PRESET) return this.recordTest(id, fail('No key saved.'));
    const r = await this.testWith(conn, key);
    if (r.ok) this.applyRoleUpdate();
    return this.recordTest(id, r);
  }

  removeProvider(id: string): void {
    if (!this.connection(id)) return;
    this.keys.remove(id);
    this.store.removeProviderModels(id);
    this.lastTests.delete(id);
    this.store.setMeta(`key_test:${id}`, 'null');
    this.setSetting(
      'providers',
      this.settingsCache.providers.filter((c) => c.id !== id),
    );
    this.applyRoleUpdate();
    log.info('provider removed', { provider: id });
  }

  /** Which local presets answer at their default address right now (a quick look, under 2 seconds). */
  async detectLocal(): Promise<LocalFound[]> {
    return Promise.all(
      LOCAL_PRESETS.map(async (p): Promise<LocalFound> => {
        try {
          const models = await LocalProvider.listModels(p.baseUrl, fetch, AbortSignal.timeout(1500));
          return { preset: p.id, baseUrl: p.baseUrl, models: models.length, running: true };
        } catch {
          return { preset: p.id, baseUrl: p.baseUrl, models: 0, running: false };
        }
      }),
    );
  }

  // ---- the local model server ----

  /** Lists the server's models: the connection test. Stores them as the `local` catalog on success. */
  private async testLocalAt(baseUrl: string): Promise<KeyTestResult> {
    try {
      const models = await LocalProvider.listModels(baseUrl);
      if (models.length === 0) return { ok: false, models: 0, error: 'The server answered but has no chat models. Download one in Ollama or LM Studio first.', at: isoNow() };
      this.store.replaceModels(
        LOCAL_PROVIDER,
        models.map((m) => ({ model_id: m.modelId, display_name: m.displayName, capabilities: (m.capabilities ?? {}) as Record<string, unknown> })),
      );
      return { ok: true, models: models.length, at: isoNow() };
    } catch (e) {
      if (e instanceof ProviderKeyError && e.status === 0) {
        return { ok: false, models: 0, error: `Couldn't reach ${baseUrl}. Check that Ollama or LM Studio is running and serving there.`, at: isoNow() };
      }
      if (e instanceof ProviderKeyError) return { ok: false, models: 0, error: e.message, status: e.status, at: isoNow() };
      return { ok: false, models: 0, error: 'The connection test failed unexpectedly.', at: isoNow() };
    }
  }

  /** Saves the address only when it lists models. */
  async connectLocal(input: string): Promise<KeyTestResult> {
    const baseUrl = normalizeBaseUrl(input);
    if (!baseUrl) return { ok: false, models: 0, error: 'Type an address such as http://localhost:11434/v1.', at: isoNow() };
    const r = await this.testLocalAt(baseUrl);
    if (r.ok) {
      this.setSetting('local', { ...this.settingsCache.local, baseUrl });
      this.applyRoleUpdate();
      log.info('local server added', { models: r.models, loopback: isLoopbackUrl(baseUrl) });
    }
    return this.recordTest(LOCAL_PROVIDER, r);
  }

  async testLocal(): Promise<KeyTestResult> {
    const { baseUrl } = this.settingsCache.local;
    if (!baseUrl) return this.recordTest(LOCAL_PROVIDER, { ok: false, models: 0, error: 'No local server set up.', at: isoNow() });
    const r = await this.testLocalAt(baseUrl);
    this.applyRoleUpdate();
    return this.recordTest(LOCAL_PROVIDER, r);
  }

  removeLocal(): void {
    this.setSetting('local', { baseUrl: null, model: null, manual: false });
    this.store.removeProviderModels(LOCAL_PROVIDER);
    this.lastTests.delete(LOCAL_PROVIDER);
    this.store.setMeta(`key_test:${LOCAL_PROVIDER}`, 'null');
    this.applyRoleUpdate();
    log.info('local server removed');
  }

  /** The model Local only uses. */
  setLocalModel(model: ModelRef): void {
    if (!this.catalog().some((m) => m.ref === model && m.provider === LOCAL_PROVIDER)) throw new Error('That local model is not available.');
    this.setSetting('local', { ...this.settingsCache.local, model, manual: true });
  }

  async refreshModels(): Promise<ModelsRefreshResult> {
    const errors: ModelsRefreshResult['errors'] = [];
    for (const { id: provider } of this.settingsCache.providers) {
      const r = await this.testProvider(provider);
      if (!r.ok) errors.push({ provider, message: r.error ?? 'Failed' });
    }
    if (this.settingsCache.local.baseUrl) {
      const r = await this.testLocal();
      if (!r.ok) errors.push({ provider: LOCAL_PROVIDER, message: r.error ?? 'Failed' });
    }
    const notices = this.applyRoleUpdate();
    return { models: this.catalog(), notices, errors };
  }

  /** Drops call-log entries older than 30 days (on launch and once a day after). */
  pruneCallLog(): void {
    const before = new Date(Date.now() - CALL_LOG_DAYS * 86_400_000).toISOString();
    const n = this.store.pruneLlmCalls(before);
    if (n) log.info('call log pruned', { count: n });
  }

  /** On launch: re-fit automatic roles to the catalog we have (decision 60), then refresh it when it is older than 24 hours. */
  async refreshIfStale(): Promise<void> {
    this.applyRoleUpdate();
    if (this.settingsCache.providers.length === 0 && !this.settingsCache.local.baseUrl) return;
    const fetched = this.store.listModels().map((m) => Date.parse(m.fetched_at));
    const oldest = fetched.length ? Math.min(...fetched) : 0;
    if (Date.now() - oldest < CATALOG_MAX_AGE_MS) return;
    const r = await this.refreshModels();
    log.info('catalog refreshed', { models: r.models.length, errors: r.errors.length });
  }

  /** Re-fills roles from the catalog and queues any notice for the bar. */
  private applyRoleUpdate(): string[] {
    const catalog = this.catalog();
    const u = updateRoles(this.settingsCache.roles, catalog);
    if (u.changed) this.setSetting('roles', u.roles);
    const l = updateLocalModel(this.settingsCache.local, catalog);
    if (l.changed) this.setSetting('local', l.local);
    const notices = [...u.notices, ...l.notices];
    if (notices.length > 0) this.setSetting('pendingNotice', notices.join(' '));
    return notices;
  }

  setRole({ role, model, fallback }: RoleSetArgs): Settings['roles'] {
    const available = new Set(this.catalog().map((m) => m.ref));
    if (model && !available.has(model)) throw new Error('That model is not available with your keys.');
    if (fallback && !available.has(fallback)) throw new Error('That fallback model is not available with your keys.');
    if (role !== 'decision' && !model) throw new Error('Pick a model.');
    const roles = structuredClone(this.settingsCache.roles);
    // A pick here is the user's, "Use Fast model" for Decision included (decision 60).
    roles[role] = { model, fallback: fallback === model ? null : fallback, manual: true };
    return this.setSetting('roles', roles).roles;
  }

  async shutdown(): Promise<void> {
    await Promise.race([this.save.idle(), new Promise((r) => setTimeout(r, 2000))]);
    this.embed.stop();
    this.store.close();
  }
}
