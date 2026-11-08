import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type SubmitEvent } from 'react';
import { describe, expect, it } from 'vitest';

import type { ReadQuery } from '../read-state/ReadState';
import { Picker, type PickerOption, type PickerProps } from './Picker';

/** Synthetic things to find. Nothing here is product data. */
const DEMO: readonly PickerOption[] = [
  { value: 'a', label: 'Demo shop alpha', description: 'Demo account A1' },
  { value: 'b', label: 'Demo shop beta', description: 'Demo account B2' },
  { value: 'c', label: 'Demo stall gamma' },
];

const answered = (options: readonly PickerOption[]): ReadQuery<readonly PickerOption[]> => ({
  status: 'success',
  data: options,
  error: null,
  isFetching: false,
  refetch: () => Promise.resolve(),
});

/** A form around a picker, as a booking holds one: the picker's search answered from the list above, and what was sent, if anything. */
function DemoForm({
  extra = {},
  onSubmit,
}: {
  readonly extra?: Partial<PickerProps>;
  readonly onSubmit?: (value: string | undefined) => void;
}) {
  const [searched, setSearched] = useState<string>();
  const [value, setValue] = useState<PickerOption | null>(null);
  const results =
    searched === undefined
      ? undefined
      : answered(DEMO.filter((option) => option.label.toLowerCase().includes(searched)));
  return (
    <form
      noValidate
      onSubmit={(event: SubmitEvent<HTMLFormElement>) => {
        event.preventDefault();
        onSubmit?.(value?.value);
      }}
    >
      <Picker
        label="Demo shop"
        searchLabel="Search demo shops by name"
        searchAction="Search"
        onSearch={(text) => {
          setSearched(text.toLowerCase());
        }}
        results={results}
        noResults={<p>No demo shop matches. Try another name.</p>}
        value={value}
        onChange={setValue}
        chooseAction="Choose"
        changeAction="Choose another demo shop"
        {...extra}
      />
      <p>Held: {value?.value ?? 'nothing'}</p>
      <button type="submit">Send the demo form</button>
    </form>
  );
}

function renderPicker(props: Parameters<typeof DemoForm>[0] = {}) {
  const view = render(<DemoForm {...props} />);
  return { ...view, user: userEvent.setup() };
}

describe('Picker: searching', () => {
  it('is a group named by what it chooses, with a search field and a button', () => {
    renderPicker({ extra: { required: true } });

    const group = screen.getByRole('group', { name: 'Demo shop (required)' });
    expect(
      within(group).getByRole('searchbox', { name: /Search demo shops by name/ }),
    ).toBeVisible();
    expect(within(group).getByRole('button', { name: 'Search' })).toBeVisible();
    // Nothing is found before anything is asked, and nothing is chosen for the person.
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.getByText('Held: nothing')).toBeVisible();
  });

  // Break caught: Enter in the search field submitting the form around it, which would send a booking with nobody chosen.
  it('searches with Enter in the field, and does not send the form', async () => {
    let sent = 0;
    const { user } = renderPicker({
      onSubmit: () => {
        sent += 1;
      },
    });

    await user.type(screen.getByRole('searchbox', { name: /Search demo shops/ }), 'shop{Enter}');

    expect(await screen.findByText('2 found.')).toBeVisible();
    expect(sent).toBe(0);
  });

  it('searches with the button, and lists what was found with a button to choose each', async () => {
    const { user } = renderPicker();

    await user.type(screen.getByRole('searchbox', { name: /Search demo shops/ }), 'demo');
    await user.click(screen.getByRole('button', { name: 'Search' }));

    const list = await screen.findByRole('list', { name: '3 found.' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    expect(within(list).getByText('Demo account A1')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Choose: Demo shop beta' })).toBeVisible();
  });

  it('sends the search without the spaces around it', async () => {
    const asked: string[] = [];
    const { user } = renderPicker({
      extra: {
        onSearch: (text) => {
          asked.push(text);
        },
      },
    });

    await user.type(
      screen.getByRole('searchbox', { name: /Search demo shops/ }),
      '  alpha  {Enter}',
    );

    expect(asked).toEqual(['alpha']);
  });

  it('says so in the screen’s words when nothing is found', async () => {
    const { user } = renderPicker();

    await user.type(screen.getByRole('searchbox', { name: /Search demo shops/ }), 'nothing{Enter}');

    expect(await screen.findByRole('status')).toHaveTextContent(
      'No demo shop matches. Try another name.',
    );
  });

  // Break caught: a page of matches shown as if it were every match.
  it('says when more match than were returned', () => {
    render(
      <Picker
        label="Demo shop"
        searchLabel="Search demo shops"
        searchAction="Search"
        onSearch={() => undefined}
        results={answered(DEMO)}
        moreResults
        noResults="None."
        value={null}
        onChange={() => undefined}
        chooseAction="Choose"
        changeAction="Choose another"
      />,
    );

    expect(screen.getByText('3 found. More match: add to the search to narrow it.')).toBeVisible();
  });

  it('shows a read that is still on its way as loading, and a failed one with a retry', () => {
    const { rerender } = render(
      <Picker
        label="Demo shop"
        searchLabel="Search demo shops"
        searchAction="Search"
        onSearch={() => undefined}
        results={{
          status: 'pending',
          data: undefined,
          error: null,
          isFetching: true,
          refetch: () => Promise.resolve(),
        }}
        noResults="None."
        value={null}
        onChange={() => undefined}
        chooseAction="Choose"
        changeAction="Choose another"
      />,
    );
    expect(screen.getByText('Searching…')).toBeInTheDocument();

    rerender(
      <Picker
        label="Demo shop"
        searchLabel="Search demo shops"
        searchAction="Search"
        onSearch={() => undefined}
        results={{
          status: 'error',
          data: undefined,
          error: new TypeError('Failed to fetch'),
          isFetching: false,
          refetch: () => Promise.resolve(),
        }}
        noResults="None."
        value={null}
        onChange={() => undefined}
        chooseAction="Choose"
        changeAction="Choose another"
      />,
    );
    expect(screen.getByRole('alert')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
  });

  // Break caught: an error that is not on the field the person corrects, so the form's focus has nowhere to go.
  it('puts its error on the search field', () => {
    renderPicker({ extra: { error: 'Choose a demo shop.' } });

    const field = screen.getByRole('searchbox', { name: /Search demo shops/ });
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveAccessibleDescription('Choose a demo shop.');
  });
});

describe('Picker: choosing, by keyboard', () => {
  it('chooses with a button, shows the choice, and puts focus on it', async () => {
    const { user } = renderPicker();
    await user.type(screen.getByRole('searchbox', { name: /Search demo shops/ }), 'beta{Enter}');
    await screen.findByText('1 found.');

    await user.tab();
    expect(screen.getByRole('button', { name: 'Search' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Choose: Demo shop beta' })).toHaveFocus();
    await user.keyboard('{Enter}');

    expect(screen.getByText('Held: b')).toBeVisible();
    expect(screen.queryByRole('searchbox')).toBeNull();
    const chosen = screen.getByText('Demo shop beta').closest('.ui-picker__chosen');
    await waitFor(() => {
      expect(chosen).toHaveFocus();
    });
  });

  it('sets a choice aside to search again, and puts focus back on the field', async () => {
    const { user } = renderPicker();
    await user.type(screen.getByRole('searchbox', { name: /Search demo shops/ }), 'alpha{Enter}');
    await user.click(await screen.findByRole('button', { name: 'Choose: Demo shop alpha' }));

    await user.click(screen.getByRole('button', { name: 'Choose another demo shop' }));

    expect(screen.getByText('Held: nothing')).toBeVisible();
    await waitFor(() => {
      expect(screen.getByRole('searchbox', { name: /Search demo shops/ })).toHaveFocus();
    });
  });

  it('moves focus each time a choice is made, not only the first', async () => {
    const { user } = renderPicker();
    await user.type(screen.getByRole('searchbox', { name: /Search demo shops/ }), 'alpha{Enter}');
    await user.click(await screen.findByRole('button', { name: 'Choose: Demo shop alpha' }));
    await user.click(screen.getByRole('button', { name: 'Choose another demo shop' }));
    // The last search is kept, to be changed: the person may only want to narrow it.
    const field = screen.getByRole('searchbox', { name: /Search demo shops/ });
    expect(field).toHaveValue('alpha');
    await user.clear(field);
    await user.type(field, 'gamma{Enter}');

    await user.click(await screen.findByRole('button', { name: 'Choose: Demo stall gamma' }));

    const chosen = screen.getByText('Demo stall gamma').closest('.ui-picker__chosen');
    await waitFor(() => {
      expect(chosen).toHaveFocus();
    });
  });

  it('takes everything out of use while it is disabled', async () => {
    const asked: string[] = [];
    const { user } = renderPicker({
      extra: {
        disabled: true,
        onSearch: (text) => {
          asked.push(text);
        },
      },
    });

    expect(screen.getByRole('searchbox', { name: /Search demo shops/ })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(asked).toEqual([]);
  });
});
