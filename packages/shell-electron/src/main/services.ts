import { EventEmitter } from 'node:events';
import { getLoadablePath } from 'sqlite-vec';
import {
  AiSdkLlm,
  CalendarRepo,
  DEFAULT_BLOCK_LIST,
  DEFAULT_HOTKEY_ONLY,
  LOCAL_PRESETS,
  LOCAL_PROVIDER,
  LocalProvider,
  Metrics,
  PROVIDER_ORDER,
  PROVIDERS,
  PeopleRepo,
  ProviderKeyError,
  SaveService,
  SettingsSchema,
  Store,
  isLoopbackUrl,
  isoNow,
  toLlmCallRow,
  CALL_LOG_DAYS,
  normalizeBaseUrl,
  parseRef,
  toCatalogModel,
  updateLocalModel,
  updateRoles,
  type CatalogModel,
  type KeyStatus,
  type KeyTestResult,
  type LocalStatus,
  type ModelRef,
  type ModelsRefreshResult,
  type RoleSetArgs,
  type Settings,
  type SettingsKey,
  type SettingsView,
} from '@glossly/core';
import { EmbedHost } from './embed-host';
import { KeyStore } from './keys';
import { logger } from './log';
import { userDataPath } from './paths';

const log = logger('services');
const CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** sqlite-vec's DLL lives inside app.asar.unpacked when packaged. */
function vecPath(): string {
  return getLoadablePath().replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
}

/**
 * Everything the main process owns besides windows and capture: the store, settings, keys,
 * the model catalog and roles, the LLM provider, Save, embeddings, and metrics.
 */
export class Services extends EventEmitter<{ settings: [Settings] }> {
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
    for (const p of [...PROVIDER_ORDER, LOCAL_PROVIDER]) {
      const test = JSON.parse(store.getMeta(`key_test:${p}`) ?? 'null') as KeyTestResult | null;
      if (test) this.lastTests.set(p, test);
    }

    this.llm = new AiSdkLlm({
      settings: () => this.settingsCache,
      // The local server needs no key; it is usable once an address is saved.
      apiKey: (p) => (p === LOCAL_PROVIDER ? (this.settingsCache.local.baseUrl === null ? null : '') : this.keys.get(p)),
      createModel: (ref, key) => {
        const { provider, modelId } = parseRef(ref);
        const baseUrl = this.settingsCache.local.baseUrl;
        if (provider === LOCAL_PROVIDER && baseUrl) return LocalProvider.createModel(baseUrl, modelId);
        const info = PROVIDERS[provider];
        if (!info) throw new Error(`Unknown provider: ${provider}`);
        return info.createModel(key, modelId);
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

  catalog(): CatalogModel[] {
    return this.store.listModels().map((m) => toCatalogModel(m.provider, m.model_id, m.display_name));
  }

  keyStatuses(): KeyStatus[] {
    return PROVIDER_ORDER.map((id) => {
      const p = PROVIDERS[id]!;
      return {
        provider: id,
        label: p.label,
        keyUrl: p.keyUrl,
        free: p.free,
        keyPlaceholder: p.keyPlaceholder,
        hasKey: this.keys.has(id),
        lastTest: this.lastTests.get(id) ?? null,
      };
    });
  }

  localStatus(): LocalStatus {
    const { baseUrl } = this.settingsCache.local;
    return { baseUrl, loopback: baseUrl !== null && isLoopbackUrl(baseUrl), lastTest: this.lastTests.get(LOCAL_PROVIDER) ?? null, presets: LOCAL_PRESETS };
  }

  view(): SettingsView {
    return {
      settings: this.settingsCache,
      collections: this.collections(),
      keys: this.keyStatuses(),
      local: this.localStatus(),
      models: this.catalog(),
      embed: this.embed.getStatus(),
      entitiesPending: this.store.countEntitiesPending(),
      platform: process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : 'win32',
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
    for (const p of PROVIDER_ORDER) {
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

  /** Lists the provider's models with the key: the live key test. Stores the catalog on success. */
  private async testWith(provider: string, key: string): Promise<KeyTestResult> {
    const info = PROVIDERS[provider];
    if (!info) return { ok: false, models: 0, error: 'Unknown provider', at: isoNow() };
    try {
      const models = await info.listModels(key);
      this.store.replaceModels(
        provider,
        models.map((m) => ({ model_id: m.modelId, display_name: m.displayName, capabilities: (m.capabilities ?? {}) as Record<string, unknown> })),
      );
      return { ok: true, models: models.length, at: isoNow() };
    } catch (e) {
      if (e instanceof ProviderKeyError) return { ok: false, models: 0, error: e.message, status: e.status, at: isoNow() };
      return { ok: false, models: 0, error: 'The key test failed unexpectedly.', at: isoNow() };
    }
  }

  async addKey(provider: string, key: string): Promise<KeyTestResult> {
    const trimmed = key.trim();
    if (!trimmed) return { ok: false, models: 0, error: 'Paste a key first.', at: isoNow() };
    const r = await this.testWith(provider, trimmed);
    if (r.ok) {
      this.keys.set(provider, trimmed);
      this.applyRoleUpdate();
      log.info('key added', { provider, models: r.models });
    }
    return this.recordTest(provider, r);
  }

  async testKey(provider: string): Promise<KeyTestResult> {
    const key = this.keys.get(provider);
    if (!key) return this.recordTest(provider, { ok: false, models: 0, error: 'No key saved.', at: isoNow() });
    const r = await this.testWith(provider, key);
    if (r.ok) this.applyRoleUpdate();
    return this.recordTest(provider, r);
  }

  removeKey(provider: string): void {
    if (!(provider in PROVIDERS)) return;
    this.keys.remove(provider);
    this.store.removeProviderModels(provider);
    this.lastTests.delete(provider);
    this.store.setMeta(`key_test:${provider}`, 'null');
    this.applyRoleUpdate();
    log.info('key removed', { provider });
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
    for (const provider of this.keys.providers()) {
      const r = await this.testKey(provider);
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
    if (this.keys.providers().length === 0 && !this.settingsCache.local.baseUrl) return;
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
