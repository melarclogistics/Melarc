import { useEffect, useId, useRef, useState } from 'react';
import { useLocation } from 'react-router';

import { BrandLockup } from '../brand/BrandLockup';
import { Icon } from '../ui/icon/Icon';
import { IconButton } from '../ui/icon-button/IconButton';
import { PrimaryNavigation, type NavigationItem } from '../PrimaryNavigation';
import './side-menu.css';

/** Who is signed in, as the account card of the menu says it. Both are labels from the session; neither grants anything. */
export interface SideMenuAccount {
  /** The person's display name, or null when the principal has none. */
  readonly name: string | null;
  /** One short line under the name: where they act (a hub's name, or how many hubs), or null when the session lists none. */
  readonly detail: string | null;
}

/** Up to two letters for the avatar: the first of the first and of the last word of the name. Nothing when the name has no letter. */
export function initialsOf(name: string | null): string {
  const words = (name ?? '').split(/\s+/).filter((word) => /\p{L}/u.test(word));
  const first = words[0]?.match(/\p{L}/u)?.[0] ?? '';
  const last = words.length > 1 ? (words.at(-1)?.match(/\p{L}/u)?.[0] ?? '') : '';
  return `${first}${last}`.toUpperCase();
}

/**
 * The side menu of the authenticated Ops shell (COMPONENT_PATTERNS section 12.6; the Product Owner's decision of 25 October 2026: the
 * Ops Portal is an application and not a website, so its navigation is a menu at the side and not a band at the top).
 *
 * - **On a wide screen** it is docked at the left, on Ink, full height. A button at its head collapses it to a rail of icons and expands it
 *   again (`aria-expanded`); collapsed, every entry keeps its name (the label is visually hidden, not removed) and a `title`. The choice is
 *   kept for as long as the page lives and no longer: nothing is written to web storage (an application rule).
 * - **On a narrow screen** it is hidden, and a slim bar with a menu button stands in its place. The button slides the menu in over the page; the
 *   page behind it is inert while it is open (`onOpenChange`), Escape, the scrim, the close button and following a link close it, and focus
 *   goes to the close button on opening and back to the menu button on closing. A navigation closes it by itself and leaves focus to the new
 *   page's heading, which the frame moves it to.
 * - **Its head** names the product in plain text beside the mark (the wordmark is never redrawn); **its foot** is the account card: the
 *   person's initials, name and where they act, and an icon button that signs them out. It is a presentation of what it is given and
 *   knows nothing of sessions, permissions or routes: the shell decides what to put in it.
 */
export function SideMenu({
  items,
  account,
  signingOut,
  onSignOut,
  onOpenChange,
}: {
  readonly items: readonly NavigationItem[];
  readonly account: SideMenuAccount;
  /** A sign-out is under way: the button keeps its name and ignores activation. */
  readonly signingOut: boolean;
  readonly onSignOut: () => void;
  /** Told whenever the sliding menu opens or closes, so that the frame can make the page behind it inert. */
  readonly onOpenChange?: (open: boolean) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [open, setOpen] = useState(false);
  // Following a link, or any other change of page, closes the sliding menu: the state is adjusted while rendering, as React advises,
  // and not in an effect, so that no frame is drawn with the menu open over the page it was left for.
  const { pathname } = useLocation();
  const [page, setPage] = useState(pathname);
  if (page !== pathname) {
    setPage(pathname);
    setOpen(false);
  }
  const panelId = useId();
  const navId = useId();
  const openButton = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    onOpenChange?.(open);
    return () => {
      onOpenChange?.(false);
    };
  }, [open, onOpenChange]);

  // Opening puts focus on the way out of the menu, so that a keyboard user is inside it and can leave it.
  useEffect(() => {
    if (open) closeButton.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      openButton.current?.focus();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const close = (): void => {
    setOpen(false);
    openButton.current?.focus();
  };

  const initials = initialsOf(account.name);

  return (
    <div className="ui-side-menu" data-collapsed={collapsed} data-open={open}>
      <header className="ui-side-menu__bar">
        <IconButton
          ref={openButton}
          type="button"
          variant="inverse"
          icon="menu"
          label="Open menu"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => {
            setOpen(true);
          }}
        />
        <BrandLockup />
      </header>

      {open ? <div className="ui-side-menu__scrim" aria-hidden="true" onClick={close} /> : null}

      <aside id={panelId} className="ui-side-menu__panel" aria-label="Main menu">
        <div className="ui-side-menu__head">
          <BrandLockup />
          <span className="ui-side-menu__collapse">
            <IconButton
              type="button"
              variant="inverse"
              icon={collapsed ? 'expand-menu' : 'collapse-menu'}
              label={collapsed ? 'Expand menu' : 'Collapse menu'}
              aria-expanded={!collapsed}
              aria-controls={navId}
              onClick={() => {
                setCollapsed(!collapsed);
              }}
            />
          </span>
          <span className="ui-side-menu__close">
            <IconButton
              ref={closeButton}
              type="button"
              variant="inverse"
              icon="close"
              label="Close menu"
              onClick={close}
            />
          </span>
        </div>

        <PrimaryNavigation items={items} collapsed={collapsed} id={navId} />

        <div className="ui-side-menu__account" role="group" aria-label="Your account">
          <span className="ui-side-menu__avatar" aria-hidden="true">
            {initials === '' ? <Icon name="account" /> : initials}
          </span>
          <span className="ui-side-menu__who">
            <span className="ui-side-menu__name">{account.name ?? 'Signed in'}</span>
            {account.detail === null ? null : (
              <span className="ui-side-menu__detail">{account.detail}</span>
            )}
          </span>
          <IconButton
            type="button"
            variant="inverse"
            icon="sign-out"
            label="Sign out"
            loading={signingOut}
            onClick={onSignOut}
          />
        </div>
      </aside>
    </div>
  );
}
