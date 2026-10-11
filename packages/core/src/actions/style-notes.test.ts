import { describe, expect, it } from 'vitest';
import type { ChatRequest, LlmProvider } from '../llm/types';
import { acceptStyleNotes, buildStyleNotesPrompt, writeStyleNotes } from './style-notes';

const pairs = [
  { original: 'Hi Maya,\n\nThanks so much for the update. I will review it today.\n\nBest,\nAlex', text: 'thanks, will review today' },
  { original: 'Hi Jordan,\n\nThat works for me. See you on Friday.\n\nBest,\nAlex', text: 'works for me, see you friday' },
  { original: 'Sounds great! I will be there.', text: 'sounds good, ill be there' },
];

describe('style notes', () => {
  it('puts each pair with what code measured into the prompt', () => {
    const p = buildStyleNotesPrompt(pairs, ['Uses emoji']);
    expect(p).toContain('<pair n="1">');
    expect(p).toMatch(/<measured>words 15 → 4; .*Writes in lowercase.*<\/measured>/);
    expect(p).toContain('## Notes the user removed\n- Uses emoji');
  });

  it('keeps notes backed by two real pairs, drops removed ones, repeats, and a crowded aspect', () => {
    const notes = acceptStyleNotes(
      {
        notes: [
          { aspect: 'capitalization', note: 'Writes in lowercase', pairs: [1, 2, 3] },
          { aspect: 'greeting', note: 'Drops the greeting', pairs: [1] },
          { aspect: 'greeting', note: 'Skips "Hi"', pairs: [1, 9] },
          { aspect: 'emoji', note: 'Uses emoji', pairs: [1, 2] },
          { aspect: 'capitalization', note: 'writes in lowercase.', pairs: [1, 2] },
          { aspect: 'punctuation', note: 'Drops the final period', pairs: [1, 2] },
          { aspect: 'punctuation', note: 'Fewer commas', pairs: [2, 3] },
          { aspect: 'punctuation', note: 'No exclamation marks', pairs: [2, 3] },
        ],
      },
      3,
      ['Uses emoji'],
    );
    expect(notes).toEqual(['Writes in lowercase', 'Drops the final period', 'Fewer commas']);
  });

  it('asks the Fast role at temperature 0, and skips the call with fewer than two pairs', async () => {
    const calls: ChatRequest[] = [];
    const llm: LlmProvider = {
      stream: () => {
        throw new Error('unused');
      },
      structured: async <T>(req: ChatRequest) => {
        calls.push(req);
        return { notes: [{ aspect: 'length', note: 'Cuts to one line', pairs: [1, 2] }] } as T;
      },
      hasModel: () => true,
    };
    expect(await writeStyleNotes(llm, pairs.slice(0, 1), [])).toEqual([]);
    expect(calls).toHaveLength(0);
    expect(await writeStyleNotes(llm, pairs, [])).toEqual(['Cuts to one line']);
    expect(calls[0]).toMatchObject({ role: 'fast', action: 'style_notes', temperature: 0 });
  });
});
