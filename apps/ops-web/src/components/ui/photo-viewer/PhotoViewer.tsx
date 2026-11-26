import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
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
/** The levels the two zoom buttons and the plus and minus keys step through, 1 being the photo whole as the window fits it. A pinch is not held to them: it stops anywhere between the ends. */
export const ZOOM_LEVELS = [1, 1.5, 2, 3, 4, 6] as const;
/** The most a photo is zoomed to, by any way of doing it. */
export const MAX_ZOOM = 6;
/** What a double tap zooms to, from the photo whole. */
export const DOUBLE_TAP_ZOOM = 3;
/** Two taps this close in time (milliseconds) and in place (pixels) are a double tap. */
export const DOUBLE_TAP_MS = 300;
export const DOUBLE_TAP_DISTANCE = 40;
/** A press that moves less than this (pixels) is a tap and not a drag. */
const TAP_SLOP = 10;
/** An arrow key moves a zoomed photo by this share of the window. */
const KEY_PAN_SHARE = 0.25;

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
   * the next photo is there when it is asked for. **The first thing it draws is the picture** (an `img` somewhere in it): the viewer zooms and turns that and nothing the page draws beside it.
   */
  readonly renderPicture: (
    item: PhotoViewerItem,
    context: { readonly current: boolean },
  ) => ReactNode;
  /** A line about the photos together, said under the detail of each: the page's words ("The photos are read only while this window is open."). */
  readonly note?: string;
}

type Way = 'next' | 'previous';

/** What has been done to the photo looked at: how far it is zoomed (1 is whole), how many quarter turns it has been turned (counted, not wrapped, so that it does not spin back through them all), and where it was moved to from the middle, in pixels. */
interface Look {
  readonly zoom: number;
  readonly turn: number;
  readonly x: number;
  readonly y: number;
}
const WHOLE: Look = { zoom: 1, turn: 0, x: 0, y: 0 };

interface Point {
  readonly x: number;
  readonly y: number;
}
interface Size {
  readonly width: number;
  readonly height: number;
}

const clamp = (value: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, value));

/** The next level above the zoom, or the next below it: where a button or a key goes from wherever a pinch left the photo. */
function stepped(zoom: number, to: 1 | -1): number {
  if (to === 1) return ZOOM_LEVELS.find((level) => level > zoom + 1e-9) ?? MAX_ZOOM;
  return [...ZOOM_LEVELS].reverse().find((level) => level < zoom - 1e-9) ?? 1;
}

/** How far the photo may be moved from the middle, each way: half of what its zoomed size has beyond the window, and nothing where it does not reach the edge. A photo turned a quarter is as tall as it is wide. */
function reach(look: Look, room: Size, photo: Size): Point {
  const sideways = Math.abs(look.turn) % 2 === 1;
  const width = (sideways ? photo.height : photo.width) * look.zoom;
  const height = (sideways ? photo.width : photo.height) * look.zoom;
  return { x: Math.max(0, (width - room.width) / 2), y: Math.max(0, (height - room.height) / 2) };
}

/** The look moved back to where the photo still covers the window. */
function held(look: Look, room: Size, photo: Size): Look {
  const limit = reach(look, room, photo);
  return { ...look, x: clamp(look.x, -limit.x, limit.x), y: clamp(look.y, -limit.y, limit.y) };
}

/** The zoom changed about a point of the window (its middle where none is given): the part of the photo that was under the point stays under it. */
function zoomedAbout(look: Look, zoom: number, about: Point | undefined, room: Size): Look {
  const next = clamp(zoom, 1, MAX_ZOOM);
  const x = (about?.x ?? room.width / 2) - room.width / 2;
  const y = (about?.y ?? room.height / 2) - room.height / 2;
  const grown = next / look.zoom;
  return { ...look, zoom: next, x: x - grown * (x - look.x), y: y - grown * (y - look.y) };
}

/** The window the photo is looked at in (the place the page drew the picture in, which is the stage less what the page drew under it), and the photo as it is laid out in it. */
function geometryOf(stage: HTMLElement): { box: DOMRect; room: Size; photo: Size } {
  const place = stage.querySelector<HTMLElement>('.ui-photo-viewer__photo > :first-child') ?? stage;
  const box = place.getBoundingClientRect();
  const room = { width: box.width, height: box.height };
  const picture = stage.querySelector('img');
  return {
    box,
    room,
    photo: picture === null ? room : { width: picture.offsetWidth, height: picture.offsetHeight },
  };
}

/** Two fingers: how far apart they are and the point between them, in the window's own coordinates. */
function measured(fingers: ReadonlyMap<number, Point>): { distance: number; middle: Point } {
  const [a, b] = [...fingers.values()];
  if (a === undefined || b === undefined) return { distance: 0, middle: { x: 0, y: 0 } };
  return {
    distance: Math.hypot(a.x - b.x, a.y - b.y),
    middle: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
  };
}

/** What a turned photo is said to be, by the quarters it is turned from upright. */
const TURNED = ['', 'turned right', 'upside down', 'turned left'] as const;

/**
 * The photo viewer (COMPONENT_PATTERNS, *PhotoViewer*): one photo at a time in a wide dialog, among the others of its grid. **It is generic and decides nothing**: it draws the picture the page gives it, says where
 * the person is ("3 of 12") in a polite status, moves by two buttons the size of the hub floor beside it, by ArrowLeft and ArrowRight and by a swipe of a finger or a pen (a drag across by at least 48px that is clearly
 * more across than down, so that a vertical scroll is left alone), and never goes past either end. It loads **one** neighbour ahead, in the way the person is going, drawn hidden. **Focus, the trap and the
 * return of focus are the dialog's** (a native modal, the control that opened it gets focus back), and Escape asks the page to close. A button that reaches its end and is disabled hands focus to the other, so that
 * a person at the keyboard is never dropped out of the dialog. Under reduced motion nothing animates.
 *
 * **Looking closely** (Run G2, OB-S1-168; the Product Owner's decision D-S7-14 of 24 November 2026): a label is read by zooming into it and, where the parcel was photographed on its side, by turning it. The photo is zoomed
 * by two buttons and by the plus and minus keys (the levels 100, 150, 200, 300, 400 and 600%), by a **pinch** and by a **double tap** (about the fingers and the tap: the part under them stays under them); a
 * zoomed photo is looked around by **dragging** it (a finger, a pen or a mouse) and by the arrow keys, never past its edge; and it is turned by quarters either way by two buttons and by R (Shift and R for the other way).
 * Each photo starts whole and upright, and what is done to it is kept only while it is the one looked at. The viewer holds the zoom, the turn and the place as numbers and says them to the stylesheet on the stage
 * (`--ui-photo-zoom`, `--ui-photo-turn`, `--ui-photo-x`, `--ui-photo-y`), which draws the photo with its own aspect and fits a turned one to the window; the level and the turn are said in a polite status. A swipe turns the page
 * only while the photo is whole: a drag of a zoomed one looks around it.
 *
 * **The window is as tall as the screen allows (`fill`), the controls are the last thing in it and the photo is what gives way**: a photo is given the room that the heading and the controls leave (the stage, and the page's
 * picture is told how much it has, `--ui-photo-room`), so that a button never leaves the screen and does not move from one photo to the next, whatever the photo's size or the length of its description. Previous, the place
 * and Next are one row that does not break, and Close is apart from it.
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
  const stageRef = useRef<HTMLDivElement>(null);
  const pressed = useRef<Way | null>(null);
  const pressedZoom = useRef<'zoom-in' | 'zoom-out' | null>(null);
  const last = items.length - 1;
  const itemKey = items[index]?.key ?? '';

  // What was done to the photo looked at, kept with the photo's key: the same photo keeps its look while the page draws the viewer again, and **another photo starts whole and upright, and what was done to the one
  // left is forgotten** (a photo that was turned is not turned again when the person comes back to it). The state is adjusted while the viewer is drawn, as React says to for a state that follows a prop.
  const [done, setDone] = useState<{ readonly key: string; readonly look: Look }>({
    key: itemKey,
    look: WHOLE,
  });
  if (done.key !== itemKey) setDone({ key: itemKey, look: WHOLE });
  const look = done.key === itemKey ? done.look : WHOLE;
  // The latest look, for a gesture that moves it many times between two drawings.
  const latest = useRef(look);
  useLayoutEffect(() => {
    latest.current = look;
  });
  const change = useCallback(
    (next: Look) => {
      latest.current = next;
      setDone({ key: itemKey, look: next });
    },
    [itemKey],
  );

  // The fingers on the stage, where each is now (in the window's coordinates) and where it went down (on the screen, with the moment): what a pinch, a drag, a tap and a swipe are told from.
  const fingers = useRef(new Map<number, Point>());
  const pressing = useRef(new Map<number, { x: number; y: number; at: number }>());
  const pinch = useRef<{
    readonly look: Look;
    readonly distance: number;
    readonly middle: Point;
  } | null>(null);
  const drag = useRef<{ readonly id: number; readonly x: number; readonly y: number } | null>(null);
  const swiper = useRef<number | null>(null);
  const lastTap = useRef<{ readonly at: number; readonly x: number; readonly y: number } | null>(
    null,
  );
  /** Whether more than one finger has been down since all were up: what is lifted after a pinch is neither a tap nor a swipe. */
  const crowded = useRef(false);
  const [moving, setMoving] = useState(false);

  const go = useCallback(
    (to: Way) => {
      const target = to === 'next' ? index + 1 : index - 1;
      if (target < 0 || target > last) return;
      setWay(to);
      onIndexChange(target);
    },
    [index, last, onIndexChange],
  );

  const zoomBy = useCallback(
    (to: 1 | -1) => {
      const stage = stageRef.current;
      if (stage === null) return;
      const { room, photo } = geometryOf(stage);
      const current = latest.current;
      change(held(zoomedAbout(current, stepped(current.zoom, to), undefined, room), room, photo));
    },
    [change],
  );

  const turnBy = useCallback(
    (to: 1 | -1) => {
      // The places a turned photo reaches are not those it reached upright: it is put back in the middle.
      change({ ...latest.current, turn: latest.current.turn + to, x: 0, y: 0 });
    },
    [change],
  );

  /** Looks around a zoomed photo by a share of the window each way (+1 moves the photo right or down). */
  const slide = useCallback(
    (across: number, down: number) => {
      const stage = stageRef.current;
      if (stage === null) return;
      const { room, photo } = geometryOf(stage);
      const current = latest.current;
      change(
        held(
          {
            ...current,
            x: current.x + across * room.width * KEY_PAN_SHARE,
            y: current.y + down * room.height * KEY_PAN_SHARE,
          },
          room,
          photo,
        ),
      );
    },
    [change],
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
  useLayoutEffect(() => {
    const was = pressedZoom.current;
    pressedZoom.current = null;
    const handTo =
      was === 'zoom-out' && look.zoom <= 1
        ? 'zoom-in'
        : was === 'zoom-in' && look.zoom >= MAX_ZOOM
          ? 'zoom-out'
          : undefined;
    if (handTo !== undefined) {
      root.current?.querySelector<HTMLElement>(`[data-viewer-act="${handTo}"]`)?.focus();
    }
  }, [look.zoom]);

  const item = items[index];
  if (item === undefined) return null;
  const ahead =
    items[way === 'next' ? index + 1 : index - 1] ?? items[way === 'next' ? index - 1 : index + 1];

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    // Control, Alt and Meta with a key are the browser's: Control and plus zoom the page, Alt and an arrow go back.
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      zoomBy(1);
      return;
    }
    if (event.key === '-' || event.key === '_') {
      event.preventDefault();
      zoomBy(-1);
      return;
    }
    if (event.key === 'r' || event.key === 'R') {
      event.preventDefault();
      turnBy(event.shiftKey ? -1 : 1);
      return;
    }
    if (event.shiftKey) return;
    const zoomed = latest.current.zoom > 1;
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      if (zoomed) slide(-1, 0);
      else go('next');
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      if (zoomed) slide(1, 0);
      else go('previous');
    } else if (zoomed && event.key === 'ArrowDown') {
      event.preventDefault();
      slide(0, -1);
    } else if (zoomed && event.key === 'ArrowUp') {
      event.preventDefault();
      slide(0, 1);
    }
  }

  /** WebKit does not focus a button a click lands on, and the keys above are heard where the focus is: after a click on a button the next key would reach the page behind the dialog and not the viewer. What was clicked takes the focus. */
  function onClick(event: MouseEvent<HTMLDivElement>): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest('button');
    if (button !== null && !button.disabled && document.activeElement !== button) button.focus();
  }

  /** Where a pointer is in the window the photo is looked at in. */
  function placeOf(event: PointerEvent<HTMLDivElement>, stage: HTMLElement): Point {
    const { box } = geometryOf(stage);
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  }

  /** The two fingers as a pinch that starts here, from the look the photo has now. */
  function beginPinch(): void {
    const { distance, middle } = measured(fingers.current);
    pinch.current = { look: latest.current, distance, middle };
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>): void {
    const stage = stageRef.current;
    if (stage === null) return;
    // A control the page drew in the stage (a button under the picture) is pressed, not looked through: holding its press would take the click from it.
    const target = event.target;
    if (target instanceof Element && target.closest('button, a, [role="button"]') !== null) return;
    fingers.current.set(event.pointerId, placeOf(event, stage));
    pressing.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
      at: performance.now(),
    });
    try {
      stage.setPointerCapture(event.pointerId);
    } catch {
      // A pointer the browser has already let go of, or an environment with no capture: the moves arrive by the stage all the same.
    }
    if (fingers.current.size >= 2) {
      crowded.current = true;
      swiper.current = null;
      drag.current = null;
      beginPinch();
      setMoving(true);
      return;
    }
    if (latest.current.zoom > 1) {
      // A zoomed photo is looked around by dragging it, with a finger, a pen or a mouse.
      drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
      setMoving(true);
    } else if (event.pointerType !== 'mouse' && event.isPrimary) {
      // The photo whole is swiped to the next, by a finger or a pen: a mouse has buttons and keys.
      swiper.current = event.pointerId;
    }
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>): void {
    const stage = stageRef.current;
    if (stage === null || !fingers.current.has(event.pointerId)) return;
    fingers.current.set(event.pointerId, placeOf(event, stage));
    const { room, photo } = geometryOf(stage);
    const began = pinch.current;
    if (began !== null && fingers.current.size >= 2) {
      // Worked out from where the fingers began, so that the photo goes where they take it and comes back where they come back to: the part under the point between them when they went down stays under it.
      const now = measured(fingers.current);
      const zoom =
        began.distance === 0 ? began.look.zoom : began.look.zoom * (now.distance / began.distance);
      const next = zoomedAbout(began.look, zoom, began.middle, room);
      const grown = next.zoom / began.look.zoom;
      const centre = { x: room.width / 2, y: room.height / 2 };
      change(
        held(
          {
            ...began.look,
            zoom: next.zoom,
            x: now.middle.x - centre.x - grown * (began.middle.x - centre.x - began.look.x),
            y: now.middle.y - centre.y - grown * (began.middle.y - centre.y - began.look.y),
          },
          room,
          photo,
        ),
      );
      return;
    }
    const dragging = drag.current;
    if (dragging?.id === event.pointerId) {
      const current = latest.current;
      change(
        held(
          {
            ...current,
            x: current.x + (event.clientX - dragging.x),
            y: current.y + (event.clientY - dragging.y),
          },
          room,
          photo,
        ),
      );
      drag.current = { id: dragging.id, x: event.clientX, y: event.clientY };
    }
  }

  function onPointerEnd(event: PointerEvent<HTMLDivElement>): void {
    const stage = stageRef.current;
    const press = pressing.current.get(event.pointerId);
    if (!fingers.current.delete(event.pointerId)) return;
    pressing.current.delete(event.pointerId);
    const alone = fingers.current.size === 0;
    if (alone) {
      setMoving(false);
    }
    if (drag.current?.id === event.pointerId) drag.current = null;
    if (pinch.current !== null) {
      // One finger of a pinch is lifted: with two still down the pinch goes on from here, and with one it is over (what that finger does next is a drag, if the photo is zoomed, and no swipe).
      if (fingers.current.size >= 2) beginPinch();
      else pinch.current = null;
    }
    if (crowded.current) {
      if (alone) crowded.current = false;
      return;
    }
    if (stage === null || press === undefined) return;

    // A press that stayed where it was is a tap: two of them close together are a double tap, which zooms to the point tapped, or back out.
    if (Math.hypot(event.clientX - press.x, event.clientY - press.y) < TAP_SLOP) {
      swiper.current = null;
      const before = lastTap.current;
      const now = performance.now();
      if (
        before !== null &&
        now - before.at <= DOUBLE_TAP_MS &&
        Math.hypot(event.clientX - before.x, event.clientY - before.y) <= DOUBLE_TAP_DISTANCE
      ) {
        lastTap.current = null;
        const { box, room, photo } = geometryOf(stage);
        const current = latest.current;
        if (current.zoom > 1) change({ ...current, zoom: 1, x: 0, y: 0 });
        else {
          const at = { x: event.clientX - box.left, y: event.clientY - box.top };
          change(held(zoomedAbout(current, DOUBLE_TAP_ZOOM, at, room), room, photo));
        }
      } else {
        lastTap.current = { at: now, x: event.clientX, y: event.clientY };
      }
      return;
    }

    // A swipe, by the finger that began it, while the photo is whole.
    if (swiper.current !== event.pointerId) return;
    swiper.current = null;
    const across = event.clientX - press.x;
    const down = event.clientY - press.y;
    if (Math.abs(across) < SWIPE_MIN_DISTANCE) return;
    if (Math.abs(across) < Math.abs(down) * SWIPE_DOMINANCE) return;
    go(across < 0 ? 'next' : 'previous');
  }

  function onPointerCancel(): void {
    // The browser took the gesture (a scroll, a system gesture): none of it counts, and nothing is left moving.
    fingers.current.clear();
    pressing.current.clear();
    pinch.current = null;
    drag.current = null;
    swiper.current = null;
    crowded.current = false;
    setMoving(false);
  }

  const description =
    item.detail === undefined && note === undefined ? undefined : (
      <>
        {item.detail === undefined ? null : <p>{item.detail}</p>}
        {note === undefined ? null : <p>{note}</p>}
      </>
    );

  const turned = TURNED[((look.turn % 4) + 4) % 4] ?? '';
  const percent = `${String(Math.round(look.zoom * 100))}%`;
  // Every number of the look is said to the stylesheet, which draws the photo with it: the viewer does not touch the picture.
  const stageStyle = {
    '--ui-photo-zoom': String(look.zoom),
    '--ui-photo-turn': `${String(look.turn * 90)}deg`,
    '--ui-photo-x': `${String(Math.round(look.x * 100) / 100)}px`,
    '--ui-photo-y': `${String(Math.round(look.y * 100) / 100)}px`,
  } as CSSProperties;

  return (
    <Dialog
      open
      size="wide"
      fill
      title={item.label}
      description={description}
      onRequestClose={onClose}
    >
      {/* The keys are heard anywhere in the dialog: the keyboard events of a control inside it reach this box. */}
      <div className="ui-photo-viewer" ref={root} onKeyDown={onKeyDown} onClick={onClick}>
        <div
          className="ui-photo-viewer__stage"
          ref={stageRef}
          style={stageStyle}
          data-quarter={String(Math.abs(look.turn) % 2 === 1)}
          {...(moving ? { 'data-gesture': 'true' } : {})}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerCancel}
          // A mouse that presses the picture and moves would start the browser's own drag of the image, which ends the pointer's events (`pointercancel`) after the first move: the photo is looked around by dragging, so it is never dragged away.
          onDragStart={(event) => {
            event.preventDefault();
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
        <div className="ui-photo-viewer__tools" role="group" aria-label="Look at the photo closely">
          {/* Named as they are drawn, for a screen reader (the label is in the name), and drawn shortly where there is no room for the words. */}
          <Button
            type="button"
            variant="secondary"
            size="lg"
            data-viewer-act="zoom-out"
            aria-label="Zoom out"
            disabled={look.zoom <= 1}
            onClick={() => {
              pressedZoom.current = 'zoom-out';
              zoomBy(-1);
            }}
          >
            <Icon name="zoom-out" />
            <span className="ui-photo-viewer__label">Zoom out</span>
          </Button>
          <p className="ui-photo-viewer__view" aria-live="polite">
            {turned === '' ? percent : `${percent}, ${turned}`}
          </p>
          <Button
            type="button"
            variant="secondary"
            size="lg"
            data-viewer-act="zoom-in"
            aria-label="Zoom in"
            disabled={look.zoom >= MAX_ZOOM}
            onClick={() => {
              pressedZoom.current = 'zoom-in';
              zoomBy(1);
            }}
          >
            <Icon name="zoom-in" />
            <span className="ui-photo-viewer__label">Zoom in</span>
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="lg"
            data-viewer-act="turn-left"
            aria-label="Turn left"
            onClick={() => {
              turnBy(-1);
            }}
          >
            <Icon name="turn-left" />
            <span className="ui-photo-viewer__label">Turn left</span>
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="lg"
            data-viewer-act="turn-right"
            aria-label="Turn right"
            onClick={() => {
              turnBy(1);
            }}
          >
            <Icon name="turn-right" />
            <span className="ui-photo-viewer__label">Turn right</span>
          </Button>
        </div>
        <div className="ui-photo-viewer__controls">
          {items.length > 1 ? (
            <div className="ui-photo-viewer__nav">
              {/* Named in full for a screen reader and drawn shortly, so that the row fits a phone; the name holds the words that are drawn (the label in the name). */}
              <Button
                type="button"
                variant="secondary"
                size="lg"
                data-viewer-act="previous"
                aria-label="Previous photo"
                disabled={index === 0}
                onClick={() => {
                  pressed.current = 'previous';
                  go('previous');
                }}
              >
                <Icon name="previous" />
                <span className="ui-photo-viewer__label">Previous</span>
              </Button>
              <p className="ui-photo-viewer__position" role="status" aria-live="polite">
                <VisuallyHidden>{`${item.label}, `}</VisuallyHidden>
                {`${String(index + 1)} of ${String(items.length)}`}
              </p>
              <Button
                type="button"
                variant="secondary"
                size="lg"
                data-viewer-act="next"
                aria-label="Next photo"
                disabled={index === last}
                onClick={() => {
                  pressed.current = 'next';
                  go('next');
                }}
              >
                <span className="ui-photo-viewer__label">Next</span>
                <Icon name="next" />
              </Button>
            </div>
          ) : null}
          <Button type="button" variant="secondary" size="lg" data-initial-focus onClick={onClose}>
            Close the photo
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
