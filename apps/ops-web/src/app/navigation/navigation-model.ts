import type { IconName } from '../../components/ui/icon/icons';
import type { QueueName } from '../../platform/queue-summary/queue-summary-shape';
import { isPermissionKey } from '../../platform/session/session-shape';

/**
 * What the Ops Portal's navigation is made of, and how a session's menu is worked out of it (surfaces/ops-portal.md section 4). There is no
 * React here and no page: the registry (`route-registry.tsx`) states the signed-in routes and what each means for the menus, and this derives
 * from them, for a set of permission keys, the sidebar's groups, the New menu's actions and the account menu's pages. A hint never authorises:
 * every route is behind its own guard and the server checks every request. Neither a role name nor a bundle is read anywhere here.
 */

/** Who may open a route: any signed-in session, or one that holds the permission key. */
export const ANY_SIGNED_IN_SESSION = 'any-signed-in-session';

export type RouteAccess =
  | typeof ANY_SIGNED_IN_SESSION
  | {
      readonly permission: string;
      /**
       * The key of whoever decides what the page asks for, when that is another person: a session without the page's key is then told who
       * decides, by this key, and not that it lacks access (`RequirePermission`).
       */
      readonly decidedBy?: string;
    };

/**
 * The seven groups of the sidebar, in the order of the hub's day (Product Owner, 5 November 2026; surfaces/ops-portal.md section 4). A group is
 * drawn only when the session holds the key of one of its pages that is built, so three of the seven have no page yet and are never seen.
 */
export const NAVIGATION_GROUPS = [
  'today',
  'pickups',
  'hub',
  'dispatch',
  'money',
  'people',
  'system',
] as const;

export type NavigationGroup = (typeof NAVIGATION_GROUPS)[number];

/** What each group is called in the sidebar. */
export const NAVIGATION_GROUP_LABELS: Readonly<Record<NavigationGroup, string>> = {
  today: 'Today',
  pickups: 'Pickups',
  hub: 'Hub',
  dispatch: 'Dispatch',
  money: 'Money',
  people: 'People and access',
  system: 'System',
};

interface MenuEntryFields {
  /** What the entry says. One to three words (PRODUCT_DESIGN_DIRECTION section 6.5). */
  readonly label: string;
  /**
   * Its icon, from the one family of the design system (DESIGN_SYSTEM section 24). Stated for every entry, so that a screen cannot be added to a
   * menu without deciding what it looks like there, and the same meaning keeps the same picture wherever it is drawn.
   */
  readonly icon: IconName;
  /** Its place among the entries of its menu (of its group, for the sidebar); unique there. */
  readonly order: number;
  /**
   * What the screen is for, in the words of the person using it. It is not drawn on the entry: it is what a search of the palette finds the page
   * by ("recovery" finds the vendors).
   */
  readonly description?: string;
}

/** An entry of the sidebar, in a group. */
export interface SidebarMenuEntry extends MenuEntryFields {
  readonly place: 'sidebar';
  readonly group: NavigationGroup;
  /**
   * The queue whose count is drawn beside this entry (`getQueueSummary`, task C1), when the screen is the place that queue is worked. At most one
   * queue to an entry and one entry to a queue; a queue with no entry (the late bookings, the pool of the run builder) is shown on My work alone.
   * The count is the server's: the entry draws what the summary holds for its queue and nothing when it holds none (`AC-QSUM-07`).
   */
  readonly queue?: QueueName;
}

/** An action of the New menu: a page that creates something. It has no entry in the sidebar, and no count. */
export interface CreateMenuEntry extends MenuEntryFields {
  readonly place: 'create';
}

/** A personal page of the account menu (the trusted browsers). It has no entry in the sidebar. */
export interface AccountMenuEntry extends MenuEntryFields {
  readonly place: 'account';
}

export type MenuEntry = SidebarMenuEntry | CreateMenuEntry | AccountMenuEntry;

/** What the navigation needs to know of a signed-in route: where it is, who may open it and where it appears. */
export interface NavigableRoute {
  /** Absolute, with no query or fragment: `/` for My work. A `:name` segment is a parameter and a `*` a splat. */
  readonly path: string;
  readonly access: RouteAccess;
  /**
   * The menu entry, or `null` for a screen that is reached from another and never from a menu (a detail or an act). Stated for every route, so that
   * leaving it out is a type error and not a screen nobody can find.
   */
  readonly menu: MenuEntry | null;
}

/** One entry as the menus draw it. */
export interface NavigationEntry {
  readonly to: string;
  readonly label: string;
  readonly icon: IconName;
  readonly description?: string;
  /** For a sidebar entry that carries a queue's count. */
  readonly queue?: QueueName;
}

export interface NavigationGroupView {
  readonly id: NavigationGroup;
  readonly label: string;
  readonly entries: readonly NavigationEntry[];
}

/** The menus a session may use. */
export interface Navigation {
  /** The sidebar's groups, in order, each with at least one entry. */
  readonly groups: readonly NavigationGroupView[];
  /** The New menu's actions. */
  readonly create: readonly NavigationEntry[];
  /** The account menu's pages. */
  readonly account: readonly NavigationEntry[];
}

const isPattern = (path: string): boolean =>
  path.split('/').some((segment) => segment.startsWith(':') || segment === '*');

/** What is wrong with a registry: every problem is a defect of the page, so building anything from an unsound one throws. */
export function registryProblems(routes: readonly NavigableRoute[]): string[] {
  const problems: string[] = [];
  const paths = new Set<string>();
  const places = new Set<string>();
  const queues = new Set<QueueName>();

  for (const route of routes) {
    const { path, access, menu } = route;
    const segments = path.split('/').slice(1);
    const wellFormed =
      path.startsWith('/') &&
      !/[?#]/.test(path) &&
      (path === '/' || (!path.endsWith('/') && segments.every((segment) => segment !== '')));
    if (!wellFormed)
      problems.push(
        `The path "${path}" is not an absolute path with no empty segment, query or fragment.`,
      );
    if (paths.has(path)) {
      // The second of two routes with one path says nothing more than that it is the second.
      problems.push(`The path "${path}" is in the registry twice.`);
      continue;
    }
    paths.add(path);

    if (access !== ANY_SIGNED_IN_SESSION && !isPermissionKey(access.permission)) {
      problems.push(
        `The permission "${access.permission}" of "${path}" is not a key of the catalogue's shape.`,
      );
    }
    if (
      access !== ANY_SIGNED_IN_SESSION &&
      access.decidedBy !== undefined &&
      !isPermissionKey(access.decidedBy)
    ) {
      problems.push(
        `The deciding permission "${access.decidedBy}" of "${path}" is not a key of the catalogue's shape.`,
      );
    }

    if (menu !== null) {
      if (menu.label.trim() === '') problems.push(`The menu entry of "${path}" has no label.`);
      if (menu.description?.trim() === '') {
        problems.push(`The menu entry of "${path}" has a description that says nothing.`);
      }
      if (!Number.isInteger(menu.order) || menu.order < 0) {
        problems.push(
          `The menu entry of "${path}" has an order that is not a whole number from zero.`,
        );
      }
      if (isPattern(path)) {
        problems.push(
          `The path "${path}" is a pattern, and a menu entry for a pattern links a screen that is not there.`,
        );
      }
      if (
        menu.place === 'sidebar' &&
        !(NAVIGATION_GROUPS as readonly string[]).includes(menu.group)
      ) {
        problems.push(
          `The menu entry of "${path}" is in the group "${menu.group}", which is not one.`,
        );
      }
      const place = `${menu.place === 'sidebar' ? `sidebar/${menu.group}` : menu.place}/${String(menu.order)}`;
      if (places.has(place)) problems.push(`Two menu entries have the place ${place}.`);
      places.add(place);
      if (menu.place === 'sidebar' && menu.queue !== undefined) {
        if (queues.has(menu.queue)) {
          problems.push(`The count of the queue ${menu.queue} is drawn beside two menu entries.`);
        }
        queues.add(menu.queue);
      }
    }
  }
  return problems;
}

/** Throws for an unsound registry, as every use of one does. */
export function assertSound(routes: readonly NavigableRoute[]): void {
  const problems = registryProblems(routes);
  if (problems.length > 0) throw new Error(problems.join(' '));
}

const entryOf = (path: string, menu: MenuEntry): NavigationEntry => ({
  to: path,
  label: menu.label,
  icon: menu.icon,
  ...(menu.description === undefined ? {} : { description: menu.description }),
  ...(menu.place === 'sidebar' && menu.queue !== undefined ? { queue: menu.queue } : {}),
});

/** A sound registry gives each entry of a menu a place of its own, so the place is the whole of the order. */
const byOrder = (a: MenuEntry, b: MenuEntry): number => a.order - b.order;

/**
 * The menus a session may use: the entries of the routes whose key it holds (or that need none) and that are built, which is every route of the
 * registry. The sidebar's groups come in their fixed order, each only when the session holds the key of one of its pages; within a group the
 * entries come by their place. The session's `permissions` are keys only, hints for what to show: a session that lists none holds none, and a key
 * matches exactly.
 */
export function navigationFor(
  permissions: readonly string[] | undefined,
  routes: readonly NavigableRoute[],
): Navigation {
  assertSound(routes);
  const held = new Set(permissions);
  const allowed = routes.flatMap((route) =>
    route.menu !== null &&
    (route.access === ANY_SIGNED_IN_SESSION || held.has(route.access.permission))
      ? [{ path: route.path, menu: route.menu }]
      : [],
  );
  const inPlace = (place: 'create' | 'account'): NavigationEntry[] =>
    allowed
      .filter(({ menu }) => menu.place === place)
      .toSorted((a, b) => byOrder(a.menu, b.menu))
      .map(({ path, menu }) => entryOf(path, menu));

  const groups = NAVIGATION_GROUPS.flatMap((id): NavigationGroupView[] => {
    const entries = allowed
      .filter(({ menu }) => menu.place === 'sidebar' && menu.group === id)
      .toSorted((a, b) => byOrder(a.menu, b.menu))
      .map(({ path, menu }) => entryOf(path, menu));
    return entries.length === 0 ? [] : [{ id, label: NAVIGATION_GROUP_LABELS[id], entries }];
  });
  return { groups, create: inPlace('create'), account: inPlace('account') };
}
