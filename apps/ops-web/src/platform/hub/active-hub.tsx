import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

import { useSession } from '../session/session-context';

/** A hub the session lists: its id and its name, as `authorized_hubs` of the session gives them (labels for the interface, never authority). */
export interface SessionHub {
  readonly id: string;
  readonly display_name: string;
}

/**
 * Which hub's work the screens show (the hub switcher of the top bar; surfaces/ops-portal.md section 3, Product Owner, 5 November 2026). It
 * is a **request for a view and creates no access**: the server's scoping is what the session's grant reaches, and a screen that is told to
 * show one hub shows less of what the session may see, never more.
 */
export interface ActiveHub {
  /** The hubs the session lists, in the order it lists them. */
  readonly hubs: readonly SessionHub[];
  /**
   * The one hub the person narrowed the screens to, or `undefined` for *All hubs* (every hub the session reaches, which is what a screen shows
   * when it is told nothing) and for a session that has no choice to make (one hub, or none).
   */
  readonly activeHubId: string | undefined;
  /** The session lists more than one hub, so there is a choice, and *All hubs* is a choice of it. */
  readonly hasChoice: boolean;
  /** Chooses one hub of the session's, or *All hubs* with `undefined`. A hub the session does not list is no choice: the screens show *All hubs*. */
  readonly choose: (hubId: string | undefined) => void;
}

const NO_CHOICE: ActiveHub = {
  hubs: [],
  activeHubId: undefined,
  hasChoice: false,
  choose: () => undefined,
};

const ActiveHubContext = createContext<ActiveHub>(NO_CHOICE);

/**
 * Holds the choice of hub for as long as the page lives: **in memory, per tab, and never in web storage** (the only thing the portal stores in the
 * browser is the person's choice of theme). A reload starts again at *All hubs*, which is also where a session starts.
 *
 * The choice belongs to a **scope**, which is the session's id (`HubChoiceScope` gives it): a choice made under another scope, another session or
 * none, is not this one's and is ignored, so the next person to sign in is never left with the previous person's hub, and no remount is needed to
 * make it so (a provider keyed by the session remounts everything under it when the session is first read, and again when it changes).
 *
 * *All hubs* is the choice offered to a session that lists two or more hubs, a Platform Admin's among them (its list is every hub), and it is
 * where such a session starts: a screen that is told nothing shows what the grant reaches, and starting on one hub would hide the work at the
 * other from a person whose grant reaches both. A session of one hub has nothing to choose, and one of none has nothing to show.
 */
export function ActiveHubProvider({
  hubs,
  scope,
  children,
}: {
  readonly hubs: readonly SessionHub[];
  /** Whose choice it is: the session's id. A choice made under another scope is ignored. */
  readonly scope?: string;
  readonly children: ReactNode;
}) {
  const [chosen, setChosen] = useState<{
    readonly scope: string | undefined;
    readonly hubId: string | undefined;
  }>({ scope, hubId: undefined });
  const hasChoice = hubs.length >= 2;
  const choose = useCallback(
    (hubId: string | undefined): void => {
      setChosen({ scope, hubId });
    },
    [scope],
  );
  const own = chosen.scope === scope ? chosen.hubId : undefined;
  // **The one rule for a hub the session does not list**, whether it was never listed or the list changed under the choice: it is *All hubs*, not a
  // screen narrowed to nothing, and it is never an id that a screen sends.
  const activeHubId =
    hasChoice && own !== undefined && hubs.some((hub) => hub.id === own) ? own : undefined;
  const value = useMemo<ActiveHub>(
    () => ({ hubs, activeHubId, hasChoice, choose }),
    [hubs, activeHubId, hasChoice, choose],
  );
  return <ActiveHubContext value={value}>{children}</ActiveHubContext>;
}

const NO_HUBS: readonly SessionHub[] = [];

/**
 * The choice of hub for the whole application: **above the router and inside the session**, so that it lasts as long as the session does and not
 * as long as the shell is on the screen. A person who leaves the shell for an address that matches no route (the neutral page of a missing page) or
 * for the page of a route that failed, and comes back, finds the hub they had chosen. It is scoped to the session's id, so that a session that ends
 * takes the choice with it, and it offers nothing (no hubs, no choice) while nobody is signed in.
 */
export function HubChoiceScope({ children }: { readonly children: ReactNode }) {
  const state = useSession();
  const session = state.status === 'signed-in' ? state.session : undefined;
  return (
    <ActiveHubProvider
      hubs={session?.authorized_hubs ?? NO_HUBS}
      {...(session === undefined ? {} : { scope: session.id })}
    >
      {children}
    </ActiveHubProvider>
  );
}

/**
 * **The one place the choice of hub is read.** The hub the person narrowed the screens to, or `undefined` for *All hubs* (and for a session with
 * one hub, which has nothing to narrow). A screen that sends `hub_id` sends this and nothing when it is `undefined`; a create form starts with
 * it as its hub; an act on a record uses that record's own hub and never reads this.
 */
export function useActiveHub(): string | undefined {
  return useContext(ActiveHubContext).activeHubId;
}

/** The choice and the way to change it, for the switcher that draws it. A screen reads {@link useActiveHub}, never this. */
export function useHubChoice(): ActiveHub {
  return useContext(ActiveHubContext);
}

/**
 * What a list or a page may know of the choice beyond its id, and the one thing it may do about it: the hub the screens are narrowed to **with its
 * name** (to say "Nothing at Kumasi Hub", "Waiting for you at Kumasi Hub"), and the way out of the narrowing, *Show all hubs*. It cannot choose a
 * hub (that is the switcher's, `useHubChoice`), which is why a page may call it and may not call that.
 */
export interface HubScope {
  /** The hub the screens are narrowed to, or `undefined` for *All hubs* and for a session with no choice. */
  readonly hub: SessionHub | undefined;
  /** Takes the narrowing off: *All hubs*. For a screen that shows nothing because of the hub, as its way back to what the session reaches. */
  readonly showAllHubs: () => void;
}

export function useHubScope(): HubScope {
  const { hubs, activeHubId, choose } = useContext(ActiveHubContext);
  const hub = activeHubId === undefined ? undefined : hubs.find((each) => each.id === activeHubId);
  return useMemo<HubScope>(
    () => ({
      hub,
      showAllHubs: () => {
        choose(undefined);
      },
    }),
    [hub, choose],
  );
}
