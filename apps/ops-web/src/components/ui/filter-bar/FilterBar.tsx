import { useRef, useState, type CSSProperties, type ReactNode, type SubmitEvent } from 'react';

import { Button } from '../../primitives/button';
import { Input } from '../../primitives/input';
import { Icon } from '../icon/Icon';
import { IconButton } from '../icon-button/IconButton';
import { Popover } from '../popover/Popover';
import './filter-bar.css';

/** One filter that is applied: the words of the choice, as they would be said ("Service date: this week"). */
export interface FilterChip {
  /** Tells the chip from the others; what `onRemove` gives back. Unique in a bar. */
  readonly id: string;
  readonly label: string;
}

/**
 * The search of a queue: a field that is **always in the bar**, not behind the Filter button (the Product Owner, 10 November 2026), with the search that is applied now. The page holds the
 * search (usually in the address); the field only says what was typed.
 */
export interface FilterSearch {
  /** What the field searches, which is also its name: "Search by name or email". */
  readonly label: string;
  /** The search that is applied now. The field shows it, and shows what is typed over it until the address says another search (Back, a link). */
  readonly value: string;
  /** Applies what was typed (Enter, or the Search button): the text without the spaces at its ends. Empty takes the search off. */
  readonly onSearch: (text: string) => void;
  /** The longest text the server accepts. */
  readonly maxLength?: number;
}

export interface FilterBarProps {
  /** Names the group of filters: "Filters". */
  readonly label: string;
  /** The queue's search field, drawn first in the bar and always visible. Without it the queue has no search. */
  readonly search?: FilterSearch;
  /** The filters that are applied now, one chip each. The page holds them (usually in the address): the bar only asks for one to be removed. */
  readonly chips: readonly FilterChip[];
  readonly onRemove: (id: string) => void;
  /** Takes every filter off at once. Offered only while two or more are applied. */
  readonly onClearAll?: () => void;
  /**
   * The page's own fields (a Select, a DateField), drawn in the popover that the "Filter" button opens. Without it there is no button: a queue with
   * nothing to choose from has no filter to add.
   */
  readonly filterPanel?: ReactNode;
  /** What the button and its popover are called. Default "Filter". */
  readonly filterLabel?: string;
  /**
   * The page opens and closes the popover (task R5.2, M12): give both, and the bar draws it open exactly when `filterOpen` is true and asks `onFilterOpenChange` for every
   * change the person makes (the button, Escape, a click outside). A page that applies a filter closes it so. Leave both out and the popover opens and closes itself.
   */
  readonly filterOpen?: boolean;
  readonly onFilterOpenChange?: (open: boolean) => void;
  /** How the rows are ordered, in words ("Sorted by oldest first"), at the end of the bar. The bar sorts nothing: the screen does, and says so here. */
  readonly sortLabel?: string;
}

/** The search field of the bar: what is typed is kept with the search it was typed over, and is the applied search again as soon as that is not the one in the address. */
function SearchField({ search }: { readonly search: FilterSearch }) {
  const [typing, setTyping] = useState({ over: search.value, text: search.value });
  const draft = typing.over === search.value ? typing.text : search.value;
  function submit(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault();
    search.onSearch(draft.trim());
  }
  return (
    <form
      role="search"
      aria-label={search.label}
      noValidate
      className="ui-filter-bar__search"
      style={{ '--ui-filter-search-chars': search.label.length } as CSSProperties}
      onSubmit={submit}
    >
      <Input
        type="search"
        name="q"
        className="ui-filter-bar__search-field"
        aria-label={search.label}
        placeholder={search.label}
        value={draft}
        {...(search.maxLength === undefined ? {} : { maxLength: search.maxLength })}
        autoComplete="off"
        onChange={(event) => {
          setTyping({ over: search.value, text: event.target.value });
        }}
      />
      <Button type="submit" variant="secondary" size="sm">
        Search
      </Button>
    </form>
  );
}

/**
 * The filters of a queue (PRODUCT_DESIGN_DIRECTION section 6.1; COMPONENT_PATTERNS, *FilterBar*): what is applied is visible as a chip that can be removed
 * on its own, a dashed "+ Filter" button opens a popover with the page's fields, and the order the rows are in is told at the end. It filters nothing
 * itself and holds no filter: the screen does, and the server answers. Removing a chip moves focus to the next chip's remove button (or the
 * previous one, or the Filter button), so a keyboard user is never left on a control that is gone.
 */
export function FilterBar({
  label,
  search,
  chips,
  onRemove,
  onClearAll,
  filterPanel,
  filterLabel = 'Filter',
  filterOpen,
  onFilterOpenChange,
  sortLabel,
}: FilterBarProps) {
  const root = useRef<HTMLDivElement>(null);
  const removers = useRef(new Map<string, HTMLButtonElement>());
  const adder = useRef<HTMLButtonElement>(null);

  const duplicate = chips.find(
    (chip, index) => chips.findIndex((other) => other.id === chip.id) !== index,
  );
  if (duplicate !== undefined) {
    throw new Error(`Two filters of "${label}" have the id "${duplicate.id}".`);
  }

  function remove(index: number): void {
    const chip = chips[index];
    if (chip === undefined) return;
    // Focus goes to what stays: the next chip's remove button, else the previous one, else the Filter button, else the bar itself.
    const next = chips[index + 1] ?? chips[index - 1];
    const target =
      (next === undefined ? undefined : removers.current.get(next.id)) ??
      adder.current ??
      root.current;
    target?.focus();
    onRemove(chip.id);
  }

  return (
    <div ref={root} role="group" aria-label={label} tabIndex={-1} className="ui-filter-bar">
      {search === undefined ? null : <SearchField search={search} />}
      {chips.length === 0 ? null : (
        // `role="list"` outright: Safari drops the list from one whose markers a style removes.
        <ul className="ui-filter-bar__chips" role="list" aria-label="Applied filters">
          {chips.map((chip, index) => (
            <li key={chip.id} className="ui-filter-bar__chip">
              <span className="ui-filter-bar__chip-label">{chip.label}</span>
              <IconButton
                type="button"
                icon="close"
                size="sm"
                label={`Remove filter: ${chip.label}`}
                ref={(node) => {
                  if (node === null) removers.current.delete(chip.id);
                  else removers.current.set(chip.id, node);
                }}
                onClick={() => {
                  remove(index);
                }}
              />
            </li>
          ))}
        </ul>
      )}
      {filterPanel === undefined ? null : (
        <Popover
          label={filterLabel}
          align="start"
          className="ui-filter-bar__panel"
          {...(filterOpen === undefined ? {} : { open: filterOpen })}
          {...(onFilterOpenChange === undefined ? {} : { onOpenChange: onFilterOpenChange })}
          trigger={
            <Button
              ref={adder}
              type="button"
              variant="outline"
              size="sm"
              className="ui-filter-bar__add"
            >
              <Icon name="plus" size="sm" />
              {filterLabel}
            </Button>
          }
        >
          {filterPanel}
        </Popover>
      )}
      {onClearAll !== undefined && chips.length >= 2 ? (
        <Button
          type="button"
          variant="link"
          size="sm"
          className="ui-filter-bar__clear"
          onClick={() => {
            onClearAll();
            // Every chip is gone: focus goes to the Filter button, which stays.
            (adder.current ?? root.current)?.focus();
          }}
        >
          Clear all
        </Button>
      ) : null}
      {sortLabel === undefined ? null : <p className="ui-filter-bar__sort">{sortLabel}</p>}
    </div>
  );
}
