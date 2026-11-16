import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';

import { Button } from '../button/Button';
import { Dialog } from '../dialog/Dialog';
import { Icon } from '../icon/Icon';
import { VisuallyHidden } from '../visually-hidden/VisuallyHidden';
import './photo-viewer.css';

/** How far a finger must travel across the photo to turn it, in pixels: a tap with a little slip, or a finger at rest, is not a turn. */
export const SWIPE_MIN_DISTANCE = 48;
/** How much further across than down a drag must go to be a turn and not a scroll or a diagonal slip: across at least this many times the way down. */
export const SWIPE_DOMINANCE = 1.5;

export interface PhotoViewerItem {
  /** A stable key (the photo's own record): each photo is drawn as a picture of its own. Never drawn. */
  readonly key: string;
  /** What the photo is called on the screen ("Parcel photo 3"): the dialog's name and heading. Never an identifier or an address. */
  readonly label: string;
  /** A line under the name, where the page knows one ("Taken 12 November 2026, 10:42"). */
  readonly detail?: string;
}

export interface PhotoViewerProps {
  readonly items: readonly PhotoViewerItem[];
  /** The photo looked at now: the page's, so that the grid that opened the viewer can say which photo was seen last. */
  readonly index: number;
  /** The person moved to another photo (a button, an arrow key, a swipe). The page sets `index`; it is never called for a photo that is not there. */
  readonly onIndexChange: (index: number) => void;
  /** Escape, or the button: the page closes the viewer. */
  readonly onClose: () => void;
  /**
   * The picture of a photo, which is **the page's**: the viewer knows no photo store and no address. `current` is the photo looked at; the other call is the one neighbour loaded ahead, drawn hidden, so that
   * the next photo is there when it is asked for.
   */
  readonly renderPicture: (
    item: PhotoViewerItem,
    context: { readonly current: boolean },
  ) => ReactNode;
  /** A line about the photos together, said under the detail of each: the page's words ("The photos are read only while this window is open."). */
  readonly note?: string;
}

type Way = 'next' | 'previous';

/**
 * The photo viewer (COMPONENT_PATTERNS, *PhotoViewer*): one photo at a time in a wide dialog, among the others of its grid. **It is generic and decides nothing**: it draws the picture the page gives it, says where
 * the person is ("3 of 12") in a polite status, moves by two buttons the size of the hub floor, by ArrowLeft and ArrowRight and by a swipe of a finger or a pen (a drag across by at least 48px that is clearly
 * more across than down, so that a vertical scroll is left alone), and never goes past either end. It loads **one** neighbour ahead, in the way the person is going, drawn hidden. **Focus, the trap and the
 * return of focus are the dialog's** (a native modal, the control that opened it gets focus back), and Escape asks the page to close. A button that reaches its end and is disabled hands focus to the other, so that
 * a person at the keyboard is never dropped out of the dialog. Under reduced motion the change of photo does not animate.
 */
export function PhotoViewer({
  items,
  index,
  onIndexChange,
  onClose,
  renderPicture,
  note,
}: PhotoViewerProps) {
  const [way, setWay] = useState<Way>('next');
  const root = useRef<HTMLDivElement>(null);
  const pressed = useRef<Way | null>(null);
  const touch = useRef<{ readonly id: number; readonly x: number; readonly y: number } | null>(
    null,
  );
  const last = items.length - 1;

  const go = useCallback(
    (to: Way) => {
      const target = to === 'next' ? index + 1 : index - 1;
      if (target < 0 || target > last) return;
      setWay(to);
      onIndexChange(target);
    },
    [index, last, onIndexChange],
  );

  // A button that was pressed and has reached its end is disabled, and a disabled button takes no focus: the other one has it, so that a person at the keyboard keeps their place in the dialog.
  useLayoutEffect(() => {
    const was = pressed.current;
    pressed.current = null;
    const handTo =
      was === 'previous' && index === 0
        ? 'next'
        : was === 'next' && index === last
          ? 'previous'
          : undefined;
    if (handTo !== undefined) {
      root.current?.querySelector<HTMLElement>(`[data-viewer-act="${handTo}"]`)?.focus();
    }
  }, [index, last]);

  const item = items[index];
  if (item === undefined) return null;
  const ahead =
    items[way === 'next' ? index + 1 : index - 1] ?? items[way === 'next' ? index - 1 : index + 1];

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      go('next');
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      go('previous');
    }
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>): void {
    // A finger or a pen, the first of them: a mouse has buttons and keys, and a second finger is a pinch.
    if (event.pointerType === 'mouse' || !event.isPrimary) return;
    touch.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
  }

  function onPointerUp(event: PointerEvent<HTMLDivElement>): void {
    const began = touch.current;
    if (began?.id !== event.pointerId) return;
    touch.current = null;
    const across = event.clientX - began.x;
    const down = event.clientY - began.y;
    if (Math.abs(across) < SWIPE_MIN_DISTANCE) return;
    if (Math.abs(across) < Math.abs(down) * SWIPE_DOMINANCE) return;
    go(across < 0 ? 'next' : 'previous');
  }

  const description =
    item.detail === undefined && note === undefined ? undefined : (
      <>
        {item.detail === undefined ? null : <p>{item.detail}</p>}
        {note === undefined ? null : <p>{note}</p>}
      </>
    );

  return (
    <Dialog open size="wide" title={item.label} description={description} onRequestClose={onClose}>
      {/* The arrow keys are heard anywhere in the dialog: the keyboard events of a control inside it reach this box. */}
      <div className="ui-photo-viewer" ref={root} onKeyDown={onKeyDown}>
        <div
          className="ui-photo-viewer__stage"
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
          onPointerCancel={() => {
            touch.current = null;
          }}
        >
          <div key={item.key} className="ui-photo-viewer__photo" data-way={way}>
            {renderPicture(item, { current: true })}
          </div>
        </div>
        {ahead === undefined ? null : (
          <div key={ahead.key} className="ui-photo-viewer__ahead" hidden>
            {renderPicture(ahead, { current: false })}
          </div>
        )}
        {items.length > 1 ? (
          <p className="ui-photo-viewer__position" role="status" aria-live="polite">
            <VisuallyHidden>{`${item.label}, `}</VisuallyHidden>
            {`${String(index + 1)} of ${String(items.length)}`}
          </p>
        ) : null}
        <div className="ui-photo-viewer__actions">
          {items.length > 1 ? (
            <>
              <Button
                type="button"
                variant="secondary"
                size="lg"
                data-viewer-act="previous"
                disabled={index === 0}
                onClick={() => {
                  pressed.current = 'previous';
                  go('previous');
                }}
              >
                <Icon name="previous" />
                Previous photo
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="lg"
                data-viewer-act="next"
                disabled={index === last}
                onClick={() => {
                  pressed.current = 'next';
                  go('next');
                }}
              >
                Next photo
                <Icon name="next" />
              </Button>
            </>
          ) : null}
          <Button type="button" variant="secondary" size="lg" data-initial-focus onClick={onClose}>
            Close the photo
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
