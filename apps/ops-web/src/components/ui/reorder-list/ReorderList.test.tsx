import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { ReorderList, type ReorderItem } from './ReorderList';

/**
 * The stop-reordering control: two buttons to a movable item, a complete order given back after every move, fixed items stepped over, focus
 * that follows the moved item and an announcement of each move. Driven by the keyboard, because that is the way it has to work first.
 */
const ITEMS: readonly ReorderItem[] = [
  { id: 'a', label: 'Stop 1, Demo A', content: <p>Demo A</p> },
  { id: 'b', label: 'Stop 2, Demo B', content: <p>Demo B</p> },
  { id: 'c', label: 'Stop 3, Demo C', content: <p>Demo C</p> },
];

const SOLO: ReorderItem = { id: 'a', label: 'Stop 1, Demo A', content: <p>Demo A</p> };

/** A list that keeps its order, as a screen does, and reports every order it is given. */
function Harness({
  items = ITEMS,
  onChange,
  disabled,
}: {
  readonly items?: readonly ReorderItem[];
  readonly onChange?: (ids: readonly string[]) => void;
  readonly disabled?: boolean;
}) {
  const [order, setOrder] = useState(items.map((item) => item.id));
  const shown = order.flatMap((id) => items.filter((item) => item.id === id));
  return (
    <ReorderList
      label="Demo stops"
      items={shown}
      {...(disabled === undefined ? {} : { disabled })}
      onChange={(ids) => {
        setOrder([...ids]);
        onChange?.(ids);
      }}
    />
  );
}

const names = () =>
  within(screen.getByRole('list', { name: 'Demo stops' }))
    .getAllByRole('listitem')
    .map((item) => item.querySelector('.ui-reorder__content')?.textContent ?? '');

describe('ReorderList: what it is', () => {
  it('is an ordered list named by its label, each item with its place and its two buttons', () => {
    render(<Harness />);

    const list = screen.getByRole('list', { name: 'Demo stops' });
    expect(list.tagName).toBe('OL');
    expect(names()).toEqual(['Demo A', 'Demo B', 'Demo C']);
    expect(screen.getByRole('button', { name: 'Move Stop 2, Demo B up' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Move Stop 2, Demo B down' })).toBeEnabled();
  });

  // Break caught: a button that moves an item beyond the list's end, which would drop it or wrap it.
  it('has no way up for the first item and no way down for the last', () => {
    render(<Harness />);

    expect(screen.getByRole('button', { name: 'Move Stop 1, Demo A up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move Stop 3, Demo C down' })).toBeDisabled();
  });

  // Break caught: two items with one id, which would move one of them twice and the other never.
  it('is a defect of the page, and throws, when two items share an id', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() =>
      render(<ReorderList label="Demo stops" items={[SOLO, SOLO]} onChange={() => undefined} />),
    ).toThrow(/Two items of the list "Demo stops" have the id "a"/);
    vi.restoreAllMocks();
  });
});

describe('ReorderList: moving by the keyboard', () => {
  // Break caught: a control that works with a pointer alone.
  it('moves an item down with Enter on its button, and gives the complete order', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} />);

    screen.getByRole('button', { name: 'Move Stop 1, Demo A down' }).focus();
    await user.keyboard('{Enter}');

    expect(names()).toEqual(['Demo B', 'Demo A', 'Demo C']);
    expect(onChange).toHaveBeenCalledWith(['b', 'a', 'c']);
  });

  it('moves an item up with Space on its button', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} />);

    screen.getByRole('button', { name: 'Move Stop 3, Demo C up' }).focus();
    await user.keyboard(' ');

    expect(onChange).toHaveBeenCalledWith(['a', 'c', 'b']);
  });

  // Break caught: focus lost to the page when the item moves, so a keyboard user must find the item again to move it once more.
  it('keeps focus on the button that was pressed, so that the same item can be moved again', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    screen.getByRole('button', { name: 'Move Stop 1, Demo A down' }).focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: 'Move Stop 1, Demo A down' })).toHaveFocus();
    await user.keyboard('{Enter}');

    expect(names()).toEqual(['Demo B', 'Demo C', 'Demo A']);
  });

  // Break caught: focus lost when the item reaches the end and the button that was pressed is disabled.
  it('moves focus to the item’s other button when it reaches the end', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    screen.getByRole('button', { name: 'Move Stop 2, Demo B down' }).focus();
    await user.keyboard('{Enter}');

    expect(names()).toEqual(['Demo A', 'Demo C', 'Demo B']);
    expect(screen.getByRole('button', { name: 'Move Stop 2, Demo B down' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move Stop 2, Demo B up' })).toHaveFocus();
  });

  it('reaches every button in the order of the list with Tab, and nothing else', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.tab();
    expect(screen.getByRole('button', { name: 'Move Stop 1, Demo A down' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Move Stop 2, Demo B up' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Move Stop 2, Demo B down' })).toHaveFocus();
  });

  // Break caught: a move that no one is told of, so a screen reader user cannot know whether it worked or where the item went.
  it('announces the move: which item, its new place and how many there are', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole('button', { name: 'Move Stop 1, Demo A down' }));

    expect(screen.getByRole('status')).toHaveTextContent('Stop 1, Demo A moved to place 2 of 3.');
  });

  it('moves nothing while disabled', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} disabled />);

    expect(screen.getByRole('button', { name: 'Move Stop 2, Demo B up' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Move Stop 2, Demo B up' }));

    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('ReorderList: items that keep their place', () => {
  const WITH_FIXED: readonly ReorderItem[] = [
    { id: 'a', label: 'Stop 1, Demo A', content: <p>Demo A</p> },
    {
      id: 'b',
      label: 'Stop 2, Demo B',
      content: <p>Demo B</p>,
      fixed: true,
      fixedNote: 'Skipped: it keeps its place.',
    },
    { id: 'c', label: 'Stop 3, Demo C', content: <p>Demo C</p> },
    { id: 'd', label: 'Stop 4, Demo D', content: <p>Demo D</p> },
  ];

  // Break caught: an item moved onto a fixed one's place, which the server would refuse as a stop moved that may not be.
  it('steps over a fixed item and leaves it where it is', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness items={WITH_FIXED} onChange={onChange} />);

    await user.click(screen.getByRole('button', { name: 'Move Stop 1, Demo A down' }));

    expect(onChange).toHaveBeenCalledWith(['c', 'b', 'a', 'd']);
    expect(names()).toEqual(['Demo C', 'Demo BSkipped: it keeps its place.', 'Demo A', 'Demo D']);
  });

  it('gives a fixed item no buttons and says why it stays', () => {
    render(<Harness items={WITH_FIXED} />);

    expect(screen.queryByRole('button', { name: /Move Stop 2, Demo B/ })).toBeNull();
    expect(screen.getByText('Skipped: it keeps its place.')).toBeVisible();
  });

  it('has no way up for the first item that can move even when a fixed one follows it', () => {
    render(<Harness items={WITH_FIXED} />);

    expect(screen.getByRole('button', { name: 'Move Stop 1, Demo A up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move Stop 1, Demo A down' })).toBeEnabled();
  });
});
