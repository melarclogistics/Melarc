import { matchRoutes } from 'react-router';
import { describe, expect, it } from 'vitest';

import { QUEUE_IDS, type QueueName } from '../../platform/queue-summary/queue-summary-shape';
import { QUEUE_WORDS, queueLink } from './queue-places';
import { navigationFor, registryProblems } from './navigation-model';
import {
  ANY_SIGNED_IN_SESSION,
  SIGNED_IN_ROUTES,
  signedInRouteObjects,
  type SignedInRoute,
} from './route-registry';

/** The queue each entry of the sidebar draws a count of, by the address of the entry, for a session that holds every key (a count is drawn only beside an entry the session has). */
function queueOfEntries(): Map<string, QueueName> {
  const everyKey = SIGNED_IN_ROUTES.flatMap((route) =>
    route.access === ANY_SIGNED_IN_SESSION ? [] : [route.access.permission],
  );
  return new Map(
    navigationFor(everyKey, SIGNED_IN_ROUTES)
      .groups.flatMap((group) => group.entries)
      .flatMap((entry) => (entry.queue === undefined ? [] : [[entry.to, entry.queue] as const])),
  );
}

/**
 * The queues of the summary and the places they lead to (task C1). The words are plain and exist for every queue; every link leads to a route
 * that exists and that the keys of the queue open; the registry draws a queue's count beside one entry and no entry carries two.
 */
const KEYS_OF: Readonly<Record<QueueName, readonly string[]>> = {
  PICKUP_AWAITING_CONFIRMATION: ['pickup.read'],
  PICKUP_CUTOFF_REVIEW: ['pickup.read'],
  PICKUP_EXCEPTION_APPROVAL: ['pickup.read', 'pickup.exception.approve'],
  PICKUP_UNMANIFESTED_POOL: ['pickup.read'],
  PICKUP_RUNS_IN_PROGRESS: ['pickup.read'],
  STAFF_AWAITING_APPROVAL: ['staff.read', 'staff.identity.approve'],
};

const pathOf = (link: string): string => link.split('?')[0] ?? link;

describe('the words of the queues', () => {
  // Break caught: a queue with no words, an empty title, or an identifier or a key on the screen in place of words.
  it('are there for every queue, plain, and without an identifier or a permission key', () => {
    expect(Object.keys(QUEUE_WORDS).toSorted()).toEqual([...QUEUE_IDS].toSorted());
    for (const queue of QUEUE_IDS) {
      const { title, meaning } = QUEUE_WORDS[queue];
      for (const words of [title, meaning]) {
        expect(words.trim(), queue).not.toBe('');
        expect(words, queue).not.toMatch(/[A-Z]{2,}_[A-Z_]+|\b[a-z]+\.[a-z_]+(\.[a-z_]+)?\b/);
        expect(words, queue).not.toMatch(/Platform Admin|Senior Ops|Ops Staff/);
      }
    }
  });

  // Break caught: two queues drawn with one title on the landing, which a person could not tell apart.
  it('give each queue a title of its own', () => {
    const titles = QUEUE_IDS.map((queue) => QUEUE_WORDS[queue].title);
    expect(new Set(titles).size).toBe(titles.length);
  });
});

describe('where each queue leads', () => {
  const routes = signedInRouteObjects();
  // The links are the literal paths of the registry (no parameter), so the route behind one is the entry with that path.
  const routeOf = (link: string): SignedInRoute | undefined =>
    SIGNED_IN_ROUTES.find((route) => route.path === pathOf(link));

  // Break caught: a link to a page that does not exist, so that the count leads to a "not found".
  it.each(QUEUE_IDS.map((queue) => [queue] as const))(
    '%s leads to a page of the portal',
    (queue) => {
      for (const holds of [() => true, () => false] as const) {
        const link = queueLink(queue, holds);
        expect(link, queue).toMatch(/^\//);
        expect(matchRoutes(routes, pathOf(link)), `${queue}: ${link}`).not.toBeNull();
      }
    },
  );

  // Break caught: a count that leads a person to a page that refuses them: the page must open for the keys that make the queue theirs.
  it.each(QUEUE_IDS.map((queue) => [queue] as const))(
    '%s leads to a page that the keys of that queue open',
    (queue) => {
      const keys = new Set(KEYS_OF[queue]);
      const link = queueLink(queue, (permission) => keys.has(permission));
      const route = routeOf(link);
      expect(route, `${queue}: ${link}`).toBeDefined();
      if (route === undefined || route.access === ANY_SIGNED_IN_SESSION) return;
      expect(
        keys.has(route.access.permission),
        `${queue}: ${link} needs ${route.access.permission}`,
      ).toBe(true);
    },
  );

  // Break caught: the pool leading to the manifest builder for someone who may not build one.
  it('sends the pool to the builder only to a session that may build a manifest', () => {
    expect(queueLink('PICKUP_UNMANIFESTED_POOL', (key) => key === 'pickup.manifest.create')).toBe(
      '/manifests/new',
    );
    expect(queueLink('PICKUP_UNMANIFESTED_POOL', () => false)).toBe(
      '/pickup-requests?state=CONFIRMED',
    );
  });

  // Break caught: the late bookings leading to the plain list of confirmed requests, which hides the ones they are looking for among the
  // others (task C1.1, AC-QSUM-11: the list has a filter for them now, and the link opens the set that was counted).
  it('opens the late bookings with the list’s own filter for them', () => {
    expect(queueLink('PICKUP_CUTOFF_REVIEW', () => true)).toBe(
      '/pickup-requests?state=CONFIRMED&cutoff=PENDING_OPS_REVIEW',
    );
    expect(queueLink('PICKUP_AWAITING_CONFIRMATION', () => true)).toBe(
      '/pickup-requests?state=PENDING',
    );
  });
});

describe('the registry and the queues', () => {
  // Break caught: a queue drawn beside the wrong entry, or an entry that lost its count.
  it('draws the count of each queue that has an entry beside that entry, and the late bookings and the pool beside none', () => {
    const queues = queueOfEntries();

    expect(Object.fromEntries(queues)).toEqual({
      '/pickup-requests': 'PICKUP_AWAITING_CONFIRMATION',
      '/approvals': 'PICKUP_EXCEPTION_APPROVAL',
      '/manifests': 'PICKUP_RUNS_IN_PROGRESS',
      '/admin/staff': 'STAFF_AWAITING_APPROVAL',
    });
    // The late bookings have no entry, and the pool's entry (the run builder) is an action of the New menu, which draws no count: both show on My work.
    expect([...queues.values()]).not.toContain('PICKUP_CUTOFF_REVIEW');
    expect([...queues.values()]).not.toContain('PICKUP_UNMANIFESTED_POOL');
  });

  // Break caught: the count of one queue drawn beside two entries, which would say the same thing twice with different meanings.
  it('refuses a registry that draws one queue beside two entries', () => {
    const twice: SignedInRoute[] = SIGNED_IN_ROUTES.map((route) =>
      route.path === '/messages' && route.menu?.place === 'sidebar'
        ? { ...route, menu: { ...route.menu, queue: 'PICKUP_AWAITING_CONFIRMATION' } }
        : route,
    );

    expect(registryProblems(twice)).toEqual([
      'The count of the queue PICKUP_AWAITING_CONFIRMATION is drawn beside two menu entries.',
    ]);
    expect(registryProblems(SIGNED_IN_ROUTES)).toEqual([]);
  });

  // Break caught: the entry of a queue that the session's own key gives it no page for, drawing a count beside nothing.
  it('only draws a count beside entries that are in the menu of the session', () => {
    // The map names paths; the shell puts a count only beside an entry that exists in the session's menu.
    for (const path of queueOfEntries().keys()) {
      expect(SIGNED_IN_ROUTES.find((route) => route.path === path)?.menu, path).not.toBeNull();
    }
  });
});
