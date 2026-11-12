import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { wcagViolations } from '../../../test-support/wcag';
import { Avatar } from './Avatar';

describe('Avatar', () => {
  // Break caught: initials taken from the wrong words (the first two letters of the first word), or not in capitals.
  it.each([
    ['Ama Mensah', 'AM'],
    ['kofi', 'K'],
    ['Esi Ama Owusu', 'EO'],
    ['  Yaw   Boateng ', 'YB'],
  ])('draws the initials of %j as %s', (name, initials) => {
    const { container } = render(<Avatar name={name} />);

    expect(container.textContent).toBe(initials);
  });

  // Break caught: a name with no letter drawn as nothing at all (an empty tile), or as its digits.
  it.each([null, '', '1234', '—'])(
    'draws the account icon, and no text, for the name %j',
    (name) => {
      const { container } = render(<Avatar name={name} />);

      expect(container.textContent).toBe('');
      expect(container.querySelector('svg')).not.toBeNull();
    },
  );

  // Break caught: a name read twice (an avatar beside a name that announces itself), or an avatar that stands alone with no name for a screen reader.
  it('is decoration beside a name, and a picture named by the person on its own', () => {
    const { container, unmount } = render(<Avatar name="Ama Mensah" />);

    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true');
    expect(screen.queryByRole('img')).toBeNull();
    unmount();

    render(<Avatar name="Ama Mensah" alone />);
    expect(screen.getByRole('img', { name: 'Ama Mensah' })).toBeInTheDocument();
  });

  // Break caught: a lone avatar of a person with no name given no name at all.
  it('names a lone avatar of nobody in particular', () => {
    render(<Avatar name={null} alone />);

    expect(screen.getByRole('img', { name: 'Unknown person' })).toBeInTheDocument();
  });

  // Break caught: the three sizes (24, 32 and 40px) collapsed into one, or the size not reaching the primitive.
  it.each([
    ['sm', 'sm'],
    ['md', 'default'],
    ['lg', 'lg'],
  ] as const)('draws size %s as the primitive size %s', (size, primitive) => {
    const { container } = render(<Avatar name="Ama Mensah" size={size} />);

    expect(container.firstElementChild).toHaveAttribute('data-ui-size', size);
    expect(container.firstElementChild).toHaveAttribute('data-size', primitive);
  });

  // Break caught: the round shape and the muted fill of the primitive left in place: the avatar of the portal is a tile in text.secondary on surface.selected (its stylesheet).
  it('is the portal tile, not the primitive default', () => {
    const { container } = render(<Avatar name="Ama Mensah" />);

    expect(container.firstElementChild).toHaveClass('ui-avatar');
    expect(container.querySelector('.ui-avatar__fallback')).toHaveTextContent('AM');
  });

  // Break caught: a name, a role or a relationship the automated checks see is wrong, alone or beside a name.
  it('has no automated WCAG violation', async () => {
    const { container } = render(
      <>
        <Avatar name="Ama Mensah" alone />
        <p>
          <Avatar name="Kofi Boateng" /> Kofi Boateng
        </p>
      </>,
    );

    expect(await wcagViolations(container)).toEqual([]);
  });
});
