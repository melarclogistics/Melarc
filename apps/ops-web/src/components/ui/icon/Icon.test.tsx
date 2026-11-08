import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { wcagViolations } from '../../../test-support/wcag';
import { Icon, ICON_STROKE_WIDTH } from './Icon';
import { ICON_NAMES } from './icons';

describe('Icon', () => {
  // Break caught: an icon that repeats the words beside it and is read out twice ("Staff, Staff"), which is the usual case.
  it('is decorative unless it is given a label: hidden from assistive technology, with no role', () => {
    const { container } = render(<Icon name="staff" />);

    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).not.toHaveAttribute('role');
    expect(svg).not.toHaveAttribute('aria-label');
    expect(screen.queryByRole('img')).toBeNull();
  });

  // Break caught: an icon that stands alone and says nothing to a screen reader.
  it('is an image with its label as its name when it stands alone', () => {
    render(<Icon name="warning" label="Something went wrong" />);

    expect(screen.getByRole('img', { name: 'Something went wrong' })).toBeVisible();
  });

  // Break caught: sizes that drift from the tokens, which makes the family look uneven (DESIGN_SYSTEM section 24).
  it.each([
    [undefined, 'ui-icon--md'],
    ['sm', 'ui-icon--sm'],
    ['md', 'ui-icon--md'],
    ['lg', 'ui-icon--lg'],
  ] as const)('is drawn at size %s with the class of its token', (size, expected) => {
    const { container } = render(<Icon name="menu" {...(size === undefined ? {} : { size })} />);

    expect(container.querySelector('svg')).toHaveClass('ui-icon', expected);
  });

  // Break caught: one icon with a thicker or thinner line than the rest, which is what mixing families looks like.
  it('draws every icon of the registry with the same stroke, from the currentColor of the text around it', () => {
    for (const name of ICON_NAMES) {
      const { container, unmount } = render(<Icon name={name} />);

      const svg = container.querySelector('svg');
      expect(svg, name).not.toBeNull();
      expect(svg?.getAttribute('stroke-width'), name).toBe(String(ICON_STROKE_WIDTH));
      expect(svg?.getAttribute('stroke'), name).toBe('currentColor');
      expect(svg?.querySelector('path, circle, line, rect, polyline'), name).not.toBeNull();
      unmount();
    }
  });

  it('adds a class of the caller beside its own, so that a screen can place it', () => {
    const { container } = render(<Icon name="success" className="somewhere" />);

    expect(container.querySelector('svg')).toHaveClass('ui-icon', 'somewhere');
  });

  it('has no accessibility violations, decorative or labelled', async () => {
    const { container } = render(
      <>
        <p>
          <Icon name="success" /> Saved
        </p>
        <Icon name="warning" label="Failed" />
      </>,
    );

    expect(await wcagViolations(container)).toEqual([]);
  });
});
