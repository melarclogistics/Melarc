import { useId, type MouseEvent, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router';

import logoUrl from '../../../assets/brand/melarc-logo-dark.svg?no-inline';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../../primitives/tooltip';
import { BrandLockup } from '../../brand/BrandLockup';
import { CountBadge, formatCount } from '../count-badge/CountBadge';
import { Icon } from '../icon/Icon';
import { IconButton } from '../icon-button/IconButton';
import { currentEntry } from './current-entry';
import { Initials } from './Initials';
import type { SidebarAccount, SidebarEntry, SidebarGroup } from './sidebar-types';
import './sidebar.css';

/** How long a pointer rests on an icon of the rail before its name is shown. The same for every tooltip of the portal. */
const TOOLTIP_DELAY_MS = 300;
const TOOLTIP_OFFSET = 8;

export interface SidebarProps {
  readonly groups: readonly SidebarGroup[];
  readonly account: SidebarAccount;
  /** Drawn as the rail: icons only, each entry's name in a tooltip and, for a screen reader, still in the entry. */
  readonly rail: boolean;
  /**
   * The control that switches between the rail and the full sidebar. It is the docked sidebar's, and is left out where the sidebar is the content
   * of a sheet, which has its own way out (`closeControl`).
   */
  readonly onToggleRail?: () => void;
  /** The way out of a sheet: a button the sheet gives, drawn in the head. */
  readonly closeControl?: ReactNode;
  /**
   * Called when the person follows an entry with a plain click (or the Enter key on it), **at the click and not when the page has changed**: the sheet of a
   * narrow screen closes then (audit B7, 7 November 2026), so that it is gone as the person acts and does not wait for a page that is still loading.
   * A click with a modifier (a new tab, a new window) leaves the page where it is and so does not call it.
   */
  readonly onNavigate?: () => void;
  /**
   * Where the sidebar is: `docked` is the landmark beside the page (an `aside` named "Main menu"), `sheet` is the content of the dialog that a
   * narrow screen opens, which is named by the dialog.
   */
  readonly placement: 'docked' | 'sheet';
}

/** What a tooltip of the rail says: the name of the entry and, after it, what its count counts. */
const tipOf = (entry: SidebarEntry): string =>
  entry.badge === undefined
    ? entry.label
    : `${entry.label}: ${formatCount(entry.badge.count)} ${entry.badge.meaning}`;

/** Whether a click goes to the entry in this tab: the primary button and no key held (the browser opens a new tab or window for the others). */
const isPlainClick = (event: MouseEvent): boolean =>
  event.button === 0 && !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey);

function EntryLink({
  entry,
  current,
  rail,
  onNavigate,
}: {
  readonly entry: SidebarEntry;
  readonly current: boolean;
  readonly rail: boolean;
  readonly onNavigate: (() => void) | undefined;
}) {
  const link = (
    <Link
      to={entry.to}
      className="ui-sidebar__link"
      {...(current ? { 'aria-current': 'page' as const } : {})}
      {...(onNavigate === undefined
        ? {}
        : {
            onClick: (event: MouseEvent<HTMLAnchorElement>) => {
              if (isPlainClick(event)) onNavigate();
            },
          })}
    >
      <Icon name={entry.icon} className="ui-sidebar__icon" />
      <span className="ui-sidebar__label">{entry.label}</span>
      {entry.badge === undefined ? null : (
        <>
          {/* A space between the words, for the name of the entry ("Staff 12 waiting"); in the flex row it is not drawn. */}{' '}
          <span className="ui-sidebar__count">
            <CountBadge count={entry.badge.count} meaning={entry.badge.meaning} surface="shell" />
          </span>
        </>
      )}
    </Link>
  );
  if (!rail) return link;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right" sideOffset={TOOLTIP_OFFSET}>
        {tipOf(entry)}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The sidebar of the authenticated Ops shell (surfaces/ops-portal.md section 4; COMPONENT_PATTERNS section 12.6): Ink in both themes, the
 * all-white lockup at its head, the entries in the groups the session may use, each an icon, a name and, where the server states one, a count; the
 * person at its foot. **It presents what it is given and knows nothing of sessions, permissions or routes**: the shell decides what to put in it.
 *
 * - **The current entry is a solid crimson fill** with white bold text and `aria-current="page"`, and so is never marked by colour alone; focus on Ink
 *   uses the inverse ring, white.
 * - **Expanded it is 248px wide; as the rail it is 64px**: the name of an entry is then in a tooltip (and stays in the entry for a screen reader),
 *   the lockup is the symbol on a white tile, a count sits under the icon inside its entry, and a group's heading gives way to a rule. The shell chooses
 *   which (the rail below 1280px and when the person asks), and the button at the head asks for the other.
 * - **A group is a list named by its heading**, so that a screen reader says "Today, list, 2 items" and no heading is added to the page's outline.
 * - A count that is loading, missing or failed is not given, so none is drawn: it is never drawn as `0` (`AC-QSUM-07`).
 */
export function Sidebar({
  groups,
  account,
  rail,
  onToggleRail,
  closeControl,
  onNavigate,
  placement,
}: SidebarProps) {
  const { pathname } = useLocation();
  const navId = useId();
  const current = currentEntry(
    groups.flatMap((group) => group.entries),
    pathname,
  )?.to;

  const content = (
    <>
      <div className="ui-sidebar__head">
        {rail ? (
          <BrandLockup />
        ) : (
          /* The logo identifies the product and is not a link (DESIGN_SYSTEM section 26.1). On Ink it is the approved all-white lockup, in both themes. */
          <img className="ui-sidebar__logo" src={logoUrl} alt="Melarc Logistics" />
        )}
        {onToggleRail === undefined ? null : (
          <span className="ui-sidebar__toggle">
            <IconButton
              type="button"
              variant="inverse"
              icon={rail ? 'expand-menu' : 'collapse-menu'}
              label={rail ? 'Expand menu' : 'Collapse menu'}
              aria-expanded={!rail}
              aria-controls={navId}
              onClick={onToggleRail}
            />
          </span>
        )}
        {closeControl === undefined ? null : (
          <span className="ui-sidebar__close">{closeControl}</span>
        )}
      </div>

      {groups.length === 0 ? null : (
        <TooltipProvider delayDuration={TOOLTIP_DELAY_MS}>
          <nav aria-label="Primary" id={navId} className="ui-sidebar__nav">
            {groups.map((group) => {
              const headingId = `${navId}-${group.id}`;
              return (
                <div key={group.id} className="ui-sidebar__group">
                  <p id={headingId} className="ui-sidebar__heading">
                    {group.label}
                  </p>
                  <ul aria-labelledby={headingId}>
                    {group.entries.map((entry) => (
                      <li key={entry.to}>
                        <EntryLink
                          entry={entry}
                          current={entry.to === current}
                          rail={rail}
                          onNavigate={onNavigate}
                        />
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </nav>
        </TooltipProvider>
      )}

      <div className="ui-sidebar__account" role="group" aria-label="Your account">
        <Initials name={account.name} className="ui-sidebar__avatar" />
        <span className="ui-sidebar__who">
          <span className="ui-sidebar__name">{account.name ?? 'Signed in'}</span>
          {account.detail === null ? null : (
            <span className="ui-sidebar__detail">{account.detail}</span>
          )}
        </span>
      </div>
    </>
  );

  return placement === 'docked' ? (
    <aside className="ui-sidebar" data-rail={rail} data-placement="docked" aria-label="Main menu">
      {content}
    </aside>
  ) : (
    <div className="ui-sidebar" data-rail={rail} data-placement="sheet">
      {content}
    </div>
  );
}
