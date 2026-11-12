import type { ReactNode, Ref } from 'react';

import { IconButton } from '../icon-button/IconButton';
import './top-bar.css';

/**
 * The top bar of the authenticated Ops shell (surfaces/ops-portal.md section 4): 56px high, over the page beside the sidebar, the banner of every
 * signed-in screen. It lays out what it is given and decides nothing about any of it: the hub switcher at the start, the search after it, and
 * the theme control, the New menu and the account menu at the end. On a narrow screen, where the sidebar is a sheet, `menu` gives it the button
 * that opens the sheet, in the first place of the bar.
 */
export function TopBar({
  menu,
  menuButtonRef,
  hub,
  search,
  end,
}: {
  /** The button that opens the sidebar's sheet: given on a narrow screen only. */
  readonly menu?: {
    readonly open: boolean;
    readonly onOpen: () => void;
  };
  /** The ref of that button, which is the shell's and gives focus back to it when the sheet closes. A prop of its own: a ref in the object above would make every read of it a read of a ref. */
  readonly menuButtonRef?: Ref<HTMLButtonElement>;
  readonly hub: ReactNode;
  readonly search: ReactNode;
  readonly end: ReactNode;
}) {
  return (
    <header className="ui-topbar">
      <div className="ui-topbar__start">
        {menu === undefined ? null : (
          <IconButton
            ref={menuButtonRef}
            type="button"
            variant="bare"
            icon="menu"
            label="Open menu"
            aria-haspopup="dialog"
            aria-expanded={menu.open}
            onClick={menu.onOpen}
          />
        )}
        {hub}
      </div>
      <div className="ui-topbar__search">{search}</div>
      <div className="ui-topbar__end">{end}</div>
    </header>
  );
}
