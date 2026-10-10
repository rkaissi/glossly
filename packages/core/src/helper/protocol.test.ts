import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Commands, ErrorResponseSchema, EventSchema, OkResponseSchema, RequestSchema, type CommandName } from './protocol';

const dir = join(import.meta.dirname, '../../../../helpers/fixtures');

interface Case {
  name: string;
  request: unknown;
  response: unknown;
}
const files = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'events.json');

describe('helper protocol fixtures', () => {
  it('covers every command', () => {
    const covered = new Set(files.map((f) => f.replace('.json', '')));
    for (const cmd of Object.keys(Commands)) expect(covered, `fixture for ${cmd}`).toContain(cmd);
  });

  for (const file of files) {
    const { cmd, cases } = JSON.parse(readFileSync(join(dir, file), 'utf8')) as { cmd: string; cases: Case[] };
    describe(file, () => {
      for (const c of cases) {
        it(c.name, () => {
          if (typeof c.request === 'string') {
            expect(() => JSON.parse(c.request as string)).toThrow();
          } else {
            const req = RequestSchema.parse(c.request);
            expect((c.response as { id: unknown }).id).toEqual(req.id);
            if (cmd !== '*' && (c.response as { ok: boolean }).ok) {
              const { id: _id, cmd: _cmd, ...args } = req;
              Commands[cmd as CommandName].args.parse(args);
            }
          }
          const ok = (c.response as { ok: boolean }).ok;
          if (ok) {
            const res = OkResponseSchema.parse(c.response);
            Commands[cmd as CommandName].result.parse(res.result);
          } else {
            ErrorResponseSchema.parse(c.response);
          }
        });
      }
    });
  }

  it('events.json', () => {
    const { events } = JSON.parse(readFileSync(join(dir, 'events.json'), 'utf8')) as { events: unknown[] };
    for (const e of events) EventSchema.parse(e);
    expect(new Set(events.map((e) => (e as { event: string }).event))).toEqual(
      new Set(['ready', 'mouse_down', 'mouse_up', 'wheel', 'keyboard_activity']),
    );
  });
});
