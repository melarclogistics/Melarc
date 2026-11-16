import { useCallback, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

import { Icon } from '../icon/Icon';
import './photo-grid.css';
import { useNearViewport } from './use-near-viewport';

/**
 * What a tile says of its photo, in an icon **and** words, never in colour alone: `selected` is ticked (found, checked in), `marked` needs attention (missing, damaged), `dimmed` is set apart (not on the
 * table). The words are the page's.
 */
export type PhotoTileState =
  | { readonly kind: 'normal' }
  | { readonly kind: 'selected'; readonly label: string }
  | { readonly kind: 'marked'; readonly label: string }
  | { readonly kind: 'dimmed'; readonly label: string };

export interface PhotoGridItem {
  /** A stable key (the photo's own record, or the parcel's): the tile keeps its place when the list is replaced. Never drawn. */
  readonly key: string;
  /** What the photo is called on the screen ("Parcel 3"): the tile's name for assistive technology, with its state. Never an identifier or an address. */
  readonly label: string;
  readonly state?: PhotoTileState;
  /** A small text on the tile ("3"): the photo's place, or a count. */
  readonly badge?: string;
  /** The tile exists and cannot be pressed now. */
  readonly disabled?: boolean;
}

export interface PhotoGridProps {
  /** Names the list for assistive technology ("Photos of Kente Crafts"). */
  readonly label: string;
  readonly items: readonly PhotoGridItem[];
  /**
   * The picture of a tile, which is **the page's**: the grid knows no photo store and no address. `near` says whether the tile is near the screen, and the page draws no picture (and asks the platform for
   * no link) until it is. The tile is named by the grid, so the picture is decorative: it has no text alternative of its own.
   */
  readonly renderPicture: (item: PhotoGridItem, context: { readonly near: boolean }) => ReactNode;
  /** A tile was pressed (a click, Enter or Space). The grid decides nothing: the page opens the photo or ticks it. */
  readonly onSelect?: (item: PhotoGridItem, index: number) => void;
  /** The tiles are toggles (found or not found): each says whether it is on (`aria-pressed`), by its `selected` state. Left out, they are plain buttons. */
  readonly selectable?: boolean;
}

const MARK_ICON = { selected: 'success', marked: 'warning' } as const;

function nameOf(item: PhotoGridItem): string {
  const state = item.state;
  return state === undefined || state.kind === 'normal'
    ? item.label
    : `${item.label}, ${state.label}`;
}

function Tile({
  item,
  index,
  tabStop,
  selectable,
  renderPicture,
  onPress,
  onFocused,
  register,
}: {
  readonly item: PhotoGridItem;
  readonly index: number;
  readonly tabStop: boolean;
  readonly selectable: boolean;
  readonly renderPicture: PhotoGridProps['renderPicture'];
  readonly onPress: () => void;
  readonly onFocused: () => void;
  readonly register: (index: number, node: HTMLButtonElement | null) => void;
}) {
  const [watch, near] = useNearViewport<HTMLButtonElement>();
  // Stable, so that the observer of a tile is made once and not at every render of the grid.
  const attach = useCallback(
    (node: HTMLButtonElement | null) => {
      register(index, node);
      watch(node);
    },
    [register, index, watch],
  );
  const state = item.state ?? { kind: 'normal' };
  return (
    <li className="ui-photo-grid__cell">
      <button
        ref={attach}
        type="button"
        className={`ui-photo-tile ui-photo-tile--${state.kind}`}
        aria-label={nameOf(item)}
        aria-pressed={selectable ? state.kind === 'selected' : undefined}
        disabled={item.disabled === true}
        tabIndex={tabStop ? 0 : -1}
        data-photo-index={index}
        onClick={onPress}
        onFocus={onFocused}
      >
        <span className="ui-photo-tile__picture" aria-hidden="true">
          {renderPicture(item, { near })}
        </span>
        {state.kind === 'normal' ? null : (
          <span className="ui-photo-tile__mark" aria-hidden="true">
            {state.kind === 'dimmed' ? null : <Icon name={MARK_ICON[state.kind]} size="sm" />}
            {state.label}
          </span>
        )}
        {item.badge === undefined ? null : (
          <span className="ui-photo-tile__badge" aria-hidden="true">
            {item.badge}
          </span>
        )}
      </button>
    </li>
  );
}

/**
 * The photo grid (COMPONENT_PATTERNS, *PhotoGrid*): the photos of a vendor, a parcel or a finding as **tiles of a fixed size** (the box never jumps whatever the picture is), three to a row on a phone and as
 * many as fit on a desk, each **a button** at least the hub floor's 56 px on a side, in **one stop of the Tab key** with the arrow keys moving between the tiles (left and right by one, up and down by a row,
 * Home and End). **It is generic and decides nothing**: it draws the picture the page gives each tile that is near the screen, says a tile's state in an icon and words, and tells the page which tile was
 * pressed. The tile's picture is decorative, because the tile is named by the grid.
 */
export function PhotoGrid({
  label,
  items,
  renderPicture,
  onSelect,
  selectable = false,
}: PhotoGridProps) {
  const [active, setActive] = useState(0);
  const tiles = useRef<(HTMLButtonElement | null)[]>([]);
  const register = useCallback((index: number, node: HTMLButtonElement | null) => {
    tiles.current[index] = node;
  }, []);
  if (items.length === 0) return null;
  // The stop of the Tab key is a tile that exists: a list that got shorter leaves it on the last.
  const stop = Math.min(active, items.length - 1);

  function columns(): number {
    const first = tiles.current[0];
    if (first === null || first === undefined) return 1;
    let count = 0;
    for (const tile of tiles.current) {
      if (tile?.offsetTop !== first.offsetTop) break;
      count += 1;
    }
    return Math.max(count, 1);
  }

  function moveTo(index: number): void {
    const target = Math.max(0, Math.min(index, items.length - 1));
    setActive(target);
    tiles.current[target]?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLUListElement>): void {
    const tile = (event.target as HTMLElement).closest<HTMLElement>('[data-photo-index]');
    if (tile === null) return;
    const index = Number(tile.dataset.photoIndex);
    const row = columns();
    const next: Record<string, number | undefined> = {
      ArrowRight: index + 1,
      ArrowLeft: index - 1,
      ArrowDown: index + row < items.length ? index + row : index,
      ArrowUp: index - row >= 0 ? index - row : index,
      Home: 0,
      End: items.length - 1,
    };
    const to = next[event.key];
    if (to === undefined) return;
    event.preventDefault();
    moveTo(to);
  }

  return (
    <ul className="ui-photo-grid" aria-label={label} onKeyDown={onKeyDown}>
      {items.map((item, index) => (
        <Tile
          key={item.key}
          item={item}
          index={index}
          tabStop={index === stop}
          selectable={selectable}
          renderPicture={renderPicture}
          onPress={() => {
            setActive(index);
            onSelect?.(item, index);
          }}
          onFocused={() => {
            setActive(index);
          }}
          register={register}
        />
      ))}
    </ul>
  );
}
