import { describe, expect, it } from 'vitest';
import { describeIdentity, hasIdentity, isMe, jaroWinkler, normalizeHandle } from './names';

const me = { name: 'Alex Morgan', emails: ['alex@example.com'], handles: ['alexm'] };

describe('jaroWinkler', () => {
  it('scores the classic examples', () => {
    expect(jaroWinkler('martha', 'marhta')).toBeCloseTo(0.961, 3);
    expect(jaroWinkler('dwayne', 'duane')).toBeCloseTo(0.84, 2);
    expect(jaroWinkler('same', 'same')).toBe(1);
    expect(jaroWinkler('', 'x')).toBe(0);
  });
  it('puts small typos in names above 0.92 and different names below', () => {
    expect(jaroWinkler('sam lee', 'sam leee')).toBeGreaterThan(0.92);
    expect(jaroWinkler('katherine ross', 'katharine ross')).toBeGreaterThan(0.92);
    expect(jaroWinkler('sam lee', 'sam li')).toBeLessThan(0.92);
    expect(jaroWinkler('maya lin', 'mark lin')).toBeLessThan(0.92);
  });
});

describe('identity', () => {
  it('recognizes the user by name, first name alone, email, and handle', () => {
    expect(isMe('Alex Morgan', me)).toBe(true);
    expect(isMe('alex', me)).toBe(true);
    expect(isMe('Alex M', me)).toBe(true);
    expect(isMe('Alex Hale-Morgan', me)).toBe(true);
    expect(isMe('Alex Hale', me)).toBe(false);
    expect(isMe('Alex Smith', me)).toBe(false);
    expect(isMe('ALEX@example.com', me)).toBe(true);
    expect(isMe('other@example.com', me)).toBe(false);
    expect(isMe('@AlexM', me)).toBe(true);
    expect(isMe('Maya Lin', me)).toBe(false);
    expect(isMe('', me)).toBe(false);
    expect(isMe('Alex', { name: '', emails: [], handles: [] })).toBe(false);
  });
  it('describes the identity for prompts', () => {
    expect(describeIdentity(me)).toBe('Alex Morgan (also: alex@example.com, @alexm)');
    expect(describeIdentity({ name: '  ', emails: [], handles: [] })).toBeNull();
    expect(hasIdentity({ name: 'A', emails: [], handles: [] })).toBe(true);
    expect(normalizeHandle(' @@Sam.Lee ')).toBe('sam.lee');
  });
});
