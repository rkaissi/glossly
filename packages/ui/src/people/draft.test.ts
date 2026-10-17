import { describe, expect, it } from 'vitest';
import { draftFromQuery, draftToCreate } from './draft';

describe('draftFromQuery', () => {
  it('puts a name in the name field', () => {
    expect(draftFromQuery('  Jordan Hale ')).toMatchObject({ name: 'Jordan Hale', email: '', handle: '' });
  });
  it('puts an email in the email field', () => {
    expect(draftFromQuery('alex.morgan@example.com')).toMatchObject({ name: '', email: 'alex.morgan@example.com', handle: '' });
  });
  it('puts a @handle in the handle field without the @', () => {
    expect(draftFromQuery('@casey_lin')).toMatchObject({ name: '', email: '', handle: 'casey_lin' });
  });
  it('starts empty from an empty search', () => {
    expect(draftFromQuery('')).toEqual({ name: '', email: '', handle: '', note: '', relationship: 'other' });
  });
  it('round-trips into people:create args with blanks left out', () => {
    expect(draftToCreate(draftFromQuery('Maya Chen'))).toEqual({ name: 'Maya Chen', relationship: 'other' });
  });
});
