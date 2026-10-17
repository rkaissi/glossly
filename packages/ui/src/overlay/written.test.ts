import { describe, expect, it } from 'vitest';
import { writtenText, wroteNothing } from './written';

describe('writtenText', () => {
  it('cleans the streamed text, and hides the nothing-to-write answer even half arrived', () => {
    expect(writtenText('  the slides are done.\n')).toBe('the slides are done.');
    expect(writtenText('[nothing')).toBe('');
    expect(writtenText('[nothing to write]')).toBe('');
    expect(wroteNothing('[nothing to write]')).toBe(true);
    expect(wroteNothing('the slides')).toBe(false);
    expect(writtenText('```\n- one\n- two\n```')).toBe('- one\n- two');
    expect(writtenText('"Sounds good, see you then."')).toBe('Sounds good, see you then.');
    // Quotes inside the text stay.
    expect(writtenText('"Done" means shipped, not "almost"')).toBe('"Done" means shipped, not "almost"');
  });
});
