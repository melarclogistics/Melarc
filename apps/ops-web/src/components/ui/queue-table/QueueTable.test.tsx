import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Fragment, useEffect, useState } from 'react';
import { describe, expect, it } from 'vitest';

import { Field } from '../field/Field';
import { Select } from '../select/Select';
import type { TableColumn } from '../table/Table';
import { QueueFilters, QueuePanel, QueueTable } from './QueueTable';
import { useQueuePaging } from './use-queue-paging';

interface DemoRow {
  readonly id: string;
  readonly name: string;
}

/** A synthetic server: pages by token, for two filters. Nothing here is product data. */
const PAGES: Readonly<
  Record<string, Readonly<Record<string, { rows: DemoRow[]; next: string | null }>>>
> = {
  every: {
    first: {
      rows: [
        { id: '1', name: 'Demo row one' },
        { id: '2', name: 'Demo row two' },
      ],
      next: 't2',
    },
    t2: { rows: [{ id: '3', name: 'Demo row three' }], next: null },
  },
  odd: {
    first: { rows: [{ id: '1', name: 'Demo row one' }], next: null },
  },
};

const COLUMNS: readonly TableColumn<DemoRow>[] = [
  { key: 'name', header: 'Name', rowHeader: true, cell: (row) => row.name },
];

/** A queue page as a screen would build one, with a read that answers one tick later, as a server does. */
function DemoQueue({
  asked,
  cards = false,
  panel = false,
}: {
  readonly asked: string[];
  /** Whether the screen also draws each row as a card, as the pickup queue does. */
  readonly cards?: boolean;
  /** Whether the screen sets its filters and its rows in one panel, as the pickup queue does. */
  readonly panel?: boolean;
}) {
  const [filter, setFilter] = useState('every');
  const paging = useQueuePaging(filter);
  const key = paging.pageToken ?? 'first';
  const [answer, setAnswer] = useState<{ key: string; rows: DemoRow[]; next: string | null }>();

  useEffect(() => {
    asked.push(`${filter}:${key}`);
    const timer = setTimeout(() => {
      const page = PAGES[filter]?.[key] ?? { rows: [], next: null };
      setAnswer({ key: `${filter}:${key}`, ...page });
    }, 0);
    return () => {
      clearTimeout(timer);
    };
  }, [asked, filter, key]);

  const loaded = answer?.key === `${filter}:${key}` ? answer : undefined;
  const Surface = panel ? QueuePanel : Fragment;
  return (
    <Surface>
      <QueueFilters label="Filter the demo rows">
        <Field label="Demo filter">
          <Select
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value);
            }}
          >
            <option value="every">Every row</option>
            <option value="odd">Odd rows</option>
          </Select>
        </Field>
      </QueueFilters>
      {loaded === undefined ? (
        <p>Loading the demo rows…</p>
      ) : (
        <QueueTable
          caption="Demo rows"
          columns={COLUMNS}
          rows={loaded.rows}
          rowKey={(row) => row.id}
          noun={{ one: 'row', other: 'rows' }}
          paging={paging}
          nextPageToken={loaded.next}
          {...(cards ? { card: (row: DemoRow) => <p>Card of {row.name}</p> } : {})}
        />
      )}
    </Surface>
  );
}

function renderQueue(options: { readonly cards?: boolean; readonly panel?: boolean } = {}) {
  const asked: string[] = [];
  const view = render(<DemoQueue asked={asked} {...options} />);
  return { ...view, asked, user: userEvent.setup() };
}

describe('QueueTable: what it shows', () => {
  it('puts the filters in a named group, and the rows in a table named by the caption', async () => {
    renderQueue();

    expect(screen.getByRole('group', { name: 'Filter the demo rows' })).toBeVisible();
    const table = await screen.findByRole('table', { name: 'Demo rows' });
    expect(
      within(table)
        .getAllByRole('rowheader')
        .map((cell) => cell.textContent),
    ).toEqual(['Demo row one', 'Demo row two']);
  });

  // Break caught: a count of one page taken for the size of the queue, and a count in the plural for one row.
  it('counts the page it shows and says when more follow, without claiming a total', async () => {
    const { user } = renderQueue();

    expect(await screen.findByText('Showing 2 rows. More follow on the next page.')).toBeVisible();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Demo filter' }), 'odd');
    expect(await screen.findByText('Showing 1 row.')).toBeVisible();
  });

  it('announces the count politely, so a change of filter is heard', async () => {
    renderQueue();

    expect(await screen.findByRole('status')).toHaveTextContent('Showing 2 rows.');
  });

  it('offers no pager for a queue that fits on one page', async () => {
    const { user } = renderQueue();
    await screen.findByRole('table', { name: 'Demo rows' });

    await user.selectOptions(screen.getByRole('combobox', { name: 'Demo filter' }), 'odd');
    await screen.findByText('Showing 1 row.');

    expect(screen.queryByRole('navigation')).toBeNull();
  });
});

describe('QueueTable: moving between pages', () => {
  it('asks for the next page with the server’s token, says which page it is, and goes back to the first', async () => {
    const { user, asked } = renderQueue();
    await screen.findByRole('table', { name: 'Demo rows' });
    expect(screen.queryByRole('button', { name: 'Previous page' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Next page' }));

    expect(await screen.findByText('Showing 1 row on page 2.')).toBeVisible();
    expect(asked.at(-1)).toBe('every:t2');
    expect(screen.queryByRole('button', { name: 'Next page' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Previous page' }));

    expect(await screen.findByText('Showing 2 rows. More follow on the next page.')).toBeVisible();
    expect(asked.at(-1)).toBe('every:first');
  });

  // Break caught: the pager's button gone while the next page loads, so that a keyboard user is dropped at the top of the document.
  it('puts focus on the rows of the page the person moved to, by keyboard', async () => {
    const { user } = renderQueue();
    await screen.findByRole('table', { name: 'Demo rows' });
    screen.getByRole('button', { name: 'Next page' }).focus();

    await user.keyboard('{Enter}');

    const region = (await screen.findByRole('table', { name: 'Demo rows' })).closest(
      '.ui-queue-table__results',
    );
    expect(region).toHaveFocus();
    expect(screen.getByText('Showing 1 row on page 2.')).toBeVisible();
  });

  it('does not take focus when the page is drawn for any other reason', async () => {
    const { user } = renderQueue();
    await screen.findByRole('table', { name: 'Demo rows' });
    const filter = screen.getByRole('combobox', { name: 'Demo filter' });

    await user.selectOptions(filter, 'odd');
    await screen.findByText('Showing 1 row.');

    expect(filter).toHaveFocus();
  });

  // Break caught: the token of one filter's next page sent with another filter, which is a page of a different queue.
  it('starts again at the first page when the filter changes', async () => {
    const { user, asked } = renderQueue();
    await screen.findByRole('table', { name: 'Demo rows' });
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await screen.findByText('Showing 1 row on page 2.');

    await user.selectOptions(screen.getByRole('combobox', { name: 'Demo filter' }), 'odd');

    expect(await screen.findByText('Showing 1 row.')).toBeVisible();
    expect(asked.at(-1)).toBe('odd:first');
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText(/on page 2/)).toBeNull();
  });

  it('reaches the pager by Tab after the rows', async () => {
    const { user } = renderQueue();
    await screen.findByRole('table', { name: 'Demo rows' });

    await user.tab();
    expect(screen.getByRole('combobox', { name: 'Demo filter' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('region', { name: 'Demo rows' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Next page' })).toHaveFocus();
  });
});

/**
 * A screen may give a queue a card for each row. The rows are then drawn twice, as a table and as a list of cards, and the stylesheet shows
 * the one that fits the room the queue has (queue-table.css; jsdom applies no CSS, so what is shown is proved in the browser, in
 * `test/browser/pickup.spec.ts`). These tests hold the structure that rule depends on.
 */
describe('QueueTable: cards for a narrow room', () => {
  it('draws each row as a card, in a list named by the caption, beside the table in the one results region', async () => {
    renderQueue({ cards: true });

    const table = await screen.findByRole('table', { name: 'Demo rows' });
    const list = screen.getByRole('list', { name: 'Demo rows' });

    expect(
      within(list)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['Card of Demo row one', 'Card of Demo row two']);
    expect(
      within(table)
        .getAllByRole('rowheader')
        .map((cell) => cell.textContent),
    ).toEqual(['Demo row one', 'Demo row two']);
    const region = table.closest('.ui-queue-table__results');
    expect(region).not.toBeNull();
    expect(region).toContainElement(list);
  });

  // Break caught: cards drawn for every queue, so that the approvals and the message log would list their rows twice.
  it('draws no list for a queue given no card', async () => {
    renderQueue();
    await screen.findByRole('table', { name: 'Demo rows' });

    expect(screen.queryByRole('list')).toBeNull();
    expect(document.querySelector('.ui-queue-table--cards')).toBeNull();
  });

  // Break caught: a list whose semantics a style removes (`list-style: none` takes a list from VoiceOver in Safari), so that a phone's screen
  // reader would not say how many cards there are.
  it('says it is a list outright, whatever the stylesheet does to its markers', async () => {
    renderQueue({ cards: true });

    expect(await screen.findByRole('list', { name: 'Demo rows' })).toHaveAttribute('role', 'list');
  });

  it('follows the rows to the next page and puts focus on the results that hold the cards', async () => {
    const { user } = renderQueue({ cards: true });
    await screen.findByRole('table', { name: 'Demo rows' });
    screen.getByRole('button', { name: 'Next page' }).focus();

    await user.keyboard('{Enter}');

    expect(await screen.findByText('Card of Demo row three')).toBeInTheDocument();
    expect(screen.queryByText('Card of Demo row one')).toBeNull();
    const region = screen
      .getByRole('list', { name: 'Demo rows' })
      .closest('.ui-queue-table__results');
    expect(region).toHaveFocus();
  });
});

/**
 * A screen may set the filters of a queue, its count, its rows and its pager in one panel (the pickup queue does). The stylesheet draws the
 * surface and the hairlines between its parts (jsdom applies no CSS, so what is drawn is proved in the browser, in `test/browser/pickup.spec.ts`);
 * these tests hold what that rule depends on: everything the person works with is inside the one element, whatever state the rows are in.
 */
describe('QueuePanel: one surface for the filters, the count and the rows', () => {
  it('holds the filters, the count and the rows of a queue in one element', async () => {
    renderQueue({ panel: true });

    const table = await screen.findByRole('table', { name: 'Demo rows' });
    const panel = table.closest('.ui-queue-panel');

    expect(panel).not.toBeNull();
    expect(panel).toContainElement(screen.getByRole('group', { name: 'Filter the demo rows' }));
    expect(panel).toContainElement(screen.getByRole('status'));
    expect(panel).toContainElement(screen.getByRole('button', { name: 'Next page' }));
  });

  it('keeps the filters in the panel while the rows are still to come', () => {
    renderQueue({ panel: true });

    const waiting = screen.getByText('Loading the demo rows…');

    expect(waiting.closest('.ui-queue-panel')).toContainElement(
      screen.getByRole('group', { name: 'Filter the demo rows' }),
    );
  });

  // Break caught: a panel drawn around every queue, so that the approvals and the message log would change with the pickup queue.
  it('draws no panel for a queue that is not given one', async () => {
    renderQueue();
    await screen.findByRole('table', { name: 'Demo rows' });

    expect(document.querySelector('.ui-queue-panel')).toBeNull();
  });
});

/**
 * A screen may set something beside the filters, outside their group (the pickup queue sets its refresh there): the filters are a group of the
 * screen's own controls, and a control that filters nothing does not belong in it.
 */
describe('QueueFilters: what stands beside the filters', () => {
  it('draws it beside the group of filters and not in it', () => {
    render(
      <QueuePanel>
        <QueueFilters
          label="Filter the demo rows"
          aside={<button type="button">Aside action</button>}
        >
          <span>Demo filter</span>
        </QueueFilters>
      </QueuePanel>,
    );

    const group = screen.getByRole('group', { name: 'Filter the demo rows' });
    const aside = screen.getByRole('button', { name: 'Aside action' });

    expect(group).not.toContainElement(aside);
    expect(group).toContainElement(screen.getByText('Demo filter'));
    expect(group.parentElement).toBe(aside.closest('.ui-queue-bar'));
    expect(aside.closest('.ui-queue-panel')).not.toBeNull();
  });

  // Break caught: a wrapper drawn around the filters of every queue, so that the approvals and the message log would change with the pickup queue.
  it('draws the group as it always was when it is given nothing beside it', () => {
    const { container } = render(
      <QueueFilters label="Filter the demo rows">
        <span>Demo filter</span>
      </QueueFilters>,
    );

    const group = screen.getByRole('group', { name: 'Filter the demo rows' });

    expect(container.firstElementChild).toBe(group);
    expect(group).toHaveClass('ui-queue-filters');
    expect(document.querySelector('.ui-queue-bar')).toBeNull();
  });
});
