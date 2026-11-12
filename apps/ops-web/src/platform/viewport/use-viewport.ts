import { useSyncExternalStore } from 'react';

/**
 * The size of the window as the shell's navigation tells it (DESIGN_SYSTEM section 12; surfaces/ops-portal.md section 4):
 *
 * - `narrow`: under 48rem (768px). The sidebar is a sheet that a button of the top bar opens.
 * - `medium`: from 48rem to under 80rem (1280px). The sidebar is the 64px rail, unless the person asks for it expanded.
 * - `wide`: from 80rem. The sidebar is expanded, unless the person asks for the rail.
 *
 * The limits are in rem, as the stylesheets' are, so that enlarged text moves them the way it moves a layout. They are the stylesheets' limits and
 * not a second set: `base.css` and the top bar hide and show by the same 47.9375rem, and the sidebar's width is the component's own by the
 * attribute it is given (`data-rail`), never by a media query of its own that this could disagree with.
 */
export type Viewport = 'narrow' | 'medium' | 'wide';

const NARROW = '(max-width: 47.9375rem)';
const WIDE = '(min-width: 80rem)';

const canAskTheWindow = (): boolean => typeof window.matchMedia === 'function';

/** The size now. Where the window cannot be asked (a test with no layout engine) it is wide: the full sidebar, as a desktop opens it. */
export function currentViewport(): Viewport {
  if (!canAskTheWindow()) return 'wide';
  if (window.matchMedia(NARROW).matches) return 'narrow';
  return window.matchMedia(WIDE).matches ? 'wide' : 'medium';
}

function subscribe(onChange: () => void): () => void {
  if (!canAskTheWindow()) return () => undefined;
  const lists = [window.matchMedia(NARROW), window.matchMedia(WIDE)];
  for (const list of lists) list.addEventListener('change', onChange);
  return () => {
    for (const list of lists) list.removeEventListener('change', onChange);
  };
}

/** The size of the window, kept up to date as it is resized or zoomed. */
export function useViewport(): Viewport {
  return useSyncExternalStore(subscribe, currentViewport, (): Viewport => 'wide');
}
