import { describe, expect, it } from 'vitest';

import { currentEntry } from './current-entry';

describe('the current entry', () => {
  const entries = [
    { to: '/' },
    { to: '/admin/staff' },
    { to: '/admin/staff/new' },
    { to: '/pickup-requests' },
  ];

  // Break caught: the landing current on every page (a prefix of every address), or no entry current on its own page.
  it('is the root entry on the root page and on no other', () => {
    expect(currentEntry(entries, '/')?.to).toBe('/');
    expect(currentEntry(entries, '/nowhere')).toBeUndefined();
  });

  // Break caught: the entry of a page that belongs to another entry not being current (a person's profile under Staff).
  it('keeps the entry current for a page that belongs to it', () => {
    expect(currentEntry(entries, '/pickup-requests/abc')?.to).toBe('/pickup-requests');
    expect(currentEntry(entries, '/admin/staff/abc/mfa/reset')?.to).toBe('/admin/staff');
  });

  // Break caught: two entries current at once, or the shorter one winning where one lies under another.
  it('is the most specific entry the address is at or under', () => {
    expect(currentEntry(entries, '/admin/staff/new')?.to).toBe('/admin/staff/new');
  });

  // Break caught: a prefix match that is not at a segment: `/admin/staffing` is not under `/admin/staff`.
  it('does not take a longer word for a page under an entry', () => {
    expect(currentEntry(entries, '/admin/staffing')).toBeUndefined();
  });

  it('is nothing when there are no entries', () => {
    const none: typeof entries = [];

    expect(currentEntry(none, '/')).toBeUndefined();
  });
});
