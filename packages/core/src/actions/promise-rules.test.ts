import { describe, expect, it } from 'vitest';
import type { CommitmentView } from '../people/types';
import { matchOpenTasks, rulesCommitments, splitDue } from './promise-rules';

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

describe('todos (decision 36)', () => {
  it('reads todo lines and reminders as the user\'s own', () => {
    const out = rulesCommitments('todo: renew passport by Nov 1\nRemember to book the flights', me, now);
    expect(out.commitments.map((c) => [c.owner, c.text, c.due_phrase, c.person_name])).toEqual([
      ['me', 'renew passport', 'by Nov 1', ''],
      ['them', 'book the flights', '', ''],
    ]);
    // "I need to" binds whoever wrote it.
    expect(rulesCommitments('I need to finish the report by Friday.', other, now).commitments[0]).toMatchObject({ owner: 'them', text: 'finish the report' });
  });
});

describe('matchOpenTasks', () => {
  const task = (id: string, owner: 'me' | 'them', text: string): CommitmentView => ({ id, owner, text, due_at: null, status: 'open', completed_at: null, person_id: 'p1', person_name: 'Jordan Hale' });
  const open = [
    { key: 't1', task: task('a', 'me', 'send the Q3 budget') },
    { key: 't2', task: task('b', 'them', 'review the contract') },
  ];
  const row = (owner: 'me' | 'them', text: string, due_phrase = '') => ({ owner, person_name: 'Jordan Hale', text, due_phrase, confidence: 0.6 });

  it('matches by words and owner, and a new deadline means moved', () => {
    const out = matchOpenTasks({ commitments: [row('me', 'send me the budget for Q3'), row('them', 'review the contract', 'Monday'), row('me', 'review the contract')] }, open);
    expect(out.commitments.map((c) => [c.change, c.open_task])).toEqual([
      ['same', 't1'],
      ['moved', 't2'],
      // Same words, other owner, and t2 is taken: new.
      ['new', 'none'],
    ]);
  });
});
