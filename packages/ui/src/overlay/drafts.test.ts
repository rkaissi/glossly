import { describe, expect, it } from 'vitest';
import { parseDrafts } from './drafts';

const FULL = `### Yes, Friday works
Sure! I'll send the slides by Friday.

### Need more time
Hey Maya, can I get them to you Monday instead?

### Ask which slides
Happy to. Do you want the full deck or just the summary?`;

describe('parseDrafts', () => {
  it('splits three labeled drafts', () => {
    expect(parseDrafts(FULL)).toEqual([
      { intent: 'Yes, Friday works', text: "Sure! I'll send the slides by Friday." },
      { intent: 'Need more time', text: 'Hey Maya, can I get them to you Monday instead?' },
      { intent: 'Ask which slides', text: 'Happy to. Do you want the full deck or just the summary?' },
    ]);
  });

  it('shows drafts as they stream, without a half-written header', () => {
    expect(parseDrafts('### Yes, Fri')).toEqual([{ intent: 'Yes, Fri', text: '' }]);
    expect(parseDrafts("### Yes, Friday works\nSure! I'll send\n##")).toEqual([{ intent: 'Yes, Friday works', text: "Sure! I'll send" }]);
  });

  it('accepts drifted formats and keeps multi-line email drafts', () => {
    const raw = 'Here are some options:\n\n**Option 1: Accept**\nHi Helen,\n\nYes, I can share it.\n\nBest,\nRayan\n\n## "Decline"\nNo thanks.';
    expect(parseDrafts(raw)).toEqual([
      { intent: 'Accept', text: 'Hi Helen,\n\nYes, I can share it.\n\nBest,\nRayan' },
      { intent: 'Decline', text: 'No thanks.' },
    ]);
  });

  it('stops at three', () => {
    expect(parseDrafts(`${FULL}\n\n### Extra\nnope`)).toHaveLength(3);
    expect(parseDrafts('')).toEqual([]);
  });
});
