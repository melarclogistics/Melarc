import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { wcagViolations } from '../../../test-support/wcag';
import {
  CommandPalette,
  type PaletteLink,
  type PaletteRecord,
  type PaletteRecords,
} from './CommandPalette';

const GO_TO: PaletteLink[] = [
  { to: '/', label: 'My work', icon: 'my-work' },
  { to: '/admin/staff', label: 'Staff', icon: 'staff' },
];
const CREATE: PaletteLink[] = [
  { to: '/pickup-requests/new', label: 'Book a pickup', icon: 'book-pickup' },
];
const RECORD: PaletteRecord = {
  id: 'PICKUP_REQUEST:1',
  to: '/pickup-requests/1',
  title: 'PR-000123',
  isCode: true,
  subtitle: 'Ama Mensah · Waiting for confirmation · Accra Hub · Mon 2 Nov 2026',
  icon: 'pickup-requests',
};

function renderPalette(
  props: {
    records?: PaletteRecords;
    goTo?: readonly PaletteLink[];
    create?: readonly PaletteLink[];
    onSelect?: (to: string) => void;
    onOpenChange?: (open: boolean) => void;
  } = {},
) {
  const onSelect = props.onSelect ?? vi.fn();
  const onOpenChange = props.onOpenChange ?? vi.fn();
  function Harness() {
    const [query, setQuery] = useState('');
    return (
      <CommandPalette
        open
        onOpenChange={onOpenChange}
        query={query}
        onQueryChange={setQuery}
        goTo={props.goTo ?? GO_TO}
        create={props.create ?? CREATE}
        records={props.records ?? { state: 'hint' }}
        onSelect={onSelect}
        onCloseAutoFocus={() => undefined}
      />
    );
  }
  const view = render(<Harness />);
  return { ...view, onSelect, onOpenChange, user: userEvent.setup() };
}

const dialog = () => screen.getByRole('dialog', { name: 'Search' });

describe('the command palette: what it holds', () => {
  // Break caught: a dialog with no name (a screen reader would say "dialog" and nothing else), or a field that does not say what to type.
  it('is a dialog named Search with a field that says what to type', () => {
    renderPalette();

    const field = within(dialog()).getByRole('combobox');
    expect(field).toHaveAttribute('placeholder', 'Search a code, name or phone');
    expect(field).toHaveFocus();
  });

  // Break caught: a group missing, or the groups out of the order of the decision (Go to, Create, Records).
  it('has the groups Go to, Create and Records, in that order', () => {
    renderPalette({ records: { state: 'results', items: [RECORD] } });

    const list = within(dialog()).getByRole('listbox');
    expect(
      [...list.querySelectorAll('[cmdk-group-heading]')].map((heading) => heading.textContent),
    ).toEqual(['Go to', 'Create', 'Records']);
    expect(
      within(list)
        .getAllByRole('option')
        .map((option) => option.textContent.slice(0, 12)),
    ).toEqual(['My work', 'Staff', 'Book a picku', 'PR-000123Ama']);
  });

  // Break caught: the palette hiding a record that the server found because it does not contain what was typed (a phone number's masked hint does
  // not contain the number): the records are the server's answer and are never filtered again here.
  it('does not filter the records it is given by what is typed', async () => {
    const { user } = renderPalette({ records: { state: 'results', items: [RECORD] } });

    await user.type(within(dialog()).getByRole('combobox'), '0244000111');

    expect(within(dialog()).getByRole('option', { name: /PR-000123/ })).toBeInTheDocument();
  });

  // Break caught: the title of a record drawn without the line the portal wrote under it, or the code drawn in the interface face.
  it('draws a record as its title over its line, the code in the face of codes', () => {
    renderPalette({ records: { state: 'results', items: [RECORD] } });

    const option = within(dialog()).getByRole('option', { name: /PR-000123/ });
    expect(option).toHaveTextContent(
      'PR-000123Ama Mensah · Waiting for confirmation · Accra Hub · Mon 2 Nov 2026',
    );
    expect(option.querySelector('.ui-palette__title')).toHaveClass('ui-palette__code');
  });

  it('does not draw a name in the face of codes', () => {
    renderPalette({
      records: { state: 'results', items: [{ ...RECORD, title: 'Ama Mensah', isCode: false }] },
    });

    expect(screen.getByText('Ama Mensah').closest('.ui-palette__title')).not.toHaveClass(
      'ui-palette__code',
    );
  });

  // Break caught: an empty group drawn with its heading, or a separator before nothing.
  it('draws no group that has nothing in it', () => {
    renderPalette({ goTo: [], create: [], records: { state: 'results', items: [RECORD] } });

    const list = within(dialog()).getByRole('listbox');
    expect(
      [...list.querySelectorAll('[cmdk-group-heading]')].map((heading) => heading.textContent),
    ).toEqual(['Records']);
  });
});

describe('the command palette: the search of records, in each state', () => {
  // Break caught: a state told in a word the person does not know, or none at all (a blank under the list).
  it.each([
    ['hint', { state: 'hint' }, 'Type two letters or more to search records.'],
    ['loading', { state: 'loading' }, 'Searching…'],
    ['empty', { state: 'empty', text: 'zzz' }, 'No record matches “zzz”.'],
    // Review of 7 November 2026: a text longer than the search takes was told as the hint ("Type two letters or more"), which is not what is wrong.
    ['too-long', { state: 'too-long', limit: 64 }, 'Use 64 characters or fewer to search records.'],
    [
      'slow',
      { state: 'slow', message: "You're going a little fast. Try again in a few seconds." },
      "You're going a little fast. Try again in a few seconds.",
    ],
  ] as const)('tells the %s state in plain words', (_state, records, words) => {
    renderPalette({ records });

    expect(within(dialog()).getByRole('status')).toHaveTextContent(words);
    expect(within(dialog()).getByRole('status')).toHaveTextContent('Records');
  });

  // Break caught (audit A2, 7 November 2026): the rate limit told as an error alert: it is a calm note in the status line, the alert container stays empty,
  // and asking again by hand (*Try again*) is offered only when the caller can ask.
  it('tells the rate limit in the status line and not in the alert, with Try again only when it can be asked', async () => {
    const onRetry = vi.fn();
    const words = "You're going a little fast. Try again in a few seconds.";
    const { user } = renderPalette({ records: { state: 'slow', message: words, onRetry } });

    expect(within(dialog()).getByRole('status')).toHaveTextContent(words);
    expect(within(dialog()).getByRole('alert')).toBeEmptyDOMElement();
    await user.click(within(dialog()).getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('offers no Try again for the rate limit while a search is only waiting', () => {
    renderPalette({ records: { state: 'slow', message: 'Wait a little.' } });

    expect(within(dialog()).getByRole('status')).toHaveTextContent('Wait a little.');
    expect(within(dialog()).queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  // Break caught (review of 7 November 2026): a live region that is unmounted when the results arrive and flips between status and alert, so that a
  // screen reader says nothing of the result of a search (WCAG 4.1.3): the region is in the document through every state, is the same element, says
  // how many records were found in words, and leaves a failure to the alert, which speaks for itself. Break caught (audit B3, 7 November 2026): the
  // alert inserted with its text when the search fails (few screen readers speak a region that arrives with its content), where it is a container of
  // its own that is in the document through every state, empty until there is a failure, and the same element when there is one.
  it('keeps one polite live region and one alert container through every state, and says how many records were found', () => {
    const onRetry = vi.fn();
    const palette = (records: PaletteRecords) => (
      <CommandPalette
        open
        onOpenChange={() => undefined}
        query=""
        onQueryChange={() => undefined}
        goTo={GO_TO}
        create={CREATE}
        records={records}
        onSelect={() => undefined}
        onCloseAutoFocus={() => undefined}
      />
    );
    const view = render(palette({ state: 'loading' }));
    const region = within(dialog()).getByRole('status');
    expect(region).toHaveTextContent('Searching…');
    const alert = within(dialog()).getByRole('alert');
    expect(alert).toBeEmptyDOMElement();

    view.rerender(palette({ state: 'results', items: [RECORD] }));
    expect(within(dialog()).getByRole('status')).toBe(region);
    expect(region).toHaveTextContent('1 record found.');

    view.rerender(
      palette({ state: 'results', items: [RECORD, { ...RECORD, id: 'PICKUP_REQUEST:2' }] }),
    );
    expect(within(dialog()).getByRole('status')).toBe(region);
    expect(region).toHaveTextContent('2 records found.');

    view.rerender(
      palette({ state: 'error', message: 'The search could not be completed.', onRetry }),
    );
    expect(within(dialog()).getByRole('status')).toBe(region);
    expect(region).toBeEmptyDOMElement();
    expect(within(dialog()).getByRole('alert')).toBe(alert);
    expect(alert).toHaveTextContent('The search could not be completed.');
    expect(region).not.toContainElement(alert);

    view.rerender(palette({ state: 'empty', text: 'zzz' }));
    expect(within(dialog()).getByRole('alert')).toBe(alert);
    expect(alert).toBeEmptyDOMElement();
  });

  // Break caught: a failed search told with the server's text, or with no way to ask again; the palette never asks again by itself.
  it('tells a failed search in plain words and offers Try again, which asks again', async () => {
    const onRetry = vi.fn();
    const { user } = renderPalette({
      records: { state: 'error', message: 'The search could not be completed.', onRetry },
    });

    expect(within(dialog()).getByRole('alert')).toHaveTextContent(
      'The search could not be completed.',
    );
    expect(onRetry).not.toHaveBeenCalled();
    await user.click(within(dialog()).getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  // Break caught: a status drawn inside the listbox, which may hold options and nothing else (axe: aria-required-children).
  it('draws the status under the list and not in it', () => {
    renderPalette({ records: { state: 'loading' } });

    const list = within(dialog()).getByRole('listbox');
    expect(list).not.toContainElement(within(dialog()).getByRole('status'));
  });
});

describe('the command palette: the keyboard', () => {
  // Break caught: Enter that does not open the option under it, or arrows that do not move: the palette must be operable without a pointer.
  it('moves with the arrows and opens the chosen option with Enter', async () => {
    const { user, onSelect } = renderPalette();

    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith('/pickup-requests/new');
  });

  it('opens the first option with Enter when none was moved to', async () => {
    const { user, onSelect } = renderPalette();

    await user.keyboard('{Enter}');

    expect(onSelect).toHaveBeenCalledWith('/');
  });

  it('opens a record with Enter', async () => {
    const { user, onSelect } = renderPalette({
      goTo: [],
      create: [],
      records: { state: 'results', items: [RECORD] },
    });

    await user.keyboard('{Enter}');

    expect(onSelect).toHaveBeenCalledWith('/pickup-requests/1');
  });

  it('opens an option that is clicked', async () => {
    const { user, onSelect } = renderPalette();

    await user.click(within(dialog()).getByRole('option', { name: 'Staff' }));

    expect(onSelect).toHaveBeenCalledWith('/admin/staff');
  });

  // Break caught: Escape that leaves the palette open, or closes the page behind it.
  it('closes with Escape', async () => {
    const { user, onOpenChange } = renderPalette();

    await user.keyboard('{Escape}');

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('has no WCAG violations that can be checked without a layout engine, in each state', async () => {
    const hint = renderPalette();
    expect(await wcagViolations(document.body)).toEqual([]);
    hint.unmount();

    const results = renderPalette({ records: { state: 'results', items: [RECORD] } });
    expect(await wcagViolations(document.body)).toEqual([]);
    results.unmount();

    const error = renderPalette({
      records: {
        state: 'error',
        message: 'The search could not be completed.',
        onRetry: () => undefined,
      },
    });
    expect(await wcagViolations(document.body)).toEqual([]);
    error.unmount();

    renderPalette({ records: { state: 'loading' } });
    expect(await wcagViolations(document.body)).toEqual([]);
  });
});
