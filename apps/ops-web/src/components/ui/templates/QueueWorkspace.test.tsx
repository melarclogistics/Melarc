import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef, useState } from 'react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import { wcagViolations } from '../../../test-support/wcag';
import type { DataColumn } from '../data-table/DataTable';
import {
  QueueWorkspace,
  type QueueWorkspaceHandle,
  type QueueWorkspaceProps,
} from './QueueWorkspace';

interface Row {
  readonly id: string;
  readonly code: string;
  readonly state: string;
}

const ROWS: readonly Row[] = [
  { id: 'a', code: 'ACC-PR-7KQ2MZ', state: 'Waiting' },
  { id: 'b', code: 'ACC-PR-4HT9WD', state: 'Confirmed' },
];

const COLUMNS: readonly DataColumn<Row>[] = [
  { id: 'code', header: 'Request', rowHeader: true, cell: (row) => row.code },
  { id: 'state', header: 'State', cell: (row) => row.state },
];

function props(overrides: Partial<QueueWorkspaceProps<Row>> = {}): QueueWorkspaceProps<Row> {
  return {
    header: { title: 'Pickup requests', count: { value: 2, noun: 'pickup requests' } },
    result: { status: 'ready', rows: ROWS },
    empty: { noun: 'pickup requests', none: 'Requests booked at your hubs appear here.' },
    table: {
      label: 'Pickup requests',
      columns: COLUMNS,
      rowId: (row) => row.id,
      onOpen: () => undefined,
      openLabel: (row) => `Open ${row.code}`,
    },
    ...overrides,
  };
}

function renderQueue(overrides: Partial<QueueWorkspaceProps<Row>> = {}) {
  return render(
    <MemoryRouter>
      <QueueWorkspace<Row> {...props(overrides)} />
    </MemoryRouter>,
  );
}

describe('QueueWorkspace', () => {
  // Break caught: a template that loses a part of the queue's one shape, or draws them out of their order (the header, the views, the filters, the table).
  it('draws the header, the views with the counts they were given, the filters and the table, in that order', () => {
    renderQueue({
      views: {
        label: 'Views of the pickup queue',
        value: 'all',
        onValueChange: () => undefined,
        tabs: [
          { id: 'waiting', label: 'Needs decision', count: 1 },
          { id: 'all', label: 'All', count: 2 },
        ],
      },
      filters: {
        label: 'Filters',
        chips: [{ id: 'hub', label: 'Hub: Accra Central' }],
        onRemove: () => undefined,
      },
    });

    const heading = screen.getByRole('heading', { level: 1, name: 'Pickup requests' });
    const tabs = screen.getByRole('tablist', { name: 'Views of the pickup queue' });
    const filters = screen.getByRole('group', { name: 'Filters' });
    const table = screen.getByRole('table', { name: 'Pickup requests' });
    const before = (first: Element, second: Element): boolean =>
      (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    expect(before(heading, tabs)).toBe(true);
    expect(before(tabs, filters)).toBe(true);
    expect(before(filters, table)).toBe(true);
    expect(within(tabs).getByRole('tab', { name: /Needs decision/ })).toHaveTextContent('1');
    expect(screen.getByRole('button', { name: 'Open ACC-PR-7KQ2MZ' })).toBeInTheDocument();
  });

  // Break caught: a queue with no views or no filters that still draws an empty strip for them.
  it('draws no views and no filter row when it was given none', () => {
    renderQueue();

    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByRole('group', { name: 'Filters' })).toBeNull();
    expect(screen.getByRole('table', { name: 'Pickup requests' })).toBeInTheDocument();
  });

  // Break caught: a failure told in the API's words, or one with no way to try again, or loading rows drawn as if they were an answer.
  it('tells loading and a failure in the page’s words, with the way to try again', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const { rerender } = renderQueue({ result: { status: 'loading' } });
    expect(screen.queryByRole('button', { name: 'Open ACC-PR-7KQ2MZ' })).toBeNull();
    expect(screen.getByText('Loading pickup requests')).toBeInTheDocument();

    rerender(
      <MemoryRouter>
        <QueueWorkspace<Row>
          {...props({
            result: {
              status: 'error',
              message: 'The pickup requests could not be read. Try again.',
              onRetry,
            },
          })}
        />
      </MemoryRouter>,
    );
    // The words are drawn once for the eye and once in the table's live region, which is how a screen reader hears that the read failed.
    expect(
      screen.getAllByText('The pickup requests could not be read. Try again.').length,
    ).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  // Break caught: stale rows dropped, or kept without a word to say they may be out of date.
  it('keeps stale rows and says they may be out of date', () => {
    renderQueue({
      result: {
        status: 'ready',
        rows: ROWS,
        stale: { message: 'The list may be out of date.', onRefresh: () => undefined },
      },
    });

    expect(screen.getByText('The list may be out of date.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Open ACC-PR-7KQ2MZ' })).toBeInTheDocument();
  });

  // Break caught: the three kinds of nothing conflated (which sends Ops hunting for a bug), or a hub that is a filter told as "nothing yet".
  it('tells nothing yet, nothing that fits and nothing at the hub apart', async () => {
    const user = userEvent.setup();
    const onClear = vi.fn();
    const onAllHubs = vi.fn();
    const empty = { status: 'ready', rows: [] } as const;
    const { rerender } = renderQueue({ result: empty });
    expect(screen.getByRole('heading', { name: 'No pickup requests yet' })).toBeVisible();
    expect(screen.getByText('Requests booked at your hubs appear here.')).toBeVisible();

    rerender(
      <MemoryRouter>
        <QueueWorkspace<Row>
          {...props({
            result: empty,
            empty: {
              noun: 'pickup requests',
              none: 'x',
              filtered: true,
              onClearFilters: onClear,
              clearLabel: 'Show every request',
              filteredText: 'Nothing fits these filters. Show every request to start again.',
            },
          })}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: 'No pickup requests match' })).toBeVisible();
    // The words under the heading and the button are the page's, so that the sentence and the button say the same thing: the template holds none of its own.
    expect(
      screen.getByText('Nothing fits these filters. Show every request to start again.'),
    ).toBeVisible();
    expect(screen.queryByText(/Take them off/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Show every request' }));
    expect(onClear).toHaveBeenCalledTimes(1);

    rerender(
      <MemoryRouter>
        <QueueWorkspace<Row>
          {...props({
            result: empty,
            empty: {
              noun: 'pickup requests',
              none: 'x',
              hub: { name: 'Accra Central', onShowAllHubs: onAllHubs },
            },
          })}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: 'Nothing at Accra Central' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Show all hubs' }));
    expect(onAllHubs).toHaveBeenCalledTimes(1);
  });

  // Break caught: a hub filter that is told as one with no way back, because the page's own filters were also set.
  it('offers both ways out when a hub and the page’s filters are both set', () => {
    renderQueue({
      result: { status: 'ready', rows: [] },
      empty: {
        noun: 'pickup requests',
        none: 'x',
        filtered: true,
        onClearFilters: () => undefined,
        clearLabel: 'Show every request',
        filteredText: 'Nothing fits these filters. Show every request to start again.',
        hub: { name: 'Tema', onShowAllHubs: () => undefined },
      },
    });

    expect(screen.getByRole('button', { name: 'Show all hubs' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Show every request' })).toBeVisible();
    expect(screen.getByText(/No pickup requests at Tema fit these filters/)).toBeVisible();
  });

  // Break caught: a page that has to replace the template's states for a case of its own (an empty page after the first) and cannot.
  it('draws the page’s own state in place of the three kinds of nothing', () => {
    renderQueue({
      result: { status: 'ready', rows: [] },
      emptyState: <p>No requests on this page.</p>,
    });

    expect(screen.getByText('No requests on this page.')).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'No pickup requests yet' })).toBeNull();
  });

  // Break caught: a record panel that takes the queue's place instead of standing beside it, or one that does not say whose record it is.
  it('draws the open record beside the queue, which stays', () => {
    const { container } = renderQueue({
      panel: {
        open: true,
        onClose: () => undefined,
        code: 'ACC-PR-7KQ2MZ',
        fullPage: { to: '/pickup-requests/a' },
        children: <p>The record.</p>,
      },
    });

    const split = container.querySelector('.ui-queue-workspace__split');
    expect(split).toHaveAttribute('data-panel', 'open');
    expect(screen.getByRole('table', { name: 'Pickup requests' })).toBeVisible();
    const panel = screen.getByRole('dialog', { name: 'ACC-PR-7KQ2MZ' });
    expect(split).toContainElement(panel);
    expect(within(panel).getByRole('link', { name: 'Open full page' })).toHaveAttribute(
      'href',
      '/pickup-requests/a',
    );
  });

  // Break caught: a panel that closes and leaves focus on nothing, because the row button it was opened from is not the one that is drawn now (the table and its cards swap when
  // the panel narrows the room): the way back is the row's control as it is, found by the row's id.
  it('gives focus back to the row the panel was opened from when it closes', async () => {
    const user = userEvent.setup();
    function Page() {
      const [opened, setOpened] = useState<Row | undefined>();
      return (
        <QueueWorkspace<Row>
          {...props({
            table: { ...props().table, onOpen: setOpened },
            panel: {
              open: opened !== undefined,
              onClose: () => {
                setOpened(undefined);
              },
              code: opened?.code ?? '',
              children: <p>The record.</p>,
            },
          })}
        />
      );
    }
    render(
      <MemoryRouter>
        <Page />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: 'Open ACC-PR-4HT9WD' }));
    // The panel fades in: it is in the page, whether or not its first frames are over.
    expect(await screen.findByRole('dialog', { name: 'ACC-PR-4HT9WD' })).toBeInTheDocument();
    await user.keyboard('{Escape}');

    expect(screen.getByRole('button', { name: 'Open ACC-PR-4HT9WD' })).toHaveFocus();
  });

  // Break caught (the review of 5edada2, M3): rows that go to loading rows while they are read again after an act, so that the officer loses their place, their focus and the row
  // that changed. The rows stay, the queue says it is busy, and the row that changed is marked.
  it('keeps its rows, with the one that changed marked, while they are read again after an act', () => {
    const { rerender } = renderQueue();
    expect(screen.getByRole('region', { name: 'Pickup requests' })).not.toHaveAttribute(
      'aria-busy',
    );

    rerender(
      <MemoryRouter>
        <QueueWorkspace<Row>
          {...props({
            result: { status: 'ready', rows: ROWS, refreshing: true },
            table: { ...props().table, changedIds: ['a'] },
          })}
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole('region', { name: 'Pickup requests' })).toHaveAttribute(
      'aria-busy',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Open ACC-PR-7KQ2MZ' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Open ACC-PR-4HT9WD' })).toBeVisible();
    expect(screen.queryByText('Loading pickup requests')).toBeNull();
    // The row that changed is told in words as well as by its tint.
    expect(screen.getByRole('button', { name: 'Open ACC-PR-7KQ2MZ' })).toHaveAccessibleDescription(
      'Updated',
    );
    expect(
      screen.getByRole('button', { name: 'Open ACC-PR-4HT9WD' }),
    ).not.toHaveAccessibleDescription();
  });

  // Break caught: a page that has to look for the kit's classes to give focus back to a row, because the template gives it no way to.
  it('gives the page a handle to put focus on a row or on the results, in the table or in cards', () => {
    const handle = createRef<QueueWorkspaceHandle>();
    const view = render(
      <MemoryRouter>
        <QueueWorkspace<Row> {...props()} ref={handle} />
      </MemoryRouter>,
    );

    expect(handle.current?.focusRow('b')).toBe(true);
    expect(screen.getByRole('button', { name: 'Open ACC-PR-4HT9WD' })).toHaveFocus();
    expect(handle.current?.focusRow('zzz')).toBe(false);
    handle.current?.focusResults();
    expect(screen.getByRole('region', { name: 'Pickup requests' })).toHaveFocus();

    view.rerender(
      <MemoryRouter>
        <QueueWorkspace<Row>
          {...props({ table: { ...props().table, layout: 'cards', card: (row) => row.code } })}
          ref={handle}
        />
      </MemoryRouter>,
    );
    expect(handle.current?.focusRow('a')).toBe(true);
    expect(screen.getByRole('button', { name: 'Open ACC-PR-7KQ2MZ' })).toHaveFocus();
  });

  // Break caught: a template that words "nothing fits" with its own sentence, so that it said "take them off" beside a button the page labelled "Show every request".
  it('says nothing of its own under "No requests match": the words are the page’s', () => {
    renderQueue({
      result: { status: 'ready', rows: [] },
      empty: {
        noun: 'pickup requests',
        none: 'x',
        filtered: true,
        onClearFilters: () => undefined,
        clearLabel: 'Show everything',
        filteredText: 'No request has that date. Show everything to start again.',
      },
    });

    expect(
      screen.getByText('No request has that date. Show everything to start again.'),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Show everything' })).toBeVisible();
    expect(document.body.textContent).not.toMatch(/Take them off|Show every request/);
  });

  // Break caught: a template whose own composition fails a WCAG 2.2 rule that no part fails alone.
  it('has no accessibility violation with views, filters, rows and a panel', async () => {
    const { container } = renderQueue({
      views: {
        label: 'Views of the pickup queue',
        value: 'all',
        onValueChange: () => undefined,
        tabs: [{ id: 'all', label: 'All', count: 2 }],
      },
      filters: { label: 'Filters', chips: [], onRemove: () => undefined },
      panel: {
        open: true,
        onClose: () => undefined,
        code: 'ACC-PR-7KQ2MZ',
        children: <p>The record.</p>,
      },
    });

    expect(await wcagViolations(container)).toEqual([]);
  });
});
