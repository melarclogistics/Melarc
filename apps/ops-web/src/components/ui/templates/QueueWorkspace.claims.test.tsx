import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import type { DataColumn } from '../data-table/DataTable';
import { QueuePager } from './QueuePager';
import { QueueWorkspace, type QueueWorkspaceProps } from './QueueWorkspace';

/**
 * Two claims of components that are gone, which the retire of the older queue table and the page-level "nothing at this hub" (41e204d) listed no holder for, held where they now belong: the
 * workspace, which draws the filters, the rows and the pager in one order, and which words the nothing of a hub and of filters together (RUN6 Stage 4.12).
 */
interface Row {
  readonly id: string;
  readonly code: string;
}

const ROWS: readonly Row[] = [
  { id: 'a', code: 'ACC-PR-7KQ2MZ' },
  { id: 'b', code: 'ACC-PR-4HT9WD' },
];

const COLUMNS: readonly DataColumn<Row>[] = [
  { id: 'code', header: 'Request', rowHeader: true, cell: (row) => row.code },
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

describe('QueueWorkspace: the order of the keyboard', () => {
  // Break caught (the claim of the older queue table's "reaches the pager by Tab after the rows"): a pager drawn before the rows, or taken out of the order of the page, so that a person who has read the rows has
  // to go back for the next page.
  it('reaches the pager by Tab after the filters and the rows, in that order', async () => {
    const user = userEvent.setup();
    renderQueue({
      filters: {
        label: 'Filters',
        chips: [{ id: 'hub', label: 'Hub: Accra Central' }],
        onRemove: () => undefined,
      },
      table: {
        ...props().table,
        footer: (
          <QueuePager
            label="Pages of pickup requests"
            noun={{ one: 'request', other: 'requests' }}
            shown={2}
            page={1}
            hasNext
            onNext={() => undefined}
            onPrevious={() => undefined}
          />
        ),
      },
    });
    const filters = screen.getByRole('group', { name: 'Filters' });
    const results = screen.getByRole('region', { name: 'Pickup requests' });
    const next = screen.getByRole('button', { name: 'Next page' });
    const placeOf = (element: Element): string =>
      element === next
        ? 'the pager'
        : filters.contains(element)
          ? 'the filters'
          : results.contains(element)
            ? 'the rows'
            : 'elsewhere';

    // What Tab meets, one stop after another, until it has met the pager (a few more than the page has, so that a pager that is never met fails and does not hang).
    const met: string[] = [];
    for (let presses = 0; presses < 8; presses += 1) {
      await user.tab();
      const held = document.activeElement;
      if (held === null) break;
      met.push(placeOf(held));
      if (held === next) break;
    }

    // The rows may be one stop (the region that scrolls) or several (the region, then the row that has the place): the order is the claim.
    expect(met.filter((place, index) => place !== met[index - 1])).toEqual([
      'the filters',
      'the rows',
      'the pager',
    ]);
  });

  it('keeps the pager out of the rows: its buttons are in the footer, not in the region that scrolls', () => {
    renderQueue({
      table: {
        ...props().table,
        footer: (
          <QueuePager
            label="Pages of pickup requests"
            noun={{ one: 'request', other: 'requests' }}
            shown={2}
            page={2}
            hasNext
            onNext={() => undefined}
            onPrevious={() => undefined}
          />
        ),
      },
    });

    const results = screen.getByRole('region', { name: 'Pickup requests' });
    expect(within(results).queryByRole('button', { name: 'Next page' })).toBeNull();
    expect(within(results).queryByRole('button', { name: 'Previous page' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Next page' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeVisible();
  });
});

describe('QueueWorkspace: the nothing of a hub', () => {
  const nothing = { status: 'ready', rows: [] } as const;

  // Break caught (the page-level "nothing at this hub" said it, and the template's sentence lost it): a hub and the page's filters both set, told as nothing that fits, with neither of the two ways out in the words.
  it('says what to do when a hub and the page’s filters are both set: show all hubs, or take the other filters off', async () => {
    const user = userEvent.setup();
    const onAllHubs = vi.fn();
    const onClear = vi.fn();
    renderQueue({
      result: nothing,
      empty: {
        noun: 'pickup requests',
        none: 'x',
        filtered: true,
        onClearFilters: onClear,
        clearLabel: 'Show every request',
        filteredText: 'Nothing fits these filters. Show every request to start again.',
        hub: { name: 'Tema', onShowAllHubs: onAllHubs },
      },
    });

    expect(
      screen.getByText(
        'No pickup requests at Tema fit these filters. Show all hubs, or take the other filters off.',
      ),
    ).toBeVisible();
    // The two ways the words name are the two buttons beside them.
    await user.click(screen.getByRole('button', { name: 'Show all hubs' }));
    await user.click(screen.getByRole('button', { name: 'Show every request' }));
    expect(onAllHubs).toHaveBeenCalledTimes(1);
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  // Break caught: the advice to take other filters off given where none are set, which sends a person looking for a filter that is not there.
  it('says only to show all hubs when the hub is the only thing narrowing the queue', () => {
    renderQueue({
      result: nothing,
      empty: {
        noun: 'pickup requests',
        none: 'x',
        hub: { name: 'Tema', onShowAllHubs: () => undefined },
      },
    });

    expect(
      screen.getByText(
        'No pickup requests at Tema. Show all hubs to see those of every hub your session reaches.',
      ),
    ).toBeVisible();
    expect(screen.queryByText(/take the other filters off/)).toBeNull();
  });
});
