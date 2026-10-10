import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { safeStorage } from 'electron';
import { PROVIDERS } from '@glossly/core';
import { logger } from './log';

const log = logger('keys');

/**
 * API keys, one safeStorage-encrypted file per provider (DPAPI on Windows). Decrypted keys
 * live only in memory and are never logged.
 */
export class KeyStore {
  private readonly cache = new Map<string, string>();

  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private file(provider: string): string {
    if (!(provider in PROVIDERS)) throw new Error(`Unknown provider: ${provider}`);
    return join(this.dir, `${provider}.bin`);
  }

  get(provider: string): string | null {
    if (!(provider in PROVIDERS)) return null;
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
    return provider in PROVIDERS && existsSync(this.file(provider));
  }

  set(provider: string, key: string): void {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Encryption is not available on this system');
    writeFileSync(this.file(provider), safeStorage.encryptString(key));
    this.cache.set(provider, key);
  }

  remove(provider: string): void {
    rmSync(this.file(provider), { force: true });
    this.cache.delete(provider);
  }

  providers(): string[] {
    return Object.keys(PROVIDERS).filter((p) => this.has(p));
  }
}
