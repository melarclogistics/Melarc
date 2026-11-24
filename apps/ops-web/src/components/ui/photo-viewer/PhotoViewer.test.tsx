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
  /** What the page draws for a photo, when it is not the plain text of the photo's name: the viewer's picture of a real photo is an `img`. */
  readonly pictures?: (item: PhotoViewerItem, context: { readonly current: boolean }) => ReactNode;
}

/** A page with a button that opens the viewer, which is how a person meets one: focus has to come back to the button. */
function Host({
  items = ITEMS,
  start = 0,
  onClose,
  onIndexChange,
  note,
  initiallyOpen = true,
  pictures = picture,
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
          renderPicture={pictures}
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
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
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

/**
 * Where the controls are (the pictures of the receiving screens, 16 November 2026, defects 1 and 11): the viewer is a window as tall as the screen lets it be, **the controls are the last thing in it and the photo is
 * the thing that gives way**, so that a button never leaves the screen and does not move from one photo to the next; and **Previous, the place and Next are one row, with Close apart**, as they were not on a phone
 * (Previous alone on a row, the place under it, Next and Close sharing the next). The pixels are measured in a browser (`test/browser/kit.spec.ts`); this is the markup they depend on.
 */
describe('PhotoViewer: where the controls are', () => {
  const part = (selector: string): HTMLElement => {
    const found = document.querySelector<HTMLElement>(selector);
    if (found === null) throw new Error(`There is no ${selector} in the viewer.`);
    return found;
  };

  // Break caught: a viewer that is as tall as its content, so that its controls start below a short screen and are reached by scrolling inside it.
  it('is a window that fills the screen’s height, which the photo gives way in', () => {
    open();

    expect(screen.getByRole('dialog')).toHaveClass('ui-dialog--wide', 'ui-dialog--fill');
  });

  // Break caught: Previous alone on a row with the place under it (a phone), or the place somewhere else than between the two buttons it counts for.
  it('puts previous, the place and next in one row, in that order', () => {
    open();

    const row = [...part('.ui-photo-viewer__nav').children].map(
      (child) => child.getAttribute('data-viewer-act') ?? child.getAttribute('role'),
    );
    expect(row).toEqual(['previous', 'status', 'next']);
  });

  // Break caught: the place under a name that the stylesheet does not style (a place that does not take the room between the buttons, or is not centred and in the secondary text).
  it('draws the place as the element the stylesheet styles', () => {
    open();

    expect(within(part('.ui-photo-viewer__nav')).getByRole('status')).toHaveClass(
      'ui-photo-viewer__position',
    );
  });

  // Break caught: Close in the row of the two buttons that move (a button of another kind where a thumb moves), or somewhere that is not the last of the controls.
  it('puts close apart from that row, in the same controls', () => {
    open();

    const close = button('Close the photo');
    const nav = part('.ui-photo-viewer__nav');
    expect(nav.contains(close)).toBe(false);
    expect(close.closest('.ui-photo-viewer__controls')).toBe(part('.ui-photo-viewer__controls'));
    expect(nav.closest('.ui-photo-viewer__controls')).toBe(part('.ui-photo-viewer__controls'));
    expect(part('.ui-photo-viewer__controls').lastElementChild).toBe(close);
  });

  // Break caught: the controls above the photo (or between its parts), so that the photo pushes them off the screen.
  it('has the controls after the photo, last in the viewer', () => {
    open();

    const root = part('.ui-photo-viewer');
    expect(root.lastElementChild).toBe(part('.ui-photo-viewer__controls'));
    expect(part('.ui-photo-viewer__stage').nextElementSibling).toBe(
      part('.ui-photo-viewer__ahead'),
    );
  });

  // Break caught: a viewer with no neighbour to load (the last photo, after the person went back) that has no controls in the same place: the controls are the same wherever the person is.
  it('has its controls in the same place whatever the photo', async () => {
    const { user } = open();
    const where = (): string[] =>
      [...part('.ui-photo-viewer__controls').querySelectorAll('button')].map(
        (each) => each.getAttribute('aria-label') ?? each.textContent,
      );
    const first = where();

    await user.click(button('Next photo'));
    await user.click(button('Next photo'));

    expect(where()).toEqual(first);
  });

  // Break caught: two buttons that say "Previous photo" and "Next photo" in full beside the place on a phone (they do not fit in 326 px with it) with no name of their own in full: they say "Previous" and "Next",
  // and are named in full for a screen reader, which the label in the name rule allows because the name holds the words that are drawn.
  it('says previous and next shortly where it can be seen, and in full where it is heard', () => {
    open();

    const previous = button('Previous photo');
    const next = button('Next photo');
    expect(previous).toHaveTextContent(/^Previous$/);
    expect(next).toHaveTextContent(/^Next$/);
    expect(previous).toHaveAccessibleName('Previous photo');
    expect(next).toHaveAccessibleName('Next photo');
    expect(previous).toHaveClass('ui-button--lg');
    expect(next).toHaveClass('ui-button--lg');
  });

  // Break caught: the drawn words in an element that the narrowest phone's rule does not hide (a row that does not fit 320px, with the words of two buttons that are named in full without them).
  it('draws the words of the two buttons in the element that a narrow screen hides', () => {
    open();

    expect(within(button('Previous photo')).getByText('Previous')).toHaveClass(
      'ui-photo-viewer__label',
    );
    expect(within(button('Next photo')).getByText('Next')).toHaveClass('ui-photo-viewer__label');
  });

  // Break caught: a single photo with a row of two buttons and a place that count nothing.
  it('has nothing to move by for a single photo, only close', () => {
    open({ items: ITEMS.slice(0, 1) });

    expect(document.querySelector('.ui-photo-viewer__nav')).toBeNull();
    expect(
      [...part('.ui-photo-viewer__controls').querySelectorAll('button')].map(
        (each) => each.textContent,
      ),
    ).toEqual(['Close the photo']);
  });
});

/**
 * Looking closely (Run G2, OB-S1-168; the Product Owner's decision D-S7-14 of 24 November 2026, a change of the kit's viewer approved on that day): **pinch and double-tap zoom, drag to look around when zoomed, a
 * quarter turn either way, a button for each with its label, and the keyboard (plus, minus, R, the arrows, Escape)**, the photo's own aspect kept and everything instant under reduced motion. The viewer holds the
 * zoom, the turn and where the photo was moved as numbers and says them to the stylesheet (`--ui-photo-zoom`, `--ui-photo-turn`, `--ui-photo-x`, `--ui-photo-y` on the stage), which draws the photo; jsdom draws
 * nothing, so what is asserted here is what the viewer decides, and what is drawn (the aspect, the fit of a turned photo, the reach of a zoomed one) is `kit.spec.ts`'s, on a real label.
 */
const STAGE_W = 400;
const STAGE_H = 300;
const PHOTO_W = 400;
const PHOTO_H = 300;

/** A window of 400 x 300 with a photo of the same size drawn whole in it, which jsdom cannot lay out. */
function givenTheRoom(): void {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    // The stage, and the box the page draws the picture in (the first thing in the photo's place): the window the photo is looked at in.
    const isRoom =
      this.classList.contains('ui-photo-viewer__stage') ||
      this.parentElement?.classList.contains('ui-photo-viewer__photo') === true;
    const box = isRoom ? { width: STAGE_W, height: STAGE_H } : { width: 0, height: 0 };
    return {
      ...box,
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: box.width,
      bottom: box.height,
      toJSON: () => ({}),
    };
  });
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this instanceof HTMLImageElement ? PHOTO_W : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this instanceof HTMLImageElement ? PHOTO_H : 0;
  });
}

const withImage = (item: PhotoViewerItem, context: { readonly current: boolean }): ReactNode => (
  <img alt={item.label} src={`/${item.key}.png`} data-current={String(context.current)} />
);

function look(over: Partial<HostProps> = {}) {
  givenTheRoom();
  const user = userEvent.setup();
  render(<Host pictures={withImage} {...over} />);
  return { user };
}

/** What the stage says to the stylesheet. */
const said = (name: string): string => (stage() as HTMLElement).style.getPropertyValue(name);
const zoomOf = (): number => Number(said('--ui-photo-zoom'));
const level = (): string | null =>
  document.querySelector('.ui-photo-viewer__view')?.textContent ?? null;

describe('PhotoViewer: looking closely', () => {
  // Break caught: a viewer that starts zoomed or turned, or that has no button for a way of looking (the keyboard and the finger are no help to a person who has neither).
  it('shows the photo whole at 100%, and has a button for each way of looking, at the hub floor’s size and named', () => {
    look();

    expect([
      said('--ui-photo-zoom'),
      said('--ui-photo-turn'),
      said('--ui-photo-x'),
      said('--ui-photo-y'),
    ]).toEqual(['1', '0deg', '0px', '0px']);
    expect(level()).toBe('100%');
    for (const name of ['Zoom out', 'Zoom in', 'Turn left', 'Turn right']) {
      expect(button(name)).toHaveClass('ui-button--lg');
      // The label is drawn beside the icon where there is room, and is the name where there is not.
      expect(button(name).querySelector('.ui-photo-viewer__label')).toHaveTextContent(name);
    }
    expect(button('Zoom out')).toBeDisabled();
    expect(button('Zoom in')).toBeEnabled();
    expect(screen.getByRole('group', { name: 'Look at the photo closely' })).toBeVisible();
  });

  // Break caught: a zoom with no end (the photo is lost off the window), one that goes below the photo whole, steps that skip a level, or a level that is not said (a person who cannot see the photo is told nothing).
  it('zooms in by steps and out again, says the level in a polite status, and stops at both ends', async () => {
    const { user } = look();

    const seen: string[] = [];
    for (let step = 0; step < 6; step += 1) {
      await user.click(button('Zoom in'));
      seen.push(level() ?? '');
    }
    expect(seen).toEqual(['150%', '200%', '300%', '400%', '600%', '600%']);
    expect(button('Zoom in')).toBeDisabled();
    expect(document.querySelector('.ui-photo-viewer__view')).toHaveAttribute('aria-live', 'polite');

    for (let step = 0; step < 6; step += 1) await user.click(button('Zoom out'));
    expect(level()).toBe('100%');
    expect(zoomOf()).toBe(1);
    expect(button('Zoom out')).toBeDisabled();
  });

  // Break caught: a keyboard person dropped out of the dialog when the button they pressed reaches its end and is disabled (a disabled button takes no focus).
  it('puts focus on the other zoom button when the one that was pressed reaches its end', async () => {
    const { user } = look();

    button('Zoom in').focus();
    for (let step = 0; step < 5; step += 1) await user.keyboard('{Enter}');
    expect(button('Zoom in')).toBeDisabled();
    expect(button('Zoom out')).toHaveFocus();

    for (let step = 0; step < 5; step += 1) await user.keyboard('{Enter}');
    expect(button('Zoom out')).toBeDisabled();
    expect(button('Zoom in')).toHaveFocus();
  });

  // Break caught: a turn that only goes one way, one that is not a quarter, a turn that spins backwards through the others when it comes round (the turn is counted, not wrapped), or a turned photo that is not said to be.
  it('turns by quarters either way, counts the turns, and says which way the photo is turned', async () => {
    const { user } = look();

    await user.click(button('Turn right'));
    expect(said('--ui-photo-turn')).toBe('90deg');
    expect(level()).toBe('100%, turned right');
    expect(stage()).toHaveAttribute('data-quarter', 'true');
    await user.click(button('Turn right'));
    expect(said('--ui-photo-turn')).toBe('180deg');
    expect(level()).toBe('100%, upside down');
    expect(stage()).toHaveAttribute('data-quarter', 'false');
    await user.click(button('Turn right'));
    await user.click(button('Turn right'));
    // Round again: 360 degrees and not 0, so that the photo does not spin back through every turn it made.
    expect(said('--ui-photo-turn')).toBe('360deg');
    expect(level()).toBe('100%');

    await user.click(button('Turn left'));
    expect(said('--ui-photo-turn')).toBe('270deg');
    expect(level()).toBe('100%, turned left');
  });

  // Break caught: a key that does nothing, one of the four that turns the browser's own zoom into the viewer's (Control and plus is the browser's), and a typed plus that is lost because Shift is held.
  it('zooms on plus and minus and turns on R, and leaves the browser its keys with Control, Alt or Meta', async () => {
    const { user } = look();

    await user.keyboard('+');
    expect(level()).toBe('150%');
    await user.keyboard('=');
    expect(level()).toBe('200%');
    await user.keyboard('-');
    expect(level()).toBe('150%');
    await user.keyboard('_');
    expect(level()).toBe('100%');
    await user.keyboard('r');
    expect(said('--ui-photo-turn')).toBe('90deg');
    await user.keyboard('{Shift>}r{/Shift}');
    expect(said('--ui-photo-turn')).toBe('0deg');

    const close = button('Close the photo');
    for (const key of ['+', '-', 'r']) {
      for (const held of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }]) {
        expect(fireEvent.keyDown(close, { key, ...held }), `${key} ${JSON.stringify(held)}`).toBe(
          true,
        );
      }
    }
    expect(level()).toBe('100%');
    expect(said('--ui-photo-turn')).toBe('0deg');
    // The keys it uses are taken from the browser, and the others are not.
    expect(fireEvent.keyDown(close, { key: '+', shiftKey: true })).toBe(false);
    expect(fireEvent.keyDown(close, { key: 'x' })).toBe(true);
  });

  // Break caught: the arrow keys that move between photos used to look around a photo that is zoomed (the person loses the photo they were looking at), or the other way round (a zoomed photo that cannot be looked around).
  it('moves between photos on the arrows at 100% and looks around on them when zoomed, never past the photo’s edge', async () => {
    const { user } = look();

    await user.keyboard('{ArrowRight}');
    expect(screen.getByText('2 of 4')).toBeVisible();
    await user.keyboard('{ArrowLeft}');

    // At 200% the photo is 800 x 600 in a window of 400 x 300: it may be moved 200 across and 150 down from the middle, and an arrow moves it by a quarter of the window.
    await user.keyboard('++');
    expect(zoomOf()).toBe(2);
    await user.keyboard('{ArrowRight}');
    expect(screen.getByText('1 of 4')).toBeVisible();
    expect([said('--ui-photo-x'), said('--ui-photo-y')]).toEqual(['-100px', '0px']);
    await user.keyboard('{ArrowRight}{ArrowRight}{ArrowRight}');
    expect(said('--ui-photo-x')).toBe('-200px');
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}');
    expect(said('--ui-photo-y')).toBe('-150px');
    await user.keyboard('{ArrowLeft}');
    expect(said('--ui-photo-x')).toBe('-100px');
    await user.keyboard('{ArrowUp}');
    expect(said('--ui-photo-y')).toBe('-75px');
    expect(screen.getByText('1 of 4')).toBeVisible();
  });

  // Break caught: a photo that is zoomed out of its place and stays there (the zoom goes back to 100% and the photo does not), or a turn that leaves the photo moved to where it no longer reaches.
  it('puts the photo back in the middle when it is no longer zoomed, and when it is turned', async () => {
    const { user } = look();

    await user.keyboard('++{ArrowRight}');
    expect(said('--ui-photo-x')).toBe('-100px');
    await user.keyboard('--');
    expect([zoomOf(), said('--ui-photo-x'), said('--ui-photo-y')]).toEqual([1, '0px', '0px']);

    await user.keyboard('++{ArrowRight}r');
    expect(said('--ui-photo-x')).toBe('0px');
    expect(said('--ui-photo-turn')).toBe('90deg');
    expect(zoomOf()).toBe(2);
  });

  // Break caught: a photo of one turn that is zoomed or moved as if it were not turned (a photo on its side is taller than it is wide, and reaches further down than across).
  it('works out how far a turned photo reaches from its turned shape', async () => {
    const { user } = look();

    // 400 x 300 turned a quarter is 300 x 400; at 200% it is 600 x 800 in a window of 400 x 300: 100 across and 250 down.
    await user.keyboard('r++');
    await user.keyboard('{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}');
    expect(said('--ui-photo-x')).toBe('-100px');
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}');
    expect(said('--ui-photo-y')).toBe('-250px');
  });

  // Break caught: a viewer that carries the zoom and the turn of one photo to the next (a label that was turned is not a reason to turn the one that follows), or a zoom that is lost when the page redraws the viewer on the same photo.
  it('starts each photo whole, and keeps what was done to a photo while it is the one looked at', async () => {
    const { user } = look();

    await user.keyboard('+r');
    expect(level()).toBe('150%, turned right');
    await user.click(button('Next photo'));
    expect(screen.getByText('2 of 4')).toBeVisible();
    expect([zoomOf(), said('--ui-photo-turn')]).toEqual([1, '0deg']);
    await user.click(button('Previous photo'));
    expect([zoomOf(), said('--ui-photo-turn')]).toEqual([1, '0deg']);
  });
});

describe('PhotoViewer: looking closely with a finger or a mouse', () => {
  const move = (
    at: { x: number; y: number },
    by: { id?: number; kind?: string; primary?: boolean } = {},
  ): void => {
    pointer('pointermove', at, by);
  };

  // Break caught: a drag that does not look around a zoomed photo (the only way to a corner is the arrow keys), one that can pull the photo off its window, one that a mouse cannot make (a person with a mouse has no other hand).
  it('looks around a zoomed photo by dragging, with a finger, a pen or a mouse, and stays within the photo', async () => {
    const { user } = look();
    await user.keyboard('++');

    for (const kind of ['touch', 'pen', 'mouse']) {
      pointer('pointerdown', { x: 200, y: 150 }, { kind });
      move({ x: 150, y: 120 }, { kind });
      pointer('pointerup', { x: 150, y: 120 }, { kind });
      expect([said('--ui-photo-x'), said('--ui-photo-y')], kind).toEqual(['-50px', '-30px']);
      await user.keyboard('--++');
    }

    // A long drag stops at the edge of the photo: 200 across and 150 down at 200%.
    pointer('pointerdown', { x: 380, y: 280 });
    move({ x: 10, y: 20 });
    pointer('pointerup', { x: 10, y: 20 });
    expect([said('--ui-photo-x'), said('--ui-photo-y')]).toEqual(['-200px', '-150px']);
    // A drag is by how far the finger goes: 380 across and 270 down from the far edge is 180 and 120, inside the photo; 100 more is past the other edge and stops at it.
    pointer('pointerdown', { x: 10, y: 20 });
    move({ x: 390, y: 290 });
    pointer('pointerup', { x: 390, y: 290 });
    expect([said('--ui-photo-x'), said('--ui-photo-y')]).toEqual(['180px', '120px']);
    pointer('pointerdown', { x: 0, y: 0 });
    move({ x: 100, y: 100 });
    pointer('pointerup', { x: 100, y: 100 });
    expect([said('--ui-photo-x'), said('--ui-photo-y')]).toEqual(['200px', '150px']);
  });

  // Break caught: a drag of a zoomed photo that is taken for a swipe and turns to the next photo (the photo that was being looked at is gone), or a photo at 100% that cannot be swiped to the next.
  it('swipes only at 100%: a drag across a zoomed photo looks around it and moves to no other photo', async () => {
    const { user } = look({ start: 1 });

    swipe(-(SWIPE_MIN_DISTANCE + 20));
    expect(screen.getByText('3 of 4')).toBeVisible();
    await user.keyboard('++');
    pointer('pointerdown', { x: 300, y: 150 });
    move({ x: 100, y: 150 });
    pointer('pointerup', { x: 100, y: 150 });
    expect(screen.getByText('3 of 4')).toBeVisible();
    expect(said('--ui-photo-x')).toBe('-200px');
  });

  // Break caught: a pinch that does not zoom, one that zooms about the middle and not about the fingers (the thing looked at slides away from them), one that goes past the limits, and one that ends in a swipe or a tap.
  it('pinches: two fingers apart zoom in about the point between them, together zoom out, within the limits', () => {
    look();

    // The fingers are 100 apart, at 150 and 250 across (the point between them, 200, is the middle) and 100 down; they go to 300 apart.
    pointer('pointerdown', { x: 150, y: 100 }, { id: 1 });
    pointer('pointerdown', { x: 250, y: 100 }, { id: 2, primary: false });
    move({ x: 50, y: 100 }, { id: 1 });
    move({ x: 350, y: 100 }, { id: 2, primary: false });
    expect(zoomOf()).toBeCloseTo(3, 5);
    // About the point between them: that is at 200 across, the middle of a window 400 wide, and 100 down, 50 above the middle of one 300 high, so the photo moves down by what the zoom adds above it.
    expect(Number.parseFloat(said('--ui-photo-x'))).toBeCloseTo(0, 5);
    expect(Number.parseFloat(said('--ui-photo-y'))).toBeCloseTo(100, 5);
    pointer('pointerup', { x: 50, y: 100 }, { id: 1 });
    pointer('pointerup', { x: 350, y: 100 }, { id: 2, primary: false });

    // Back together: never below 100% (the photo whole), and it is back in the middle.
    pointer('pointerdown', { x: 50, y: 100 }, { id: 3 });
    pointer('pointerdown', { x: 350, y: 100 }, { id: 4, primary: false });
    move({ x: 199, y: 100 }, { id: 3 });
    move({ x: 201, y: 100 }, { id: 4, primary: false });
    expect(zoomOf()).toBe(1);
    expect([said('--ui-photo-x'), said('--ui-photo-y')]).toEqual(['0px', '0px']);
    pointer('pointerup', { x: 199, y: 100 }, { id: 3 });
    pointer('pointerup', { x: 201, y: 100 }, { id: 4, primary: false });

    // Apart without end: the limit, not more.
    pointer('pointerdown', { x: 190, y: 150 }, { id: 5 });
    pointer('pointerdown', { x: 210, y: 150 }, { id: 6, primary: false });
    move({ x: 0, y: 150 }, { id: 5 });
    move({ x: 400, y: 150 }, { id: 6, primary: false });
    expect(zoomOf()).toBe(6);
  });

  // Break caught: the lift of the fingers of a pinch taken for a swipe or a tap (a photo that zooms and then turns to the next photo, or that is double-tapped back out).
  it('does not take the end of a pinch for a swipe or a tap', () => {
    look({ start: 1 });

    pointer('pointerdown', { x: 100, y: 150 }, { id: 1 });
    pointer('pointerdown', { x: 200, y: 150 }, { id: 2, primary: false });
    move({ x: 0, y: 150 }, { id: 1 });
    move({ x: 300, y: 150 }, { id: 2, primary: false });
    pointer('pointerup', { x: 0, y: 150 }, { id: 2, primary: false });
    pointer('pointerup', { x: 0 - 100, y: 150 }, { id: 1 });

    expect(screen.getByText('2 of 4')).toBeVisible();
    expect(zoomOf()).toBeGreaterThan(1);
  });

  // Break caught (the mutant that survived the first tests): the lift of a finger that stayed where it was while the other moved, in a pinch, counted as a tap: two pinches close together would make a double tap, which
  // zooms the photo back out under the fingers that had just zoomed it in.
  it('does not take the lift of a finger that stayed still in a pinch for a tap', () => {
    look();

    for (const [still, moving] of [
      [1, 2],
      [3, 4],
    ] as const) {
      pointer('pointerdown', { x: 100, y: 150 }, { id: still });
      pointer('pointerdown', { x: 200, y: 150 }, { id: moving, primary: false });
      move({ x: 300, y: 150 }, { id: moving, primary: false });
      pointer('pointerup', { x: 100, y: 150 }, { id: still });
      pointer('pointerup', { x: 300, y: 150 }, { id: moving, primary: false });
    }

    // Each pinch doubled the distance between the fingers: 1 to 2 to 4, and the two lifts of a still finger are no double tap that took it back to 1.
    expect(zoomOf()).toBeCloseTo(4, 5);
  });

  // Break caught: a double tap that does not zoom, one that zooms about the middle and not about the tap, one that cannot zoom back out, and two taps of different moments or places taken for one.
  it('zooms in on a double tap, where it was tapped, and back out on the next; two taps far apart are not one', () => {
    look();
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const tap = (at: { x: number; y: number }): void => {
      pointer('pointerdown', at);
      pointer('pointerup', at);
    };

    // 100 across and 75 down in a window of 400 x 300: 100 left of the middle and 75 above it.
    tap({ x: 100, y: 75 });
    now += 120;
    tap({ x: 105, y: 78 });
    expect(zoomOf()).toBe(3);
    // About the point of the second tap, (105, 78): 95 left of the middle and 72 above it. It stays where it is on the screen, so the photo moves right and down by twice that (the zoom adds two more of it): 190 and 144, within the 400 and 300 it reaches at 300%.
    expect(Number.parseFloat(said('--ui-photo-x'))).toBeCloseTo(190, 5);
    expect(Number.parseFloat(said('--ui-photo-y'))).toBeCloseTo(144, 5);

    now += 120;
    tap({ x: 200, y: 150 });
    now += 120;
    tap({ x: 200, y: 150 });
    expect(zoomOf()).toBe(1);
    expect([said('--ui-photo-x'), said('--ui-photo-y')]).toEqual(['0px', '0px']);

    // Too slow, too far apart: two taps.
    now += 120;
    tap({ x: 100, y: 75 });
    now += 600;
    tap({ x: 100, y: 75 });
    expect(zoomOf()).toBe(1);
    now += 100;
    tap({ x: 300, y: 225 });
    expect(zoomOf()).toBe(1);
  });

  // Break caught: a drag that ends as a tap (a swipe or a look around that, lifted, counts toward a double tap and zooms), or a tap that the mouse cannot make.
  it('counts only a press that stays where it was as a tap', () => {
    look();
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);

    pointer('pointerdown', { x: 100, y: 75 });
    pointer('pointerup', { x: 100 + 30, y: 75 });
    now += 100;
    pointer('pointerdown', { x: 100, y: 75 });
    pointer('pointerup', { x: 100 + 30, y: 75 });
    expect(zoomOf()).toBe(1);

    now += 100;
    pointer('pointerdown', { x: 100, y: 75 }, { kind: 'mouse' });
    pointer('pointerup', { x: 100, y: 75 }, { kind: 'mouse' });
    now += 100;
    pointer('pointerdown', { x: 100, y: 75 }, { kind: 'mouse' });
    pointer('pointerup', { x: 100, y: 75 }, { kind: 'mouse' });
    expect(zoomOf()).toBe(3);
  });

  // Break caught: a button the page draws under the picture (the receiving screens draw one) pressed twice and taken for a double tap that zooms the photo, or held by the stage's capture of the pointer so that its click never
  // arrives. A press that lands on a control is the control's.
  it('leaves a button the page drew under the picture alone: it is pressed, not looked through', () => {
    givenTheRoom();
    const clicked = vi.fn();
    render(
      <Host
        pictures={(item, context) => (
          <>
            {withImage(item, context)}
            <button type="button" onClick={clicked}>
              Open the parcel
            </button>
          </>
        )}
      />,
    );
    const act = screen.getByRole('button', { name: 'Open the parcel' });

    const press = (type: 'pointerdown' | 'pointerup'): void => {
      const event = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: 50,
        clientY: 50,
      });
      Object.assign(event, { pointerId: 1, pointerType: 'touch', isPrimary: true });
      fireEvent(act, event);
    };
    press('pointerdown');
    press('pointerup');
    press('pointerdown');
    press('pointerup');
    fireEvent.click(act);

    expect(zoomOf()).toBe(1);
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  // Break caught (found in a real browser: a mouse dragged the photo and the first move was the only one): the browser's own drag of an image, which a press on the picture and a move start, and which ends the pointer's
  // events with a cancel. The drag that looks around a zoomed photo must never become the browser's.
  it('does not let the browser drag the picture away', () => {
    look();

    const image = stage().querySelector('img');
    expect(image).not.toBeNull();
    if (image === null) return;
    expect(fireEvent.dragStart(image)).toBe(false);
    expect(fireEvent.dragStart(stage())).toBe(false);
  });

  // Break caught: a gesture that the browser took over (a cancel) that is finished by the next lift, or one that leaves the photo moving under a finger that is no longer there.
  it('lets go of a pinch or a drag the browser cancelled', async () => {
    const { user } = look();
    await user.keyboard('++');

    pointer('pointerdown', { x: 200, y: 150 });
    move({ x: 150, y: 150 });
    expect(said('--ui-photo-x')).toBe('-50px');
    pointer('pointercancel', { x: 150, y: 150 });
    move({ x: 50, y: 150 });
    expect(said('--ui-photo-x')).toBe('-50px');
  });

  it('has no accessibility violations with its controls and at a zoom', async () => {
    const { user } = look();
    await user.keyboard('+r');

    expect(await wcagViolations(document.body)).toEqual([]);
  });
});
