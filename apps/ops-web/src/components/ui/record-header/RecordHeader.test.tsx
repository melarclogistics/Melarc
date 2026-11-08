import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { wcagViolations } from '../../../test-support/wcag';
import { Button } from '../button/Button';
import { SidePanel } from '../side-panel/SidePanel';
import { RecordHeader } from './RecordHeader';
import { StageTracker } from './StageTracker';

const STAGES = [
  { id: 'received', label: 'Received' },
  { id: 'confirmed', label: 'Confirmed' },
  { id: 'dispatched', label: 'Dispatched' },
  { id: 'collected', label: 'Collected' },
];

describe('StageTracker', () => {
  // Break caught: stages that are only coloured bars (colour alone), or that do not say which one the record is at.
  it('tells each stage in words, and marks the current one as the current step', () => {
    render(
      <StageTracker
        label="Progress of the pickup request"
        stages={STAGES}
        currentId="dispatched"
      />,
    );

    const list = screen.getByRole('list', { name: 'Progress of the pickup request' });
    const items = within(list).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual([
      'Done: Received',
      'Done: Confirmed',
      'Current stage: Dispatched',
      'Not reached: Collected',
    ]);
    expect(items.map((item) => item.getAttribute('aria-current'))).toEqual([
      null,
      null,
      'step',
      null,
    ]);
  });

  // Break caught: the state a stage is drawn in taken from something else than its place before or after the current one.
  it('says done, current and not reached to the stylesheet, by their place', () => {
    const { container, rerender } = render(
      <StageTracker label="Progress" stages={STAGES} currentId="received" />,
    );
    const states = () =>
      [...container.querySelectorAll('li')].map((item) => item.getAttribute('data-state'));

    expect(states()).toEqual(['current', 'future', 'future', 'future']);
    rerender(<StageTracker label="Progress" stages={STAGES} currentId="collected" />);
    expect(states()).toEqual(['done', 'done', 'done', 'current']);
  });

  // Break caught (task R5.2, M12): a current stage that is not one of the stages (a state the page does not know yet) drawn as a record that has not started or has
  // finished, or the whole record page falling over for it: it degrades as StatusBadge does, neutral, with no stage current and none called done or not reached.
  it('says "Unknown stage" for a stage that is not one of its stages, and calls none done, current or not reached', () => {
    render(<StageTracker label="Progress" stages={STAGES} currentId="on_hold" />);

    const list = screen.getByRole('list', { name: 'Progress' });
    for (const stage of within(list).getAllByRole('listitem')) {
      expect(stage).toHaveAttribute('data-state', 'unknown');
      expect(stage).not.toHaveAttribute('aria-current');
    }
    expect(list.textContent).not.toMatch(/Done:|Current stage:|Not reached:/);
    expect(screen.getByText('Unknown stage')).toBeVisible();
    // The server's raw value is never drawn.
    expect(screen.queryByText(/on_hold|on hold/i)).toBeNull();
  });

  it('says the page’s own words for an unknown stage when it is given them', () => {
    render(
      <StageTracker
        label="Progress"
        stages={STAGES}
        currentId="lost"
        unknownLabel="Stage not recognised"
      />,
    );

    expect(screen.getByText('Stage not recognised')).toBeVisible();
  });

  // Break caught: two stages with one id drawn as if nothing were wrong: a defect of the page.
  it('throws for two stages with one id', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() =>
      render(
        <StageTracker
          label="Progress"
          stages={[
            { id: 'a', label: 'A' },
            { id: 'a', label: 'B' },
          ]}
          currentId="a"
        />,
      ),
    ).toThrow(/have the id "a"/);
    quiet.mockRestore();
  });
});

describe('RecordHeader', () => {
  // Break caught: a record's code that is not the page's heading or cannot take focus after a navigation, or that is shortened or re-cased.
  it('is the page heading, with the code whole and in the code face', () => {
    render(<RecordHeader code="ACC-PR-7KQ2MZ" />);

    const heading = screen.getByRole('heading', { level: 1, name: 'ACC-PR-7KQ2MZ' });
    expect(heading).toHaveAttribute('tabindex', '-1');
    expect(heading.querySelector('.ui-code')).toHaveTextContent(/^ACC-PR-7KQ2MZ$/);
  });

  // Break caught: a header in a panel that claims to be a second level-one heading.
  it('is a level-two heading when it is not the page', () => {
    render(<RecordHeader code="ACC-PR-7KQ2MZ" level={2} />);

    expect(screen.getByRole('heading', { level: 2, name: 'ACC-PR-7KQ2MZ' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
  });

  // Break caught: the parts of a record header in another order (a keyboard and a screen reader meet the actions before the code, or the tracker before the sentence).
  it('draws the status, the sentence, the tracker and the actions it is given, in that order', () => {
    const { container } = render(
      <RecordHeader
        code="ACC-PR-7KQ2MZ"
        status={<span>Confirmed</span>}
        sentence="The hub has confirmed the pickup for Wednesday."
        stages={{ label: 'Progress', stages: STAGES, currentId: 'confirmed' }}
        secondaryActions={
          <Button type="button" variant="secondary">
            Edit note
          </Button>
        }
        primaryAction={<Button type="button">Assign a rider</Button>}
        menu={<button type="button">More actions</button>}
      />,
    );

    expect(screen.getByText('The hub has confirmed the pickup for Wednesday.')).toBeVisible();
    const order = [
      ...container.querySelectorAll<HTMLElement>(
        'h1, .ui-record-header__status, .ui-record-header__sentence, button, ol',
      ),
    ].map((node) => node.textContent);
    expect(order[0]).toBe('ACC-PR-7KQ2MZ');
    expect(order.slice(1, 3)).toEqual([
      'Confirmed',
      'The hub has confirmed the pickup for Wednesday.',
    ]);
    // The actions: the others first, then the one primary, then the menu; the tracker last.
    expect(order.slice(3, 6)).toEqual(['Edit note', 'Assign a rider', 'More actions']);
    expect(container.querySelector('ol')).not.toBeNull();
  });

  // Break caught: empty bars of actions, a status or a tracker left in a header that has none, which assistive technology still walks through.
  it('draws nothing for what it was not given', () => {
    const { container } = render(<RecordHeader code="ACC-PR-7KQ2MZ" />);

    for (const part of ['status', 'sentence', 'actions', 'stages']) {
      expect(container.querySelector(`.ui-record-header__${part}`), part).toBeNull();
    }
  });

  // Break caught: a heading, a list of stages or an action that fails a rule of WCAG 2.2 which can be seen without a layout engine.
  it('has no WCAG violations that can be checked without a layout engine', async () => {
    const { container } = render(
      <RecordHeader
        code="ACC-PR-7KQ2MZ"
        status={<span>Confirmed</span>}
        sentence="The hub has confirmed the pickup for Wednesday."
        stages={{ label: 'Progress of the pickup request', stages: STAGES, currentId: 'confirmed' }}
        primaryAction={<Button type="button">Assign a rider</Button>}
      />,
    );

    expect(await wcagViolations(container)).toEqual([]);
  });
});

describe('RecordHeader inside a SidePanel (task R5.2, M12)', () => {
  // Break caught: the record's code drawn as a heading in the header and again as the panel's own heading: two headings with one name, read twice.
  it('draws the code as text and leaves the heading to the panel', () => {
    render(
      <SidePanel open onClose={vi.fn()} code="ACC-PR-7KQ2MZ">
        <RecordHeader code="ACC-PR-7KQ2MZ" level={2} sentence="Waiting for confirmation." />
      </SidePanel>,
    );

    expect(screen.getAllByRole('heading', { name: 'ACC-PR-7KQ2MZ' })).toHaveLength(1);
    expect(screen.getAllByText('ACC-PR-7KQ2MZ').length).toBeGreaterThanOrEqual(2);
  });

  it('is the record’s heading beside a list, outside a panel', () => {
    render(<RecordHeader code="ACC-PR-7KQ2MZ" level={2} />);

    expect(screen.getByRole('heading', { level: 2, name: 'ACC-PR-7KQ2MZ' })).toBeInTheDocument();
  });
});
