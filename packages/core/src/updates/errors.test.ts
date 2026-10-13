import { describe, expect, it } from 'vitest';
import { updateErrorCode, updateErrorKind } from './errors';

describe('updateErrorKind', () => {
  it('reads a missing release feed as no update (a private repo answers 404)', () => {
    expect(updateErrorKind({ code: 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND' })).toBe('none');
    expect(updateErrorKind({ code: 'ERR_UPDATER_NO_PUBLISHED_VERSIONS' })).toBe('none');
    expect(updateErrorKind({ statusCode: 404, message: 'Not Found' })).toBe('none');
    expect(updateErrorKind(new Error('HttpError: 404 "method: GET url: https://github.com/example/app/releases.atom"'))).toBe('none');
  });

  it('tells being offline apart from other failures', () => {
    expect(updateErrorKind(new Error('net::ERR_INTERNET_DISCONNECTED'))).toBe('offline');
    expect(updateErrorKind({ code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND github.com' })).toBe('offline');
    expect(updateErrorKind(new Error('sha512 checksum mismatch'))).toBe('failed');
    expect(updateErrorKind(null)).toBe('failed');
  });

  it('logs a code, never the message', () => {
    expect(updateErrorCode({ code: 'ERR_UPDATER_INVALID_RELEASE_FEED', message: 'https://example.com/feed' })).toBe('ERR_UPDATER_INVALID_RELEASE_FEED');
    expect(updateErrorCode({ statusCode: 500 })).toBe('http_500');
    expect(updateErrorCode(new TypeError('x'))).toBe('TypeError');
  });
});
