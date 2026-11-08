import { createPortal } from 'react-dom';
import { Outlet, useLocation } from 'react-router';

import { AuthArt } from '../../../components/auth-art/AuthArt';
import { useFrameChrome, useFrameLayout } from '../../frame-chrome';
import { artFor } from './auth-art';

/**
 * The layout route of the pre-sign-in screens: it asks the frame for the **split-screen** layout (`useFrameLayout`; DESIGN_SYSTEM section 13.1)
 * and draws the imagery half into the frame's place beside the main content, so the form half is the frame's own banner (the logo) and main
 * landmark and nothing about the frame's landmarks, skip link or move of focus changes. It draws no navigation, no user menu and nothing
 * loaded for a signed-in user: the imagery is decorative and holds no link or control (`pre-sign-in-neutral-frame.test.tsx`).
 *
 * Under 64rem the imagery is not drawn at all (the stylesheet hides its place) and the screen is the form alone, in one column.
 */
export function AuthSplitLayout() {
  const slot = useFrameChrome();
  const { pathname } = useLocation();
  useFrameLayout('split');
  return (
    <>
      {slot === null ? null : createPortal(<AuthArt src={artFor(pathname)} />, slot)}
      <Outlet />
    </>
  );
}
