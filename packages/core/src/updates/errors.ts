// How an update check failed (decision 70), from the updater's error: its code, HTTP status, or
// network error. OS-neutral, so it can be unit tested.

/** `none`: no release to update to (none published, or a private repo's 404). */
export type UpdateErrorKind = 'none' | 'offline' | 'failed';

const NO_RELEASE = new Set(['ERR_UPDATER_LATEST_VERSION_NOT_FOUND', 'ERR_UPDATER_NO_PUBLISHED_VERSIONS', 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND']);
const OFFLINE = /\b(?:ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH)\b|net::ERR_(?:INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|NETWORK_CHANGED|CONNECTION_\w+|TIMED_OUT|ADDRESS_UNREACHABLE)/;

export function updateErrorKind(e: unknown): UpdateErrorKind {
  const err = (e ?? {}) as { code?: unknown; statusCode?: unknown; message?: unknown };
  const code = typeof err.code === 'string' ? err.code : '';
  const message = typeof err.message === 'string' ? err.message : '';
  if (NO_RELEASE.has(code) || err.statusCode === 404 || /\b404\b/.test(message)) return 'none';
  if (OFFLINE.test(code) || OFFLINE.test(message)) return 'offline';
  return 'failed';
}

/** A short code for the log: never the message, which can hold a URL. */
export function updateErrorCode(e: unknown): string {
  const err = (e ?? {}) as { code?: unknown; statusCode?: unknown; name?: unknown };
  if (typeof err.code === 'string') return err.code.slice(0, 60);
  if (typeof err.statusCode === 'number') return `http_${err.statusCode}`;
  return typeof err.name === 'string' ? err.name.slice(0, 60) : 'unknown';
}
