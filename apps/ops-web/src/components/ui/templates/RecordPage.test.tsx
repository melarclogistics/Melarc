import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import { wcagViolations } from '../../../test-support/wcag';
import { Button } from '../button/Button';
import { Panel } from '../panel/Panel';
import { InSidePanel } from '../side-panel/side-panel-context';
import { RecordPage, type RecordPageProps } from './RecordPage';

const STAGES = [
  { id: 'received', label: 'Received' },
  { id: 'confirmed', label: 'Confirmed' },
] as const;

function props(overrides: Partial<RecordPageProps> = {}): RecordPageProps {
  return {
    header: {
      code: 'ACC-PR-7KQ2MZ',
      sentence: 'The hub confirmed this pickup. A rider is not assigned yet.',
      stages: { label: 'Progress of the pickup request', stages: STAGES, currentId: 'confirmed' },
    },
    main: (
      <Panel title="Pickup" headingLevel={2}>
        <p>The pickup’s facts.</p>
      </Panel>
    ),
    ...overrides,
  };
}

function renderRecord(
  overrides: Partial<RecordPageProps> = {},
  wrap?: (node: ReactNode) => ReactNode,
) {
  const node = <RecordPage {...props(overrides)} />;
  return render(<MemoryRouter>{wrap === undefined ? node : wrap(node)}</MemoryRouter>);
}

describe('RecordPage', () => {
  // Break caught: a record whose code is not the page's one level-one heading, or a header with no stage tracker or sentence where they were given.
  it('has the code for its one level-one heading, with the sentence and the stages', () => {
    renderRecord({ header: { ...props().header, status: <span>Confirmed</span> } });

    expect(screen.getByRole('heading', { level: 1, name: 'ACC-PR-7KQ2MZ' })).toBeVisible();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByText(/A rider is not assigned yet/)).toBeVisible();
    expect(screen.getByLabelText('Progress of the pickup request')).toBeVisible();
    expect(screen.getByRole('heading', { level: 2, name: 'Pickup' })).toBeVisible();
  });

  // Break caught: an act the session cannot take drawn anyway (presentation is the only thing the template does about it), or a menu with nothing in it drawn as a dead button.
  it('draws the acts it was given and nothing it was not, and no menu with no item', () => {
    const { rerender } = renderRecord({
      acts: {
        primary: <Button type="button">Assign a rider</Button>,
        secondary: (
          <Button type="button" variant="secondary">
            Edit the note
          </Button>
        ),
        menu: { label: 'More actions for ACC-PR-7KQ2MZ', items: [] },
      },
    });
    expect(screen.getByRole('button', { name: 'Assign a rider' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Edit the note' })).toBeVisible();
    expect(screen.queryByRole('button', { name: /More actions/ })).toBeNull();

    rerender(
      <MemoryRouter>
        <RecordPage
          {...props({
            acts: {
              menu: {
                label: 'More actions for ACC-PR-7KQ2MZ',
                items: [{ id: 'hub', label: 'Change the hub', onSelect: () => undefined }],
              },
            },
          })}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: 'More actions for ACC-PR-7KQ2MZ' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Assign a rider' })).toBeNull();

    rerender(
      <MemoryRouter>
        <RecordPage {...props({ acts: {} })} />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('button')).toBeNull();
  });

  // Break caught: the primary act after the others (a narrow screen draws it below them, a keyboard meets it last), or the short line of the acts lost between the page and the
  // header. The same in a side panel, where the lead holds the acts.
  for (const where of ['the page', 'a side panel'] as const) {
    it(`puts the primary act first, then the others, then the menu, and the short line under them, in ${where}`, () => {
      renderRecord(
        {
          acts: {
            primary: <Button type="button">Dispatch</Button>,
            secondary: (
              <Button type="button" variant="secondary">
                Assign a rider
              </Button>
            ),
            menu: {
              label: 'More actions for ACC-PR-7KQ2MZ',
              items: [{ id: 'cancel', label: 'Cancel the run', onSelect: () => undefined }],
            },
            note: 'The rider sees nothing until you dispatch.',
          },
        },
        where === 'the page'
          ? undefined
          : (node) => <InSidePanel.Provider value>{node}</InSidePanel.Provider>,
      );

      const follows = (later: HTMLElement, earlier: HTMLElement): boolean =>
        (earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
      const primary = screen.getByRole('button', { name: 'Dispatch' });
      const secondary = screen.getByRole('button', { name: 'Assign a rider' });
      const menu = screen.getByRole('button', { name: 'More actions for ACC-PR-7KQ2MZ' });
      const note = screen.getByText('The rider sees nothing until you dispatch.');
      expect(follows(secondary, primary)).toBe(true);
      expect(follows(menu, secondary)).toBe(true);
      expect(follows(note, menu)).toBe(true);
    });
  }

  // Break caught: a stale version with no banner, a banner with no Reload, or one that is not announced when it appears.
  it('says a version is stale in a banner with Reload, announced', async () => {
    const user = userEvent.setup();
    const onReload = vi.fn();
    renderRecord({ conflict: { onReload } });

    const banner = screen.getByRole('alert');
    expect(banner).toHaveTextContent(/changed since you opened it/);
    await user.click(within(banner).getByRole('button', { name: 'Reload' }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  // Break caught: a breadcrumb that is lost, or a side column and an activity timeline that are not on the page.
  it('draws the breadcrumb, the side column and the activity timeline', () => {
    const { container } = renderRecord({
      breadcrumb: [{ label: 'Pickup requests', to: '/pickup-requests' }],
      side: (
        <Panel title="Sender" headingLevel={2}>
          <p>The sender.</p>
        </Panel>
      ),
      activity: {
        entries: [
          { key: 'a', title: 'Booked by the vendor' },
          { key: 'b', title: 'Confirmed by the hub', current: true },
        ],
      },
    });

    expect(screen.getByRole('link', { name: 'Pickup requests' })).toHaveAttribute(
      'href',
      '/pickup-requests',
    );
    expect(container.querySelector('.ui-record-page__side')).toContainElement(
      screen.getByRole('heading', { level: 2, name: 'Sender' }),
    );
    const timeline = screen.getByRole('list', { name: 'Activity of the record' });
    const steps = within(timeline).getAllByRole('listitem');
    expect(steps).toHaveLength(2);
    // The page marks the latest step for assistive technology; the order says it to the eye, so no "Latest" is drawn beside it.
    expect(steps[1]).toHaveAttribute('aria-current', 'step');
    expect(within(timeline).queryByText('Latest')).toBeNull();
  });

  // Break caught: the words a page gives for its current step lost on the way to the timeline.
  it('draws the words a page gives for the current step of its activity', () => {
    renderRecord({
      activity: {
        currentLabel: 'This request',
        entries: [
          { key: 'a', title: 'Booked by the vendor' },
          { key: 'b', title: 'Confirmed by the hub', current: true },
        ],
      },
    });

    const timeline = screen.getByRole('list', { name: 'Activity of the record' });
    expect(within(timeline).getByText('This request')).toBeVisible();
  });

  // Break caught: the same composition in a side panel repeating the code as a second heading, drawing a breadcrumb in a narrow panel, or losing the acts the panel is for.
  it('renders in a side panel with no heading of its own, no breadcrumb and the acts', () => {
    renderRecord(
      {
        breadcrumb: [{ label: 'Pickup requests', to: '/pickup-requests' }],
        acts: { primary: <Button type="button">Confirm pickup</Button> },
        activity: { entries: [{ key: 'a', title: 'Booked by the vendor' }] },
      },
      (node) => <InSidePanel.Provider value>{node}</InSidePanel.Provider>,
    );

    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Pickup requests' })).toBeNull();
    expect(screen.getByText(/A rider is not assigned yet/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Confirm pickup' })).toBeVisible();
    expect(screen.getByRole('heading', { level: 3, name: 'Activity' })).toBeVisible();
  });

  // Break caught: a composition that fails a WCAG 2.2 rule with all its parts present.
  it('has no accessibility violation with everything drawn', async () => {
    const { container } = renderRecord({
      breadcrumb: [{ label: 'Pickup requests', to: '/pickup-requests' }],
      acts: { primary: <Button type="button">Assign a rider</Button> },
      conflict: { onReload: () => undefined },
      side: (
        <Panel title="Sender" headingLevel={2}>
          <p>The sender.</p>
        </Panel>
      ),
      activity: { entries: [{ key: 'a', title: 'Booked by the vendor', current: true }] },
    });

    expect(await wcagViolations(container)).toEqual([]);
  });
});
