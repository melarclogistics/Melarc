import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { wcagViolations } from '../../../test-support/wcag';
import {
  PhotoViewer,
  SWIPE_DOMINANCE,
  SWIPE_MIN_DISTANCE,
  type PhotoViewerItem,
} from './PhotoViewer';

/**
 * The viewer of the photo kit (COMPONENT_PATTERNS, *PhotoViewer*): one photo at a time over the dialog, among the others of its grid. **It is generic and decides nothing**: it draws the picture the page gives
 * it, tells the page which photo the person moved to, and asks the page to close. It says where the person is ("3 of 12"), moves by two buttons the size of the hub floor, by the arrow keys and by a swipe,
 * loads at most **one** neighbour ahead, and leaves focus, the trap and the return of focus to the dialog it is made of.
 */
const ITEMS: readonly PhotoViewerItem[] = [
  { key: 'a', label: 'Parcel photo 1', detail: 'Taken 12 November 2026, 10:42' },
  { key: 'b', label: 'Parcel photo 2' },
  { key: 'c', label: 'Parcel photo 3', detail: 'Taken 12 November 2026, 10:44' },
  { key: 'd', label: 'Parcel photo 4' },
];

const picture = (item: PhotoViewerItem, context: { readonly current: boolean }): ReactNode => (
  <span data-testid={`${context.current ? 'now' : 'ahead'}-${item.key}`}>{item.label}</span>
);

interface HostProps {
  readonly items?: readonly PhotoViewerItem[];
  readonly start?: number;
  readonly onClose?: () => void;
  readonly onIndexChange?: (index: number) => void;
  readonly note?: string;
  /** Whether the viewer is open when the page is drawn: a person meets one by pressing a button, which is what the return of focus needs. */
  readonly initiallyOpen?: boolean;
}

/** A page with a button that opens the viewer, which is how a person meets one: focus has to come back to the button. */
function Host({
  items = ITEMS,
  start = 0,
  onClose,
  onIndexChange,
  note,
  initiallyOpen = true,
}: HostProps) {
  const [index, setIndex] = useState(start);
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
      >
        Open the photos
      </button>
      {open ? (
        <PhotoViewer
          items={items}
          index={index}
          onIndexChange={(next) => {
            onIndexChange?.(next);
            setIndex(next);
          }}
          onClose={() => {
            onClose?.();
            setOpen(false);
          }}
          renderPicture={picture}
          {...(note === undefined ? {} : { note })}
        />
      ) : null}
    </>
  );
}

const open = (props: HostProps = {}) => ({
  ...render(<Host {...props} />),
  user: userEvent.setup(),
});
const button = (name: string) => screen.getByRole('button', { name });
const stage = (): Element => {
  const found = document.querySelector('.ui-photo-viewer__stage');
  if (found === null) throw new Error('no stage');
  return found;
};

/** A pointer event of a finger, as the browser sends it (jsdom has no PointerEvent to build one from). */
function pointer(
  type: 'pointerdown' | 'pointerup' | 'pointercancel',
  at: { readonly x: number; readonly y: number },
  by: { readonly kind?: string; readonly id?: number; readonly primary?: boolean } = {},
): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: at.x,
    clientY: at.y,
  });
  Object.assign(event, {
    pointerId: by.id ?? 1,
    pointerType: by.kind ?? 'touch',
    isPrimary: by.primary ?? true,
  });
  act(() => {
    stage().dispatchEvent(event);
  });
}
const swipe = (dx: number, dy = 0, by: Parameters<typeof pointer>[2] = {}): void => {
  pointer('pointerdown', { x: 200, y: 100 }, by);
  pointer('pointerup', { x: 200 + dx, y: 100 + dy }, by);
};

describe('PhotoViewer: what it shows', () => {
  // Break caught: a viewer that is not a named dialog, or one that does not say where the person is among the photos.
  it('is a dialog named by the photo, described by its detail and the page’s note, and says where the person is', () => {
    open({ note: 'The photos are read only while this window is open.' });

    const dialog = screen.getByRole('dialog', { name: 'Parcel photo 1' });
    // The photo is shown whole, so the window is the wide one, not the window of a question.
    expect(dialog).toHaveClass('ui-dialog--wide');
    expect(dialog).toHaveAccessibleDescription(
      'Taken 12 November 2026, 10:42 The photos are read only while this window is open.',
    );
    expect(within(dialog).getByText('1 of 4')).toBeVisible();
    expect(screen.getByTestId('now-a')).toBeVisible();
  });

  // Break caught: a viewer that loads every photo it holds (sixty photos asked for the moment the first is opened), or loads the neighbour twice.
  it('loads one neighbour ahead and no more, hidden, and the photo it draws is the one looked at', () => {
    open({ start: 1 });

    expect(screen.getByTestId('now-b')).toBeVisible();
    const ahead = screen.getAllByTestId(/^ahead-/);
    expect(ahead).toHaveLength(1);
    expect(ahead[0]).toHaveAttribute('data-testid', 'ahead-c');
    expect(ahead[0]).not.toBeVisible();
    expect(screen.queryByTestId('now-c')).toBeNull();
  });

  // Break caught: a neighbour taken from the wrong side, so that going back a photo meets one that was never loaded.
  it('loads the one ahead in the direction the person is going', async () => {
    const { user } = open({ start: 2 });
    expect(screen.getByTestId('ahead-d')).toBeInTheDocument();

    await user.click(button('Previous photo'));

    expect(screen.getByTestId('now-b')).toBeVisible();
    expect(screen.getByTestId('ahead-a')).toBeInTheDocument();
    expect(screen.getAllByTestId(/^ahead-/)).toHaveLength(1);
  });

  // Break caught: a viewer at the end of the photos that loads nothing ahead, though there is one behind it to go back to.
  it('loads the one behind at the end of the photos, where there is none ahead', () => {
    open({ start: 3 });

    expect(screen.getByTestId('now-d')).toBeVisible();
    expect(screen.getAllByTestId(/^ahead-/)).toHaveLength(1);
    expect(screen.getByTestId('ahead-c')).toBeInTheDocument();
  });

  // Break caught: the state of one photo's picture carried to the next (a picture that failed, shown as the failure of the photo after it).
  it('draws each photo as a picture of its own, so that nothing of one is carried to the next', async () => {
    const mounts: string[] = [];
    function Probe({ id, current }: { readonly id: string; readonly current: boolean }) {
      // Recorded when the picture is made, and never again for the same one: a picture that was only given other props has not been drawn as a picture of its own.
      useState(() => mounts.push(`${current ? 'now' : 'ahead'}-${id}`));
      return null;
    }
    function Stateful() {
      const [index, setIndex] = useState(0);
      return (
        <PhotoViewer
          items={ITEMS}
          index={index}
          onIndexChange={setIndex}
          onClose={() => undefined}
          renderPicture={(item, context) => <Probe id={item.key} current={context.current} />}
        />
      );
    }
    render(<Stateful />);
    expect(mounts).toEqual(['now-a', 'ahead-b']);

    await userEvent.setup().click(button('Next photo'));

    // The photo that was ahead is drawn again as the one looked at, and a new one is loaded ahead: each is a picture of its own.
    expect(mounts).toEqual(['now-a', 'ahead-b', 'now-b', 'ahead-c']);
  });

  // Break caught: a viewer drawn with nothing to tell a person that it moved, so that a person who cannot see the screen does not know which photo they are at.
  it('tells the photo and its place in a polite status when it moves', async () => {
    const { user } = open();
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Parcel photo 1, 1 of 4');
    expect(status).toHaveAttribute('aria-live', 'polite');

    await user.click(button('Next photo'));

    expect(screen.getByRole('status')).toHaveTextContent('Parcel photo 2, 2 of 4');
  });

  // Break caught: a counter and two buttons drawn for a single photo, where there is nowhere to go.
  it('has no place to say and nowhere to go for a single photo, and still closes', async () => {
    const onClose = vi.fn();
    const { user } = open({ items: ITEMS.slice(0, 1), onClose });

    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Previous photo' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Next photo' })).toBeNull();
    expect(screen.queryByTestId(/^ahead-/)).toBeNull();

    await user.click(button('Close the photo'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // Break caught: a viewer with a violation of its own: an unnamed control, or a status that is not a region.
  it('has no accessibility violations', async () => {
    open({ note: 'The photos are read only while this window is open.' });

    expect(await wcagViolations(document.body)).toEqual([]);
  });
});

describe('PhotoViewer: moving by buttons', () => {
  // Break caught: the two floor buttons drawn at the medium size, which is a thumb's miss on a tablet.
  it('has buttons at the hub floor’s size', () => {
    open();

    for (const name of ['Previous photo', 'Next photo', 'Close the photo']) {
      expect(button(name)).toHaveClass('ui-button--lg');
    }
  });

  // Break caught: a button that moves by two, or one that does not tell the page.
  it('moves one photo at a time and tells the page where the person is', async () => {
    const onIndexChange = vi.fn();
    const { user } = open({ onIndexChange });

    await user.click(button('Next photo'));
    await user.click(button('Next photo'));
    await user.click(button('Previous photo'));

    expect(onIndexChange.mock.calls).toEqual([[1], [2], [1]]);
    expect(screen.getByRole('dialog', { name: 'Parcel photo 2' })).toBeInTheDocument();
    expect(screen.getByText('2 of 4')).toBeVisible();
  });

  // Break caught: a viewer that goes past its ends (a photo that is not there) or wraps round to the other end without saying so.
  it('cannot go before the first photo or past the last', async () => {
    const { user } = open();
    expect(button('Previous photo')).toBeDisabled();

    await user.click(button('Next photo'));
    await user.click(button('Next photo'));
    await user.click(button('Next photo'));

    expect(button('Next photo')).toBeDisabled();
    expect(screen.getByText('4 of 4')).toBeVisible();
  });

  // Break caught: a pressed button that is disabled by reaching the end, with focus left on a control that no longer takes it (a person at the keyboard drops out of the dialog).
  it('puts focus on the other button when the one that was pressed reaches the end and is disabled', async () => {
    const { user } = open({ start: 2 });

    await user.click(button('Next photo'));

    expect(button('Next photo')).toBeDisabled();
    expect(button('Previous photo')).toHaveFocus();

    await user.click(button('Previous photo'));
    await user.click(button('Previous photo'));
    await user.click(button('Previous photo'));

    expect(button('Previous photo')).toBeDisabled();
    expect(button('Next photo')).toHaveFocus();
  });
});

describe('PhotoViewer: moving by keys', () => {
  // Break caught: arrow keys that do nothing, or that go the wrong way.
  it('moves on ArrowRight and back on ArrowLeft, and not past the ends', async () => {
    const { user } = open();

    await user.keyboard('{ArrowLeft}');
    expect(screen.getByText('1 of 4')).toBeVisible();
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(screen.getByText('3 of 4')).toBeVisible();
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByText('2 of 4')).toBeVisible();
    await user.keyboard('{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}');
    expect(screen.getByText('4 of 4')).toBeVisible();
  });

  // Break caught: the browser's own use of Alt+Arrow (back and forward in the history) swallowed by the viewer, or a key taken from a person who holds a modifier.
  it('leaves an arrow key with a modifier to the browser', async () => {
    const { user } = open();

    await user.keyboard('{Alt>}{ArrowRight}{/Alt}');
    await user.keyboard('{Control>}{ArrowRight}{/Control}');
    await user.keyboard('{Shift>}{ArrowRight}{/Shift}');
    await user.keyboard('{Meta>}{ArrowRight}{/Meta}');

    expect(screen.getByText('1 of 4')).toBeVisible();
  });

  // Break caught: a key that the viewer uses left to the browser (the page scrolls under a photo that turns), or one it does not use taken from it (the keys that scroll the window).
  it('takes the arrow keys it uses from the browser and leaves the other keys to it', () => {
    open();
    const close = button('Close the photo');

    expect(fireEvent.keyDown(close, { key: 'ArrowRight' })).toBe(false);
    expect(fireEvent.keyDown(close, { key: 'ArrowLeft' })).toBe(false);
    expect(fireEvent.keyDown(close, { key: 'ArrowDown' })).toBe(true);
    expect(fireEvent.keyDown(close, { key: 'PageDown' })).toBe(true);
  });

  // Break caught: Escape that does nothing, or a viewer that closes itself without telling the page.
  it('asks the page to close on Escape and by its button', async () => {
    const onClose = vi.fn();
    const { user } = open({ onClose });

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // Break caught: a viewer that opens with focus on a control that moves or does nothing, and one that returns focus nowhere when it closes (the dialog does both; the viewer must not defeat it).
  it('starts on the close button and returns focus to the control that opened it', async () => {
    const { user } = open({ initiallyOpen: false });
    await user.click(button('Open the photos'));
    expect(button('Close the photo')).toHaveFocus();

    await user.click(button('Close the photo'));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(button('Open the photos')).toHaveFocus();
  });
});

describe('PhotoViewer: moving by a swipe', () => {
  // Break caught: a swipe that goes the wrong way: a finger dragged to the left brings the next photo, as a page turns.
  it('goes to the next photo on a swipe to the left and to the previous one on a swipe to the right', () => {
    open({ start: 1 });

    swipe(-(SWIPE_MIN_DISTANCE + 20));
    expect(screen.getByText('3 of 4')).toBeVisible();
    swipe(SWIPE_MIN_DISTANCE + 20);
    swipe(SWIPE_MIN_DISTANCE + 20);
    expect(screen.getByText('1 of 4')).toBeVisible();
  });

  // Break caught: a swipe that has no threshold, so that a tap with a little slip, or a finger resting on the photo, turns it; or one whose threshold is a pixel further than it says.
  it('does not move for a drag shorter than the threshold, and moves for one of exactly the threshold', () => {
    open({ start: 1 });

    // Each is told apart from the other: two drags that turn the photo one way and then the other would cancel out and hide a threshold that is not there.
    swipe(-(SWIPE_MIN_DISTANCE - 1));
    expect(screen.getByText('2 of 4')).toBeVisible();
    swipe(SWIPE_MIN_DISTANCE - 1);
    expect(screen.getByText('2 of 4')).toBeVisible();

    swipe(-SWIPE_MIN_DISTANCE);
    expect(screen.getByText('3 of 4')).toBeVisible();
  });

  // Break caught: a vertical scroll that turns the photo, or a diagonal one that is taken for a swipe.
  it('leaves a drag that is mostly vertical to the scroll', () => {
    open({ start: 1 });

    swipe(-(SWIPE_MIN_DISTANCE + 20), 400);
    swipe(-(SWIPE_MIN_DISTANCE + 20), (SWIPE_MIN_DISTANCE + 20) / SWIPE_DOMINANCE + 5);

    expect(screen.getByText('2 of 4')).toBeVisible();
  });

  // Break caught: a mouse drag that turns the photo (a person selecting or dragging the picture with a mouse turns it by accident); a mouse has buttons and keys.
  it('is for a finger and a pen and not for a mouse', () => {
    open({ start: 1 });

    swipe(-(SWIPE_MIN_DISTANCE + 20), 0, { kind: 'mouse' });
    swipe(-(SWIPE_MIN_DISTANCE + 20), 0, { kind: 'pen' });

    expect(screen.getByText('3 of 4')).toBeVisible();
  });

  // Break caught: a second finger (a pinch to zoom) taken for a swipe, or a gesture that the browser took over (a scroll) completed by the lift of the finger.
  it('ignores a second finger and a gesture that was cancelled', () => {
    open({ start: 1 });

    pointer('pointerdown', { x: 200, y: 100 }, { id: 2, primary: false });
    pointer('pointerup', { x: 100, y: 100 }, { id: 2, primary: false });
    pointer('pointerdown', { x: 200, y: 100 });
    pointer('pointercancel', { x: 150, y: 100 });
    pointer('pointerup', { x: 100, y: 100 });

    expect(screen.getByText('2 of 4')).toBeVisible();
  });

  // Break caught: a lift of a different finger than the one that went down finishing the first one's swipe.
  it('takes a swipe from the finger that began it', () => {
    open({ start: 1 });

    pointer('pointerdown', { x: 200, y: 100 }, { id: 1 });
    pointer('pointerup', { x: 100, y: 100 }, { id: 2 });

    expect(screen.getByText('2 of 4')).toBeVisible();
  });

  // Break caught: a swipe past the ends.
  it('does not go past the ends on a swipe', () => {
    open();

    swipe(SWIPE_MIN_DISTANCE + 20);
    expect(screen.getByText('1 of 4')).toBeVisible();
  });
});
