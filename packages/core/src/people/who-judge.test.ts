import { describe, expect, it } from 'vitest';
import type { DetectInput } from './detect';
import type { WhoCandidate } from './who-judge';
import { acceptWhoRows, localWho, whoCorpus } from './who-judge';

const me = { name: 'Alex Morgan', emails: ['alex.morgan@example.com'], handles: ['alexmorgan'] };

const emailText = [
  'From: Maya Chen (mc)<maya.chen@example.com>',
  'To: Priya Shah <priya.shah@example.com>; Lena Ortiz',
  'Cc: Sam Okonkwo; Alex Hale-Morgan <alex.morgan@example.com>',
  '',
  'Reply',
  'Forward',
  'Reactions',
  'Cc',
].join('\n');

const emailInput: DetectInput = {
  text: emailText,
  before: '',
  after: '',
  source_app: 'msedge.exe',
  window_title: 'Inbox - Outlook',
};

const discordText = ['quinn', '3:12 PM', 'hey', 'Alex', '3:14 PM', 'sure @alexmorgan', 'Add Reaction', 'Edit', 'Edit', 'Forward', 'Forward', 'Reply', 'More'].join('\n');

const discordInput: DetectInput = {
  text: discordText,
  before: '',
  after: '',
  source_app: 'chrome.exe',
  window_title: '@quinn - Google Chrome',
};

const row = (over: Partial<WhoCandidate> & Pick<WhoCandidate, 'name' | 'evidence'>): WhoCandidate => ({
  email: '',
  handle: '',
  role: '',
  relation: '',
  confidence: 0.9,
  ...over,
});

describe('localWho', () => {
  it('keeps header people and their emails, and leaves the user out', () => {
    const people = localWho(emailInput, me);
    expect(people.map((p) => p.name)).toEqual(['Maya Chen', 'Priya Shah', 'Lena Ortiz', 'Sam Okonkwo']);
    expect(people.find((p) => p.name === 'Maya Chen')?.email).toBe('maya.chen@example.com');
    expect(people.find((p) => p.name === 'Priya Shah')?.email).toBe('priya.shah@example.com');
    expect(people.every((p) => p.detail == null && p.relation == null)).toBe(true);
    expect(people.some((p) => /alex|sorted|reply|morgan cc/i.test(`${p.name} ${p.email}`))).toBe(false);
  });

  it('keeps a lone chat speaker and a handle in the window title', () => {
    const people = localWho(discordInput, me);
    expect(people.map((p) => p.name)).toEqual(['quinn']);
    expect(people[0]?.handle).toBe('quinn');
    expect(people.some((p) => /alex|reaction|edit|forward/i.test(p.name ?? ''))).toBe(false);
  });
});

describe('acceptWhoRows', () => {
  it('keeps the email people, attaches a missed address, and drops the user and the chrome', () => {
    const corpus = whoCorpus(emailInput);
    const people = acceptWhoRows(
      [
        row({ name: 'Maya Chen', role: 'recruiter at Northwind', relation: 'colleague of Priya', evidence: 'Maya Chen' }),
        row({ name: 'Priya Shah', email: 'priya.shah@example.com', evidence: 'Priya Shah' }),
        row({ name: 'Lena Ortiz', evidence: 'Lena Ortiz' }),
        row({ name: 'Sam Okonkwo', evidence: 'Sam Okonkwo' }),
        row({ name: 'Alex Hale', confidence: 0.95, evidence: 'Alex Hale' }),
        row({ name: 'Alex Hale-Morgan', email: 'alex.morgan@example.com', evidence: 'Alex Hale-Morgan' }),
        row({ name: 'Reactions Reply', evidence: 'Reactions Reply' }),
        row({ name: 'Morgan Cc', evidence: 'Morgan Cc' }),
        row({ name: 'Sorted', evidence: 'Sorted' }),
      ],
      corpus,
      me,
    );
    expect(people.map((p) => p.name)).toEqual(['Maya Chen', 'Priya Shah', 'Lena Ortiz', 'Sam Okonkwo']);
    expect(people.find((p) => p.name === 'Maya Chen')).toMatchObject({
      email: 'maya.chen@example.com',
      detail: 'recruiter at Northwind',
      relation: 'colleague of Priya',
    });
    expect(people.find((p) => p.name === 'Priya Shah')?.email).toBe('priya.shah@example.com');
  });

  it('keeps only quinn from a discord read that echoes the buttons', () => {
    const people = acceptWhoRows(
      [
        row({ name: 'quinn', handle: 'quinn', evidence: 'quinn' }),
        row({ name: 'Alex', evidence: 'Alex' }),
        row({ name: 'Add Reaction', evidence: 'Add Reaction' }),
        row({ name: 'Edit Edit', evidence: 'Edit Edit' }),
        row({ name: 'Forward Forward', evidence: 'Forward Forward' }),
      ],
      whoCorpus(discordInput),
      me,
    );
    expect(people.map((p) => [p.name, p.handle])).toEqual([['quinn', 'quinn']]);
  });

  it('merges Sam, Sam Smith, and Smith into the longest name', () => {
    const corpus = 'Sam Smith will send the notes.';
    const people = acceptWhoRows(
      [
        row({ name: 'Sam', evidence: 'Sam' }),
        row({ name: 'Smith', evidence: 'Smith' }),
        row({ name: 'Sam Smith', evidence: 'Sam Smith' }),
      ],
      corpus,
      me,
    );
    expect(people.map((p) => p.name)).toEqual(['Sam Smith']);
  });

  it('does not turn a glued address or a shared inbox into a person', () => {
    const corpus = [
      'Hello team',
      '',
      'casey@waterloo.cablake',
      'communications@alumo.ca',
      'nyc-swe-intern-interview-scheduling@northwind.comjordan',
      '',
      'Jordan Hale <jordan.hale@example.com> will follow up.',
    ].join('\n');
    const people = acceptWhoRows(
      [
        row({ name: 'Jordan Hale', evidence: 'Jordan Hale' }),
        row({ name: 'casey@waterloo.cablake', email: 'casey@waterloo.cablake', evidence: 'casey@waterloo.cablake' }),
        row({ name: 'communications@alumo.ca', email: 'communications@alumo.ca', evidence: 'communications@alumo.ca' }),
      ],
      corpus,
      me,
    );
    expect(people.map((p) => [p.name, p.email])).toEqual([['Jordan Hale', 'jordan.hale@example.com']]);
  });

  it("keeps the model's relationship when it is one of the list, and drops anything else", () => {
    const corpus = 'Jordan Hale (recruiter at Northwind) and Casey Lee from my climbing group';
    const people = acceptWhoRows(
      [
        row({ name: 'Jordan Hale', evidence: 'Jordan Hale', relationship: 'Professional' }),
        row({ name: 'Casey Lee', evidence: 'Casey Lee', relationship: 'climbing buddy' }),
      ],
      corpus,
      me,
    );
    expect(people.map((p) => [p.name, p.relationship])).toEqual([
      ['Jordan Hale', 'professional'],
      ['Casey Lee', null],
    ]);
  });

  it('reads a quote across a line break and a confidence given in percent', () => {
    const corpus = 'From: Maya Chen\nThanks,\nMaya';
    const people = acceptWhoRows([row({ name: 'Maya Chen', confidence: 85, evidence: 'Thanks, Maya' })], corpus, me);
    expect(people.map((p) => p.name)).toEqual(['Maya Chen']);
  });
});

describe('localWho edge cases', () => {
  const input = (text: string): DetectInput => ({ text, before: '', after: '', source_app: 'msedge.exe', window_title: '' });

  it('splits recipients on commas but keeps "Last, First" whole', () => {
    const names = localWho(input('To: Priya Shah, Lena Ortiz\nCc: Okonkwo, Sam'), me).map((p) => p.name);
    expect(names).toEqual(['Priya Shah', 'Lena Ortiz', 'Okonkwo, Sam']);
  });

  it('does not name a handle after the greeting before it', () => {
    const people = localWho(input('Thanks @quinn for the notes'), me);
    expect(people.map((p) => [p.name, p.handle])).toEqual([[null, 'quinn']]);
  });

  it('needs a line that is only a time under a lone speaker', () => {
    expect(localWho(input('Meeting\n3:00 PM tomorrow in room 4'), me)).toEqual([]);
    expect(localWho(input('quinn\nToday at 3:12 PM\nhey'), me).map((p) => p.name)).toEqual(['quinn']);
  });
});
