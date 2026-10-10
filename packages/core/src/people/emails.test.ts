import { describe, expect, it } from 'vitest';
import { findEmails, isRoleAddress } from './emails';

describe('findEmails', () => {
  it('keeps a normal address, including one inside angle brackets', () => {
    expect(findEmails('Jordan Hale <jordan.hale@example.com>').map((e) => e.email)).toEqual(['jordan.hale@example.com']);
    expect(findEmails('sam@acme.io').map((e) => e.email)).toEqual(['sam@acme.io']);
    expect(findEmails('a@b.co.uk').map((e) => e.email)).toEqual(['a@b.co.uk']);
  });

  it('stops at the domain when the next word is glued on', () => {
    expect(findEmails('casey@waterloo.cablake').map((e) => e.email)).toEqual(['casey@waterloo.ca']);
    expect(findEmails('desk@northwind.comjordan').map((e) => e.email)).toEqual(['desk@northwind.com']);
    expect(findEmails('a@b.co.ukJordan').map((e) => e.email)).toEqual(['a@b.co.uk']);
    // A space after the glued word still leaves the next address intact.
    expect(findEmails('casey@waterloo.cablake and jordan@example.com').map((e) => e.email)).toEqual(['casey@waterloo.ca', 'jordan@example.com']);
  });
});

describe('isRoleAddress', () => {
  it('treats no-reply, communications, and scheduling inboxes as shared mailboxes', () => {
    expect(isRoleAddress('noreply@northwind.com')).toBe(true);
    expect(isRoleAddress('no-reply@northwind.com')).toBe(true);
    expect(isRoleAddress('communications@alumo.ca')).toBe(true);
    expect(isRoleAddress('nyc-swe-intern-interview-scheduling@northwind.com')).toBe(true);
    expect(isRoleAddress('jordan.hale@example.com')).toBe(false);
    expect(isRoleAddress('casey@waterloo.ca')).toBe(false);
  });
});
