import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { SidePanel } from '../side-panel/SidePanel';
import { RecordHeader } from './RecordHeader';

/**
 * What the title of a record is made of (redesign step R7b). A record's title is its operational code, in the monospaced face and never broken, and so it is by default; the
 * record of a person, an organisation or a rider has a name and no code, and a name in the code face is a name read as if it were a code (and one that cannot wrap).
 */
describe('RecordHeader: the kind of title', () => {
  // Break caught: a code that loses its face, which is how people tell it from a name on a call.
  it('draws a code in the code face unless it is told it is a name', () => {
    render(<RecordHeader code="ACC-PR-7KQ2MZ" />);

    const heading = screen.getByRole('heading', { level: 1, name: 'ACC-PR-7KQ2MZ' });
    expect(heading.querySelector('.ui-code')).not.toBeNull();
  });

  // Break caught: a person's name drawn as an operational code.
  it('draws a name as plain text of the heading, whole, and not in the code face', () => {
    render(<RecordHeader code="Kofi Boateng" titleKind="name" />);

    const heading = screen.getByRole('heading', { level: 1, name: 'Kofi Boateng' });
    expect(heading).toHaveAttribute('tabindex', '-1');
    expect(heading.querySelector('.ui-code')).toBeNull();
    expect(heading.textContent).toBe('Kofi Boateng');
  });

  it('draws a name in the heading beside a list, too', () => {
    render(<RecordHeader code="Kofi Boateng" titleKind="name" level={2} />);

    const heading = screen.getByRole('heading', { level: 2, name: 'Kofi Boateng' });
    expect(heading.querySelector('.ui-code')).toBeNull();
  });

  // Break caught: a name drawn in the code face only inside a panel, where the heading is the panel's and the header repeats it as text.
  it('repeats a name as plain text, and not in the code face, inside a side panel', () => {
    render(
      <SidePanel open onClose={vi.fn()} code="Kofi Boateng">
        <RecordHeader code="Kofi Boateng" titleKind="name" level={2} sentence="Waiting." />
      </SidePanel>,
    );

    expect(screen.getAllByRole('heading', { name: 'Kofi Boateng' })).toHaveLength(1);
    // The header's copy is the text of its own line; the panel's heading is the panel's.
    const copy = document.querySelector('.ui-record-header__heading');
    expect(copy).toHaveTextContent('Kofi Boateng');
    expect(copy?.querySelector('.ui-code')).toBeNull();
  });
});
