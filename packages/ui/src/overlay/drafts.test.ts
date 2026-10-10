import { describe, expect, it } from 'vitest';
import { parseDrafts } from './drafts';

const FULL = `### Yes, Friday works | agree | warm
Sure! I'll send the slides by Friday.

### Need more time | decline | direct
Hey Maya, can I get them to you Monday instead?

### Ask which slides | ask | neutral
Happy to. Do you want the full deck or just the summary?`;

const untagged = (intent: string, text: string) => ({ intent, text, kind: null, tone: null });

describe('parseDrafts', () => {
  it('splits three labeled drafts with their kind and tone', () => {
    expect(parseDrafts(FULL)).toEqual([
      { intent: 'Yes, Friday works', kind: 'agree', tone: 'warm', text: "Sure! I'll send the slides by Friday." },
      { intent: 'Need more time', kind: 'decline', tone: 'direct', text: 'Hey Maya, can I get them to you Monday instead?' },
      { intent: 'Ask which slides', kind: 'ask', tone: 'neutral', text: 'Happy to. Do you want the full deck or just the summary?' },
    ]);
  });

  it('reads a tag written loosely, and a label with no tag', () => {
    expect(parseDrafts('### Change the subject | Follow Up | Playful\nAnyway!')[0]).toMatchObject({ intent: 'Change the subject', kind: 'follow_up', tone: 'playful' });
    expect(parseDrafts('### Sounds good\nOk')).toEqual([untagged('Sounds good', 'Ok')]);
  });

  it('shows drafts as they stream, without a half-written header', () => {
    expect(parseDrafts('### Yes, Fri')).toEqual([untagged('Yes, Fri', '')]);
    expect(parseDrafts("### Yes, Friday works | agr\nSure! I'll send\n##")).toEqual([{ intent: 'Yes, Friday works', kind: 'agr', tone: null, text: "Sure! I'll send" }]);
  });

  it('accepts drifted formats and keeps multi-line email drafts', () => {
    const raw = 'Here are some options:\n\n**Option 1: Accept**\nHi Helen,\n\nYes, I can share it.\n\nBest,\nRayan\n\n## "Decline"\nNo thanks.';
    expect(parseDrafts(raw)).toEqual([untagged('Accept', 'Hi Helen,\n\nYes, I can share it.\n\nBest,\nRayan'), untagged('Decline', 'No thanks.')]);
  });

  it('stops at three', () => {
    expect(parseDrafts(`${FULL}\n\n### Extra\nnope`)).toHaveLength(3);
    expect(parseDrafts('')).toEqual([]);
  });
});
