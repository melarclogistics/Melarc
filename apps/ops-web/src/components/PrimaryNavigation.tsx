import { Link, useLocation } from 'react-router';

import { CountBadge } from './ui/count-badge/CountBadge';
import { Icon } from './ui/icon/Icon';
import type { IconName } from './ui/icon/icons';
import './primary-navigation.css';

export interface NavigationItem {
  readonly to: string;
  readonly label: string;
  /** The icon of the entry: every entry has one, and the same meaning has the same picture everywhere (DESIGN_SYSTEM section 24). */
  readonly icon: IconName;
  /**
   * The count of the work waiting at this entry, when the server stated one (task C1): the number, and what it counts, said after it. Left out
   * when there is none to draw: a count that is still being read, was not given or could not be read is never drawn as `0`.
   */
  readonly badge?: { readonly count: number; readonly meaning: string };
}

/**
 * The entry that is current at an address: the most specific one the address is at or under. An entry is at or under a path when the path
 * is its own or begins with it and a slash (so `/admin/staffing` is not under `/admin/staff`), and the root entry is current only on the
 * root page. Where one entry lies under another ("Add a staff profile" under "Staff") the deeper one wins, and a page that belongs to an
 * entry without being one (a person's profile, under "Staff") keeps that entry current.
 */
export function currentItem(
  items: readonly NavigationItem[],
  pathname: string,
): NavigationItem | undefined {
  let best: NavigationItem | undefined;
  for (const item of items) {
    const at = pathname === item.to;
    const under = item.to !== '/' && pathname.startsWith(`${item.to}/`);
    if ((at || under) && (best === undefined || item.to.length > best.to.length)) best = item;
  }
  return best;
}

/**
 * The primary navigation landmark, drawn as a vertical list of an icon and a label (COMPONENT_PATTERNS section 12.6). It renders nothing
 * when there is nothing to navigate to, rather than an empty landmark. The one entry that is current is marked with aria-current
 * (`currentItem`) and by its weight and a filled item, never by colour alone. Which entries exist, and for whom, is decided by the route
 * registry from the permission keys the session holds (`entriesFor`); this draws the list it is given. The Ops Portal's
 * pre-authentication pages carry no navigation at all (surfaces/ops-portal.md §7).
 *
 * When the menu around it is collapsed to its icons the labels stay in the document, visually hidden, so every entry keeps its name; the
 * `title` repeats it for a pointer user. **A count beside an entry** (`badge`, task C1) is drawn after the label, and at the corner of the icon on
 * the rail; it is the server's figure for that entry's queue, and an entry the summary says nothing of draws none.
 */
export function PrimaryNavigation({
  items,
  collapsed = false,
  id,
}: {
  readonly items: readonly NavigationItem[];
  /** The menu is collapsed to its icons (wide screens only: the CSS ignores it where the menu slides in). */
  readonly collapsed?: boolean;
  readonly id?: string;
}) {
  const { pathname } = useLocation();
  if (items.length === 0) return null;
  const current = currentItem(items, pathname);
  return (
    <nav aria-label="Primary" className="ui-primary-nav" id={id}>
      <ul>
        {items.map((item) => (
          <li key={item.to}>
            <Link
              to={item.to}
              className="ui-primary-nav__link"
              {...(collapsed
                ? {
                    title:
                      item.badge === undefined
                        ? item.label
                        : `${item.label}: ${String(item.badge.count)} ${item.badge.meaning}`,
                  }
                : {})}
              {...(item === current ? { 'aria-current': 'page' as const } : {})}
            >
              <Icon name={item.icon} />
              <span className="ui-primary-nav__label">{item.label}</span>
              {item.badge === undefined ? null : (
                <>
                  {/* A space between the words, for the name of the entry ("Staff 12 waiting"); in the flex row it is not drawn. */}{' '}
                  <span className="ui-primary-nav__count">
                    <CountBadge
                      count={item.badge.count}
                      meaning={item.badge.meaning}
                      surface="shell"
                    />
                  </span>
                </>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
