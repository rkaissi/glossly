import { describe, expect, it } from 'vitest';
import { cleanText } from './clean';

const c = (code: number) => String.fromCodePoint(code);
const OBJ = c(0xfffc);

describe('cleanText', () => {
  it('removes the object character an image or icon leaves ("OBJ")', () => {
    expect(cleanText(`${OBJ} Jordan Hale\nsee ${OBJ} here\nthumbs${OBJ} up ${OBJ}`)).toBe('Jordan Hale\nsee here\nthumbs up');
  });

  it('drops invisible characters and turns non-breaking spaces into spaces', () => {
    const text = `zero${c(0x200b)}width${c(0xad)}soft${c(0xfeff)} 10:42${c(0x202f)}AM${c(0xa0)}today`;
    expect(cleanText(text)).toBe('zerowidthsoft 10:42 AM today');
  });

  it('normalizes line endings, separators, trailing spaces, and long runs of blank lines', () => {
    expect(cleanText('\r\n\r\nfirst  \r\n\r\n\r\n\r\nsecond\t\r\n\r\n')).toBe('first\n\nsecond');
    expect(cleanText(`one${c(0x2028)}two`)).toBe('one\ntwo');
  });

  it('keeps indentation, lists, column spacing, and emoji joiners as written', () => {
    const text = `def f():\n    return 1\n- one\n- two\nQ1    120    140\n${c(0x1f469)}${c(0x200d)}${c(0x1f4bb)}`;
    expect(cleanText(text)).toBe(text);
  });

  it('can keep the edges, for context that sits next to the selection', () => {
    expect(cleanText('before\n', { trimEdges: false })).toBe('before\n');
  });
});
