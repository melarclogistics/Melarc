import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { wcagViolations } from '../../../test-support/wcag';
import {
  pairOf,
  StatusBadge,
  STATUS_PAIRS,
  STATUS_TONES,
  type StatusMap,
  type StatusTone,
} from './StatusBadge';

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

  // Break caught: a badge that is a word and nothing else (the v2 badge has a 6px dot before the words, in the colour of the pair), or a dot that a screen reader finds and reads.
  it('draws a dot before the words, and hides the dot from assistive technology', () => {
    const { container } = render(<StatusBadge status="OPEN" map={DEMO_MAP} />);

    const badge = container.firstElementChild;
    const dot = badge?.querySelector('.ui-status-badge__dot');
    expect(dot).not.toBeNull();
    expect(dot).toHaveAttribute('aria-hidden', 'true');
    expect(badge?.firstElementChild).toBe(dot);
    expect(badge?.textContent).toBe('Open');
  });

  // Break caught: the pairs of v2 (waiting, success, info, neutral, danger) renamed, reordered or one missing: the document and the stylesheet name these five.
  it('has the five pairs of the v2 badge, waiting being the warning pair', () => {
    expect(STATUS_PAIRS).toEqual(['waiting', 'success', 'info', 'neutral', 'danger']);
    expect(pairOf('warning')).toBe('waiting');
    for (const pair of STATUS_PAIRS) {
      expect(pairOf(pair)).toBe(pair);
    }
    for (const tone of STATUS_TONES) {
      expect(STATUS_PAIRS).toContain(pairOf(tone));
    }
  });

  // Break caught: a page that says `warning` (every page does today) drawn in a class the stylesheet no longer has, so that the badge loses its colours; and a map that says `waiting`
  // drawn differently from one that says `warning`.
  it('draws the warning tone and the waiting pair the same', () => {
    const warning = render(
      <StatusBadge status="X" map={{ X: { tone: 'warning', label: 'Held' } }} />,
    );
    const warningClass = warning.container.firstElementChild?.className;
    warning.unmount();
    const waiting = render(
      <StatusBadge status="X" map={{ X: { tone: 'waiting', label: 'Held' } }} />,
    );

    expect(waiting.container.firstElementChild?.className).toBe(warningClass);
    expect(waiting.container.firstElementChild).toHaveClass('ui-status-badge--waiting');
  });

  // Break caught: an unknown value drawn with a dot in a colour that means something, or with no dot at all while the others have one.
  // Break caught (the review of 499399c): a page that reaches into the badge's markup to let it wrap at its words in a narrow column ("Waiting for / confirmation"), because the badge
  // has no way to say so. The badge keeps to a line unless it is told it may wrap, and the kit's stylesheet does the rest.
  it('keeps to a line unless it is told it may wrap at its words', () => {
    const { rerender } = render(<StatusBadge status="HELD" map={DEMO_MAP} />);
    expect(screen.getByText('Held').closest('.ui-status-badge')).not.toHaveClass(
      'ui-status-badge--wraps',
    );

    rerender(<StatusBadge status="HELD" map={DEMO_MAP} wraps />);
    expect(screen.getByText('Held').closest('.ui-status-badge')).toHaveClass(
      'ui-status-badge--wraps',
    );
  });

  it('draws the dot on an unknown value too, in the neutral pair', () => {
    const { container } = render(<StatusBadge status="NEW_IN_A_NEWER_SERVER" map={DEMO_MAP} />);

    expect(container.firstElementChild).toHaveClass('ui-status-badge--neutral');
    expect(container.querySelector('.ui-status-badge__dot')).not.toBeNull();
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
