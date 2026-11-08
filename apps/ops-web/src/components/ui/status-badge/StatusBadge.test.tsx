import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { wcagViolations } from '../../../test-support/wcag';
import { StatusBadge, STATUS_TONES, type StatusMap, type StatusTone } from './StatusBadge';

/** A made-up domain enum: the badge knows no domain value, so the tests use none of the product's. */
type DemoState = 'OPEN' | 'HELD' | 'DONE' | 'LOST' | 'IDLE';

const DEMO_MAP = {
  OPEN: { tone: 'info', label: 'Open' },
  HELD: { tone: 'warning', label: 'Held' },
  DONE: { tone: 'success', label: 'Done' },
  LOST: { tone: 'danger', label: 'Lost' },
  IDLE: { tone: 'neutral', label: 'Idle' },
} satisfies StatusMap<DemoState>;

describe('StatusBadge', () => {
  // Break caught: a status shown by colour alone. The words are what carry it; the colour supports them (DESIGN_SYSTEM section 4.6).
  it.each(Object.entries(DEMO_MAP))('shows %s as words', (value, presentation) => {
    render(<StatusBadge status={value} map={DEMO_MAP} />);

    expect(screen.getByText(presentation.label)).toBeVisible();
    expect(screen.getByText(presentation.label)).toHaveTextContent(/\S/);
  });

  it('gives each tone its own treatment', () => {
    const classes = STATUS_TONES.map((tone) => {
      const { container, unmount } = render(
        <StatusBadge status="X" map={{ X: { tone, label: tone } }} />,
      );
      const className = container.firstElementChild?.className ?? '';
      unmount();
      return className;
    });

    expect(new Set(classes).size).toBe(STATUS_TONES.length);
    expect(STATUS_TONES).toEqual(['success', 'warning', 'danger', 'info', 'neutral']);
  });

  // Break caught: a value the build has not heard of (a newer server, a mapping not yet updated) breaking the page or being drawn in
  // a colour that means something. It is neutral, and says so in words.
  it('shows a value it has no mapping for as neutral, without echoing it', () => {
    const { container } = render(<StatusBadge status="SUSPENDED_PENDING_REVIEW" map={DEMO_MAP} />);

    expect(screen.getByText('Unknown status')).toBeVisible();
    expect(container.firstElementChild).toHaveClass('ui-status-badge--neutral');
    expect(container.textContent).not.toContain('SUSPENDED');
  });

  // Break caught: a lookup that finds the prototype's members. `constructor` is not a status, and neither is `__proto__`.
  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty', ''])(
    'shows %j as an unknown status',
    (value) => {
      render(<StatusBadge status={value} map={DEMO_MAP} />);

      expect(screen.getByText('Unknown status')).toBeVisible();
    },
  );

  it('lets the screen say what an unknown status is called', () => {
    render(<StatusBadge status="NEW" map={DEMO_MAP} unknownLabel="Status not recognised" />);

    expect(screen.getByText('Status not recognised')).toBeVisible();
  });

  // Break caught: a mapping that forgets a member of the enum. The mapping is typed over the whole enum, so adding a value to the
  // contract is a compile error until its presentation is decided, and not a grey badge in production.
  it('requires the mapping to name every value of the enum', () => {
    // @ts-expect-error DONE, LOST and IDLE are missing
    const incomplete: StatusMap<DemoState> = {
      OPEN: { tone: 'info', label: 'Open' },
      HELD: { tone: 'warning', label: 'Held' },
    };
    // @ts-expect-error a tone is one of the five status tones
    const wrongTone: StatusMap<'OPEN'> = { OPEN: { tone: 'purple', label: 'Open' } };

    expect(Object.keys(incomplete)).toHaveLength(2);
    expect(Object.keys(wrongTone)).toHaveLength(1);
  });

  it('draws a tone from the closed set of status tones', () => {
    const tones: readonly StatusTone[] = STATUS_TONES;

    expect(tones).toHaveLength(5);
  });

  it('has no WCAG 2.1 A or AA violations that can be checked without a layout engine', async () => {
    const { container } = render(
      <ul>
        {Object.keys(DEMO_MAP).map((value) => (
          <li key={value}>
            <StatusBadge status={value} map={DEMO_MAP} />
          </li>
        ))}
        <li>
          <StatusBadge status="UNLISTED" map={DEMO_MAP} />
        </li>
      </ul>,
    );

    expect(await wcagViolations(container)).toEqual([]);
  });
});
