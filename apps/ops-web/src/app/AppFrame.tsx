import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Outlet, useLocation } from 'react-router';

import logoDarkUrl from '../assets/brand/melarc-logo-dark.svg?no-inline';
import logoUrl from '../assets/brand/melarc-logo-primary.svg?no-inline';
import { SkipLink } from '../components/SkipLink';
import { useResolvedTheme } from '../platform/theme/use-resolved-theme';
import {
  FrameChromeContext,
  FrameControlsContext,
  FrameTopBarContext,
  type FrameControls,
  type FrameLayout,
} from './frame-chrome';
import { useTopBarClearance } from './top-bar-clearance';

const MAIN_CONTENT_ID = 'main-content';

/**
 * The frame every page sits in: a skip link, a banner and the main landmark. It carries no navigation,
 * user menu or session data itself, because the Ops Portal's pre-authentication pages must render "no navigation, no
 * user menu, no data" (surfaces/ops-portal.md §7). Beside the main content it keeps an empty place
 * (`FrameChromeContext`) that a layout route may draw into, and another over the main content (`FrameTopBarContext`): the authenticated Ops
 * shell draws its sidebar into the first and its top bar into the second, and only the routes under the shell do, so a page outside it has
 * nothing in either place.
 *
 * It is drawn in one of three layouts (`FrameLayout`), which the route tree chooses through `useFrameLayout` and no page does: the
 * neutral one (the banner above the main content), the sidebar layout of the shell (the sidebar at the side, full height, and over the main
 * content its top bar, which is the page's banner) and the split screen of the pre-sign-in pages (imagery beside the form, the banner above the form's
 * half). The landmarks, the skip link and the move of focus are the frame's in all three.
 *
 * After a client-side navigation focus moves to the new page's heading, so assistive technology
 * announces the page change. It does not move on first load.
 *
 * The move is made in a layout effect, in the very commit that puts the new page in the document and before the browser paints it. A passive
 * effect runs after the paint, and in that gap the new page is on the screen and can be typed into while focus is still where the old page left
 * it: the first keystrokes of a quick typist, or of a password manager, then go to the heading instead of the field (S0.43: a field filled in
 * WebKit typed into nothing one run in eight).
 */
export function AppFrame() {
  const mainRef = useRef<HTMLElement>(null);
  const [chrome, setChrome] = useState<HTMLElement | null>(null);
  const [topBar, setTopBar] = useState<HTMLElement | null>(null);
  const [layout, setLayout] = useState<FrameLayout>('neutral');
  const theme = useResolvedTheme();
  const controls = useMemo<FrameControls>(() => ({ setLayout }), []);
  const { pathname } = useLocation();
  const previousPathname = useRef(pathname);
  // The sticky bar of the sidebar layout is as tall as its controls need, and the page is scrolled clear of all of it, not of its first row.
  useTopBarClearance(topBar, layout === 'sidebar');

  useLayoutEffect(() => {
    if (previousPathname.current === pathname) return;
    previousPathname.current = pathname;
    const main = mainRef.current;
    if (main === null) return;
    const heading = main.querySelector<HTMLElement>('h1');
    if (heading !== null) {
      heading.focus();
      return;
    }
    // The page is not there yet: a guard is asking who is signed in, or the page's code is on its way. Focus waits on the
    // content, so a keyboard user is not dropped at the top of the document, and goes to the heading when it arrives,
    // unless the person has moved on in the meantime.
    main.focus();
    const observer = new MutationObserver(() => {
      const arrived = main.querySelector<HTMLElement>('h1');
      if (arrived === null) return;
      observer.disconnect();
      if (document.activeElement === main) arrived.focus();
    });
    observer.observe(main, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
    };
  }, [pathname]);

  return (
    <FrameChromeContext value={chrome}>
      <FrameTopBarContext value={topBar}>
        <FrameControlsContext value={controls}>
          <div className={`app-frame app-frame--${layout}`}>
            <SkipLink targetId={MAIN_CONTENT_ID} />
            {layout !== 'sidebar' ? (
              <header className="app-header">
                {/* The logo identifies the product and is not a link (DESIGN_SYSTEM 26.1). It is the only thing that says "Melarc"
                  here, so it carries the name; the text beside it says which application this is. On a dark ground it is the approved
                  all-white lockup (BRAND_FOUNDATION 4.7), chosen by the theme that applies (the root's `data-theme`, then the system
                  setting, as tokens.css does): the black wordmark of the primary logo would vanish there. One image, so the name is read once. */}
                <img
                  className="app-logo"
                  src={theme === 'dark' ? logoDarkUrl : logoUrl}
                  alt="Melarc Logistics"
                />
                <p className="app-name">Ops Portal</p>
              </header>
            ) : null}
            <div ref={setChrome} className="app-chrome" />
            <div ref={setTopBar} className="app-topbar" />
            <main
              id={MAIN_CONTENT_ID}
              ref={mainRef}
              className={`app-main app-main--${layout}`}
              tabIndex={-1}
            >
              <Outlet />
            </main>
          </div>
        </FrameControlsContext>
      </FrameTopBarContext>
    </FrameChromeContext>
  );
}
