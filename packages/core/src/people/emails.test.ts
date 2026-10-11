import { describe, expect, it } from 'vitest';
import { findEmails, isRoleAddress } from './emails';

describe('findEmails', () => {
  it('keeps a normal address, including one inside angle brackets', () => {
    expect(findEmails('Jordan Hale <jordan.hale@example.com>').map((e) => e.email)).toEqual(['jordan.hale@example.com']);
    expect(findEmails('sam@acme.io').map((e) => e.email)).toEqual(['sam@acme.io']);
    expect(findEmails('a@b.co.uk').map((e) => e.email)).toEqual(['a@b.co.uk']);
  });

  it('stops at the domain when the next word is glued on', () => {
    expect(findEmails('casey@lakeview.cariley').map((e) => e.email)).toEqual(['casey@lakeview.ca']);
    expect(findEmails('desk@northwind.comjordan').map((e) => e.email)).toEqual(['desk@northwind.com']);
    expect(findEmails('a@b.co.ukJordan').map((e) => e.email)).toEqual(['a@b.co.uk']);
    // A space after the glued word still leaves the next address intact.
    expect(findEmails('casey@lakeview.cariley and jordan@example.com').map((e) => e.email)).toEqual(['casey@lakeview.ca', 'jordan@example.com']);
  });

  it('keeps an address that ends a sentence', () => {
    expect(findEmails('Write to jordan@example.com.').map((e) => e.email)).toEqual(['jordan@example.com']);
    expect(findEmails('Mail jordan@example.com. Thanks').map((e) => e.email)).toEqual(['jordan@example.com']);
  });

  it('splits a capitalized word off the domain, and keeps endings it does not list', () => {
    expect(findEmails('casey@lakeview.caRiley').map((e) => e.email)).toEqual(['casey@lakeview.ca']);
    expect(findEmails('desk@mail.northwind.comJordan').map((e) => e.email)).toEqual(['desk@mail.northwind.com']);
    expect(findEmails('sam@bistro.cafe').map((e) => e.email)).toEqual(['sam@bistro.cafe']);
    expect(findEmails('sam@town.community').map((e) => e.email)).toEqual(['sam@town.community']);
  });
});

describe('isRoleAddress', () => {
  it('treats no-reply, communications, and scheduling inboxes as shared mailboxes', () => {
    expect(isRoleAddress('noreply@northwind.com')).toBe(true);
    expect(isRoleAddress('no-reply@northwind.com')).toBe(true);
    expect(isRoleAddress('communications@fabrikam.ca')).toBe(true);
    expect(isRoleAddress('team-intern-interview-scheduling@northwind.com')).toBe(true);
    expect(isRoleAddress('jordan.hale@example.com')).toBe(false);
    expect(isRoleAddress('casey@lakeview.ca')).toBe(false);
  });
});
