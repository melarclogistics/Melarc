import { useEffect, useRef } from 'react';
import { Outlet, useLocation } from 'react-router';

import { SkipLink } from '../components/SkipLink';

const MAIN_CONTENT_ID = 'main-content';

/**
 * The frame every page sits in: a skip link, a banner and the main landmark. It carries no navigation,
 * user menu or session data, because this build has no session, and the Ops Portal's pre-authentication
 * pages must render "no navigation, no user menu, no data" (surfaces/ops-portal.md §7). The signed-in
 * shell is a separate layout the identity slice adds around the signed-in routes only.
 *
 * After a client-side navigation focus moves to the new page's heading, so assistive technology
 * announces the page change. It does not move on first load.
 */
export function AppFrame() {
  const mainRef = useRef<HTMLElement>(null);
  const { pathname } = useLocation();
  const previousPathname = useRef(pathname);

  useEffect(() => {
    if (previousPathname.current === pathname) return;
    previousPathname.current = pathname;
    const heading = mainRef.current?.querySelector<HTMLElement>('h1');
    (heading ?? mainRef.current)?.focus();
  }, [pathname]);

  return (
    <>
      <SkipLink targetId={MAIN_CONTENT_ID} />
      <header className="app-header">
        <p className="app-name">Melarc Ops Portal</p>
      </header>
      <main id={MAIN_CONTENT_ID} ref={mainRef} className="app-main" tabIndex={-1}>
        <Outlet />
      </main>
    </>
  );
}
