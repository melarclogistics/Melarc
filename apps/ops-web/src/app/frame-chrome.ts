import { createContext, useContext, useLayoutEffect } from 'react';

/**
 * The place in the frame beside the main content where a layout route may draw its own chrome (the authenticated Ops shell draws its side
 * menu there). It is the element itself, or null until the frame has put it in the page. The neutral frame offers it to any layout and fills
 * it with nothing: that a pre-authentication page shows no navigation is a fact of its route tree, since only the shell draws into it.
 */
export const FrameChromeContext = createContext<HTMLElement | null>(null);

export function useFrameChrome(): HTMLElement | null {
  return useContext(FrameChromeContext);
}

/**
 * The three layouts of the application (DESIGN_SYSTEM section 13.1), chosen by the route tree and never by the page: the **neutral** frame
 * (a banner above the main content: pages outside the two below, such as the not-found page), the **sidebar** layout of the authenticated
 * Ops shell (a menu docked at the side, full height, and no banner: the menu carries the product's name), and the **split** layout of the
 * pre-sign-in screens (a panel of imagery beside the form, full height, and no banner: the form carries the logo).
 */
export type FrameLayout = 'neutral' | 'sidebar' | 'split';

/** What a layout route may ask of the frame it sits in. */
export interface FrameControls {
  /** Chooses the layout the frame is drawn in. A layout route sets its own while it is mounted and the frame goes back to neutral after it. */
  readonly setLayout: (layout: FrameLayout) => void;
  /** Makes the main content inert, for as long as a menu that slid in over it is open, so that the page behind it cannot be reached. */
  readonly setMainInert: (inert: boolean) => void;
}

const NO_CONTROLS: FrameControls = {
  setLayout: () => undefined,
  setMainInert: () => undefined,
};

/** Provided by `AppFrame`. Outside a frame (a component rendered alone in a test) the controls do nothing. */
export const FrameControlsContext = createContext<FrameControls>(NO_CONTROLS);

export function useFrameControls(): FrameControls {
  return useContext(FrameControlsContext);
}

/**
 * Draws the frame in `layout` for as long as the calling layout route is mounted, and in the neutral one again when it is not. It is set in
 * a layout effect, in the commit that puts the layout's own content in the page and before the browser paints it, so the page is never
 * drawn in a layout it has just left.
 */
export function useFrameLayout(layout: Exclude<FrameLayout, 'neutral'>, active = true): void {
  const { setLayout } = useFrameControls();
  useLayoutEffect(() => {
    if (!active) return;
    setLayout(layout);
    return () => {
      setLayout('neutral');
    };
  }, [layout, active, setLayout]);
}
