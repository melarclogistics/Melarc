import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import { RecordPage } from './RecordPage';

/**
 * The record page passes the kind of its title on to the record header (redesign step R7b): the record of a person has a name for a title and no code.
 */
describe('RecordPage: the title of a record that has a name', () => {
  it('draws the name as the page’s one heading, not in the code face', () => {
    render(
      <MemoryRouter>
        <RecordPage header={{ code: 'Kofi Boateng', titleKind: 'name' }} main={<p>The work.</p>} />
      </MemoryRouter>,
    );

    const heading = screen.getByRole('heading', { level: 1, name: 'Kofi Boateng' });
    expect(heading.querySelector('.ui-code')).toBeNull();
  });

  it('draws a code in the code face when the page says nothing', () => {
    render(
      <MemoryRouter>
        <RecordPage header={{ code: 'ACC-PR-7KQ2MZ' }} main={<p>The work.</p>} />
      </MemoryRouter>,
    );

    expect(
      screen.getByRole('heading', { level: 1, name: 'ACC-PR-7KQ2MZ' }).querySelector('.ui-code'),
    ).not.toBeNull();
  });
});
