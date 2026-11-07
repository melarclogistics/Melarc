import { Link } from 'react-router';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../primitives/dropdown-menu';
import { Icon } from '../icon/Icon';
import type { IconName } from '../icon/icons';
import { Spinner } from '../loading/Spinner';
import { Initials } from './Initials';
import { isThemeValue, THEME_OPTIONS, type ThemeValue } from './theme-options';
import './top-bar.css';

/** A personal page of the account menu (the trusted browsers): a link to a page of its own. */
export interface AccountPage {
  readonly to: string;
  readonly label: string;
  readonly icon: IconName;
}

export interface AccountMenuProps {
  /** The person's display name, or null when the principal has none. */
  readonly name: string | null;
  /** Where they act (a hub's name, or how many hubs), or null when the session lists none. */
  readonly detail: string | null;
  readonly pages: readonly AccountPage[];
  readonly theme: { readonly choice: ThemeValue; readonly onChoose: (choice: ThemeValue) => void };
  /** A sign-out is under way: the item keeps its place and says so, and ignores another selection. */
  readonly signingOut: boolean;
  readonly onSignOut: () => void;
  /** Controlled, so that the shell can close the menu when a sign-out that did not finish says so at the top of the page. */
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onCloseAutoFocus?: (event: Event) => void;
}

/**
 * The account menu of the top bar (surfaces/ops-portal.md sections 4 and 7): an avatar button that opens the person's own things in one place:
 * who is signed in and where they act, the personal pages (the trusted browsers), the choice of theme (System, Light or Dark) and **sign-out**,
 * which every signed-in screen carries and which is the one action that ends the session.
 *
 * Sign-out keeps the menu open and says "Signing out…" while it is under way (a selection that closed the menu would take the progress with it), and
 * ignores a second selection. What it means when it did not finish is the page's, told at the top of the page. A page called "Profile and hubs" is
 * not offered: no such page exists, and a page that is not built has no entry.
 */
export function AccountMenu({
  name,
  detail,
  pages,
  theme,
  signingOut,
  onSignOut,
  open,
  onOpenChange,
  onCloseAutoFocus,
}: AccountMenuProps) {
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button type="button" className="ui-account" aria-label="Account menu">
          <Initials name={name} className="ui-account__avatar" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={8}
        className="ui-menu ui-menu--account"
        {...(onCloseAutoFocus === undefined ? {} : { onCloseAutoFocus })}
      >
        <DropdownMenuLabel className="ui-menu__who">
          <span className="ui-menu__name">{name ?? 'Signed in'}</span>
          {detail === null ? null : <span className="ui-menu__detail">{detail}</span>}
        </DropdownMenuLabel>
        {pages.length === 0 ? null : (
          <>
            <DropdownMenuSeparator />
            {pages.map((page) => (
              <DropdownMenuItem key={page.to} asChild>
                <Link to={page.to}>
                  <Icon name={page.icon} size="sm" />
                  {page.label}
                </Link>
              </DropdownMenuItem>
            ))}
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="ui-menu__section">Theme</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={theme.choice}
          onValueChange={(value) => {
            if (isThemeValue(value)) theme.onChoose(value);
          }}
        >
          {THEME_OPTIONS.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value}>
              <Icon name={option.icon} size="sm" />
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          aria-busy={signingOut ? true : undefined}
          aria-disabled={signingOut ? true : undefined}
          onSelect={(event) => {
            // The menu stays open while the sign-out is under way, and a second selection does nothing.
            event.preventDefault();
            if (!signingOut) onSignOut();
          }}
        >
          {signingOut ? <Spinner /> : <Icon name="sign-out" size="sm" />}
          {signingOut ? 'Signing out…' : 'Sign out'}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
