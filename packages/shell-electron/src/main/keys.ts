import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { safeStorage } from 'electron';
import { logger } from './log';

const log = logger('keys');

/** A provider id ("groq", "openrouter", "custom-2"): also the key file's name, so nothing else gets in. */
const ID = /^[a-z0-9-]{1,40}$/;

/**
 * API keys, one safeStorage-encrypted file per added provider (DPAPI on Windows), named by its
 * id (decision 79). Decrypted keys live only in memory and are never logged.
 */
export class KeyStore {
  private readonly cache = new Map<string, string>();

  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private file(provider: string): string {
    if (!ID.test(provider)) throw new Error(`Unknown provider: ${provider}`);
    return join(this.dir, `${provider}.bin`);
  }

  get(provider: string): string | null {
    if (!ID.test(provider)) return null;
    const hit = this.cache.get(provider);
    if (hit) return hit;
    const f = this.file(provider);
    if (!existsSync(f)) return null;
    try {
      const key = safeStorage.decryptString(readFileSync(f));
      this.cache.set(provider, key);
      return key;
    } catch {
      log.error('could not decrypt key', { provider });
      return null;
    }
  }

  has(provider: string): boolean {
    return ID.test(provider) && existsSync(this.file(provider));
  }

  set(provider: string, key: string): void {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Encryption is not available on this system');
    writeFileSync(this.file(provider), safeStorage.encryptString(key));
    this.cache.set(provider, key);
  }

  remove(provider: string): void {
    if (!ID.test(provider)) return;
    rmSync(this.file(provider), { force: true });
    this.cache.delete(provider);
  }

  /** Every provider with a key file. */
  providers(): string[] {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.bin'))
      .map((f) => f.slice(0, -4))
      .filter((p) => ID.test(p));
  }
}
