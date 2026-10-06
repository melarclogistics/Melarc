import { NavLink } from 'react-router';

export interface NavigationItem {
  readonly to: string;
  readonly label: string;
}

/**
 * The primary navigation landmark. It renders nothing when there is nothing to navigate to, rather than
 * an empty landmark. The router marks an entry with aria-current when the location is at or under its
 * path; the root entry is current only on the root page. Which entries exist, and for whom, is decided
 * by the permissions a later slice introduces; the Ops Portal's pre-authentication pages carry no
 * navigation at all (surfaces/ops-portal.md §7).
 */
export function PrimaryNavigation({ items }: { readonly items: readonly NavigationItem[] }) {
  if (items.length === 0) return null;
  return (
    <nav aria-label="Primary">
      <ul>
        {items.map((item) => (
          <li key={item.to}>
            <NavLink to={item.to}>{item.label}</NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
