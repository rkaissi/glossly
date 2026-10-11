import { describe, expect, it } from 'vitest';
import { rulesCommitments, splitDue } from './promise-rules';

// Wednesday, Oct 14 2026.
const now = new Date(2026, 9, 14, 10, 0);
const other = { name: 'Jordan Hale', isMe: false };
const me = { name: null, isMe: true };

describe('splitDue', () => {
  it('takes the deadline out of the task', () => {
    expect(splitDue('send the deck by Friday', now)).toEqual({ task: 'send the deck', due: 'by Friday' });
    expect(splitDue('review it tomorrow 3pm before the call', now)).toEqual({ task: 'review it before the call', due: 'tomorrow 3pm' });
    expect(splitDue('book the room next week', now)).toEqual({ task: 'book the room', due: 'next week' });
  });

  it('leaves words that only look like dates', () => {
    expect(splitDue('work on this over the weekend plan', now).task).toContain('work on this');
    expect(splitDue('send this one', now)).toEqual({ task: 'send this one', due: null });
  });
});

describe('rulesCommitments', () => {
  it('reads a request to the reader and a promise by the author', () => {
    const out = rulesCommitments("Can you send me the budget by Friday? I'll share the notes with Casey.", other, now);
    expect(out.commitments).toEqual([
      { owner: 'me', person_name: 'Jordan Hale', text: 'send me the budget', due_phrase: 'by Friday', confidence: 0.6 },
      { owner: 'them', person_name: 'Jordan Hale', text: 'share the notes with Casey', due_phrase: '', confidence: 0.4 },
    ]);
  });

  it('flips owners when the user wrote the message', () => {
    const out = rulesCommitments("I'll send the contract tomorrow. Could you please sign it by Monday?", me, now);
    expect(out.commitments.map((c) => [c.owner, c.text, c.due_phrase, c.person_name])).toEqual([
      ['me', 'send the contract', 'tomorrow', ''],
      ['them', 'sign it', 'by Monday', ''],
    ]);
  });

  it('skips figures of speech and plain statements', () => {
    expect(rulesCommitments("Can you believe it? I'll be honest, the launch went well. Let me know.", other, now).commitments).toEqual([]);
    expect(rulesCommitments('The report is attached.', other, now).commitments).toEqual([]);
  });

  it('handles curly apostrophes and line breaks', () => {
    const out = rulesCommitments('Thanks!\nI’ll call the vendor on Thursday', other, now);
    expect(out.commitments).toEqual([{ owner: 'them', person_name: 'Jordan Hale', text: 'call the vendor', due_phrase: 'on Thursday', confidence: 0.6 }]);
  });
});
