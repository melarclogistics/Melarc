import { useEffect, useRef, useState, type ReactNode } from 'react';

import { IconButton } from '../icon-button/IconButton';
import './reorder-list.css';

export interface ReorderItem {
  /** Tells the item from the others, and is what `onChange` gives back. Unique in a list. */
  readonly id: string;
  /** Names the item to assistive technology, in the buttons and in what is announced when it moves: "Stop 2, ACC-PR-7KQ2MZ". */
  readonly label: string;
  /** What is drawn for the item. */
  readonly content: ReactNode;
  /**
   * The item keeps its place: it has no buttons, the others are moved around it, and `fixedNote` says so beside it. What may not be moved is
   * the caller's to say; the list makes no judgement of an item.
   */
  readonly fixed?: boolean;
  /** Why a fixed item stays where it is, in words, drawn with it. */
  readonly fixedNote?: string;
}

export interface ReorderListProps {
  /** What the list is, in a few words. It names the list. */
  readonly label: string;
  /** The items in the order they are in now. The list holds no order of its own: the caller keeps it and passes it back changed. */
  readonly items: readonly ReorderItem[];
  /** The person moved an item. The complete order, every item once, as ids. */
  readonly onChange: (orderedIds: readonly string[]) => void;
  /** Nothing can be moved now, for example while the order is being sent. */
  readonly disabled?: boolean;
}

type Direction = 'up' | 'down';

/** The index of the nearest item that can move, going the way asked from `from`, or none. A fixed item is stepped over and stays where it is. */
function neighbour(items: readonly ReorderItem[], from: number, direction: Direction): number {
  const step = direction === 'up' ? -1 : 1;
  for (let index = from + step; index >= 0 && index < items.length; index += step) {
    if (items[index]?.fixed !== true) return index;
  }
  return -1;
}

/**
 * The stop-reordering control (S1.25; COMPONENT_PATTERNS section 22g): an ordered list whose items each carry a button to move it up and a button
 * to move it down, so the order can be changed from the keyboard and with a pointer alike. It is a controlled list: it keeps no order of its own
 * and gives the caller the complete order after every move (a sequence is sent whole, never as a change).
 *
 * - A move **exchanges the item with the nearest item that can move in that direction**, stepping over any item that is `fixed`, which keeps its
 *   place; so the others are ordered around it.
 * - The button at an end is disabled, and **focus follows the item**: after a move it stays on the button that was pressed, or on the other one
 *   when that end has been reached, so a keyboard user can press again without finding their place.
 * - Each move is announced in a polite status region: which item, its new place and how many there are. The position is also written in the
 *   item (a number before it), not only in the order of the list.
 * - Drag and drop is not offered: two buttons are the whole of the control, and nothing is lost for want of a pointer gesture.
 *
 * It decides nothing about what may be moved or whether an order is acceptable: the server does, and a refusal is the caller's to show.
 */
export function ReorderList({ label, items, onChange, disabled = false }: ReorderListProps) {
  const [announcement, setAnnouncement] = useState('');
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  // Where focus goes once the new order is drawn: the item that was moved, and the way it was moved.
  const [moved, setMoved] = useState<{ id: string; direction: Direction; count: number }>();

  useEffect(() => {
    if (moved === undefined) return;
    const index = items.findIndex((item) => item.id === moved.id);
    const wanted: Direction[] = moved.direction === 'up' ? ['up', 'down'] : ['down', 'up'];
    for (const direction of wanted) {
      if (neighbour(items, index, direction) === -1) continue;
      buttons.current.get(`${moved.id}:${direction}`)?.focus();
      return;
    }
    // Neither way is open (the list has no other item that can move): there is nowhere better than where focus is.
  }, [moved, items]);

  const duplicate = items.find(
    (item, index) => items.findIndex((other) => other.id === item.id) !== index,
  );
  if (duplicate !== undefined) {
    throw new Error(`Two items of the list "${label}" have the id "${duplicate.id}".`);
  }

  function move(index: number, direction: Direction): void {
    const target = neighbour(items, index, direction);
    const item = items[index];
    if (disabled || target === -1 || item === undefined) return;
    const next = items.map((entry) => entry.id);
    [next[index], next[target]] = [next[target] ?? '', next[index] ?? ''];
    onChange(next);
    setMoved((last) => ({ id: item.id, direction, count: (last?.count ?? 0) + 1 }));
    setAnnouncement(
      `${item.label} moved to place ${String(target + 1)} of ${String(items.length)}.`,
    );
  }

  return (
    <div className="ui-reorder">
      <ol className="ui-reorder__list" aria-label={label}>
        {items.map((item, index) => {
          const canMoveUp =
            !disabled && item.fixed !== true && neighbour(items, index, 'up') !== -1;
          const canMoveDown =
            !disabled && item.fixed !== true && neighbour(items, index, 'down') !== -1;
          return (
            <li
              key={item.id}
              className={
                item.fixed === true
                  ? 'ui-reorder__item ui-reorder__item--fixed'
                  : 'ui-reorder__item'
              }
            >
              <span className="ui-reorder__place" aria-hidden="true">
                {index + 1}
              </span>
              <div className="ui-reorder__content">
                {item.content}
                {item.fixed === true && item.fixedNote !== undefined ? (
                  <p className="ui-reorder__note">{item.fixedNote}</p>
                ) : null}
              </div>
              {item.fixed === true ? null : (
                <div className="ui-reorder__moves">
                  <IconButton
                    type="button"
                    icon="move-up"
                    label={`Move ${item.label} up`}
                    disabled={!canMoveUp}
                    ref={(node) => {
                      if (node === null) buttons.current.delete(`${item.id}:up`);
                      else buttons.current.set(`${item.id}:up`, node);
                    }}
                    onClick={() => {
                      move(index, 'up');
                    }}
                  />
                  <IconButton
                    type="button"
                    icon="move-down"
                    label={`Move ${item.label} down`}
                    disabled={!canMoveDown}
                    ref={(node) => {
                      if (node === null) buttons.current.delete(`${item.id}:down`);
                      else buttons.current.set(`${item.id}:down`, node);
                    }}
                    onClick={() => {
                      move(index, 'down');
                    }}
                  />
                </div>
              )}
            </li>
          );
        })}
      </ol>
      <p className="ui-reorder__status" role="status">
        {announcement}
      </p>
    </div>
  );
}
