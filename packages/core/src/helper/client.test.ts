import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { describe, expect, it } from 'vitest';
import { HelperClient, HelperError } from './client';
import type { HelperEvent } from './protocol';

/** A fake helper: reads requests from the client and answers through `respond`. */
function fakeHelper(respond: (req: { id: number; cmd: string; [k: string]: unknown }) => unknown | undefined) {
  const toHelper = new PassThrough();
  const fromHelper = new PassThrough();
  createInterface({ input: toHelper }).on('line', (line) => {
    const req = JSON.parse(line);
    const res = respond(req);
    if (res !== undefined) fromHelper.write(JSON.stringify(res) + '\n');
  });
  const client = new HelperClient(toHelper, fromHelper, { selection: 100 });
  return { client, fromHelper };
}

describe('HelperClient', () => {
  it('resolves typed results', async () => {
    const { client } = fakeHelper((req) => ({ id: req.id, ok: true, result: { pong: true, version: '0.1.0', protocol: 1 } }));
    await expect(client.request('ping')).resolves.toEqual({ pong: true, version: '0.1.0', protocol: 1 });
  });

  it('sends arguments at the top level', async () => {
    let seen: unknown;
    const { client } = fakeHelper((req) => {
      seen = req;
      return { id: req.id, ok: true, result: { before: 'a', after: 'b' } };
    });
    await client.request('context', { before: 10, after: 20 });
    expect(seen).toEqual({ id: 1, cmd: 'context', before: 10, after: 20 });
  });

  it('rejects with the helper error code', async () => {
    const { client } = fakeHelper((req) => ({
      id: req.id,
      ok: false,
      error: { code: 'password_field', message: 'Focused element is a password field' },
    }));
    const err = await client.request('context').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HelperError);
    expect((err as HelperError).code).toBe('password_field');
  });

  it('times out and ignores the late answer', async () => {
    const { client } = fakeHelper(() => undefined);
    const err = await client.request('selection').catch((e: unknown) => e);
    expect((err as HelperError).code).toBe('timeout');
  });

  it('rejects results that do not match the schema', async () => {
    const { client } = fakeHelper((req) => ({ id: req.id, ok: true, result: { text: 1 } }));
    const err = await client.request('selection').catch((e: unknown) => e);
    expect((err as HelperError).code).toBe('invalid_response');
  });

  it('emits events and ready', async () => {
    const { client, fromHelper } = fakeHelper(() => undefined);
    const events: HelperEvent[] = [];
    client.on('event', (e) => events.push(e));
    const ready = new Promise((r) => client.once('ready', r));
    fromHelper.write('{"event":"ready","version":"0.1.0","protocol":1,"pid":5}\n');
    fromHelper.write('{"event":"mouse_up","x":1,"y":2,"drag":true,"double":false}\n');
    fromHelper.write('{"event":"bogus"}\n');
    await ready;
    await new Promise((r) => setImmediate(r));
    expect(events.map((e) => e.event)).toEqual(['ready', 'mouse_up']);
  });

  it('rejects pending requests when the helper exits', async () => {
    const { client, fromHelper } = fakeHelper(() => undefined);
    const p = client.request('ping');
    fromHelper.end();
    const err = await p.catch((e: unknown) => e);
    expect((err as HelperError).code).toBe('closed');
    await expect(client.request('ping')).rejects.toThrow('not running');
  });
});
