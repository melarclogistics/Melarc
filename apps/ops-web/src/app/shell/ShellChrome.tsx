import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from 'react-router';

import { AccountMenu } from '../../components/ui/app-shell/AccountMenu';
import { HubSwitcher } from '../../components/ui/app-shell/HubSwitcher';
import { MobileSidebar } from '../../components/ui/app-shell/MobileSidebar';
import { NewMenu } from '../../components/ui/app-shell/NewMenu';
import { SearchButton } from '../../components/ui/app-shell/SearchButton';
import { Sidebar } from '../../components/ui/app-shell/Sidebar';
import type { SidebarGroup } from '../../components/ui/app-shell/sidebar-types';
import { ThemeMenu } from '../../components/ui/app-shell/ThemeMenu';
import { TopBar } from '../../components/ui/app-shell/TopBar';
import { useHubChoice } from '../../platform/hub/active-hub';
import { hubsLine } from '../../platform/hub/hubs-line';
import type { QueueSummaryView } from '../../platform/queue-summary/queue-summary-shape';
import {
  useQueueSummary,
  useRefreshQueueSummaryOnReturn,
} from '../../platform/queue-summary/use-queue-summary';
import type { SessionView } from '../../platform/session/session-store';
import { useThemeChoice } from '../../platform/theme/use-theme-choice';
import { useViewport } from '../../platform/viewport/use-viewport';
import { useFrameChrome, useFrameTopBar } from '../frame-chrome';
import {
  navigationFor,
  type Navigation,
  type NavigableRoute,
} from '../navigation/navigation-model';
import { QUEUE_WORDS } from '../navigation/queue-places';
import { keepFocusOnThePage, useFocusReturn } from './focus-return';
import { ShellPalette } from './ShellPalette';
import { shortcutHint, usePalette } from './use-palette';

/**
 * The groups of the sidebar with the count of each entry's queue beside it, where the summary holds one (task C1; `AC-QSUM-07`). An entry whose
 * queue the summary does not hold, and every entry while the summary is being read or when it could not be, has no count and draws none: **a count
 * that is not there is never drawn as `0`**. **A count of 0 that was read draws no pill either** (task R5.2, M16: a row of zeros is noise beside the entries that hold
 * something; My work's "Also clear" line still names the queue). Which entries belong to which queue is the registry's; the words after the number are `QUEUE_WORDS`.
 */
export function sidebarGroups(
  navigation: Navigation,
  summary: QueueSummaryView | undefined,
): SidebarGroup[] {
  return navigation.groups.map((group) => ({
    id: group.id,
    label: group.label,
    entries: group.entries.map((entry) => {
      const counted =
        entry.queue === undefined || summary === undefined
          ? undefined
          : summary.queues.find((each) => each.queue === entry.queue);
      return {
        to: entry.to,
        label: entry.label,
        icon: entry.icon,
        ...(counted === undefined || entry.queue === undefined || counted.count === 0
          ? {}
          : { badge: { count: counted.count, meaning: QUEUE_WORDS[entry.queue].meaning } }),
      };
    }),
  }));
}

/**
 * Everything the signed-in shell draws around the page (surfaces/ops-portal.md section 4; COMPONENT_PATTERNS section 12.6): the sidebar, the top bar
 * with its hub switcher, search, theme control, New menu and account menu, and the command palette. It sits in the page's own places (the frame's:
 * `useFrameChrome`, `useFrameTopBar`), so the landmarks are the frame's: the skip link, the sidebar, the top bar, then the main content.
 *
 * - **The sidebar is the rail below 1280px and the full sidebar from there, and the person may ask for the other**; the choice lasts as long as the
 *   page and is never kept in the browser. On a narrow screen (under 768px) it is a sheet that the top bar's button opens.
 * - **The counts** come from the queue summary, read when the shell loads, when the person goes to another page, when they choose another hub
 *   (the summary is asked for that hub, task C3: `useQueueSummary`) and after an act that changes a queue (`queueSummaryObserver`): never on a
 *   timer.
 * - **Sign-out** is in the account menu, which stays open while it is under way. A sign-out that did not finish closes the menu and is told at the
 *   top of the page, where the person is looking.
 *
 * It holds no rule: what is offered follows the keys the session lists and the routes that exist, and the server checks every request.
 */
export function ShellChrome({
  session,
  routes,
  signOut,
  signingOut,
  signOutFailed,
}: {
  readonly session: SessionView;
  readonly routes: readonly NavigableRoute[];
  readonly signOut: () => void;
  readonly signingOut: boolean;
  readonly signOutFailed: boolean;
}) {
  const sidebarSlot = useFrameChrome();
  const topBarSlot = useFrameTopBar();
  const { pathname, key: visit } = useLocation();
  const viewport = useViewport();
  const narrow = viewport === 'narrow';

  // The rail below 1280px and the full sidebar from there, unless the person asked for the other: their choice lasts as long as the page does.
  const [railChoice, setRailChoice] = useState<boolean | undefined>(undefined);
  const rail = !narrow && (railChoice ?? viewport === 'medium');

  // The sheet of a narrow screen. Following a link, or the window growing past the narrow size, closes it: the state is adjusted while rendering,
  // as React advises, so that no frame is drawn with the sheet open over the page it was left for. A link is followed when the location has another
  // key (every navigation has one, also to the address the person is on and to the same page with another query); the path alone would leave the
  // sheet open over a page that changed, or over the one the person pressed the entry of.
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const sheetFocus = useFocusReturn(menuButton);
  const [lastVisit, setLastVisit] = useState(visit);
  if (lastVisit !== visit) {
    setLastVisit(visit);
    setMenuOpen(false);
  }
  if (!narrow && menuOpen) setMenuOpen(false);

  const [accountOpen, setAccountOpen] = useState(false);
  // A sign-out that did not finish is told at the top of the page, so the menu that was showing it under way is closed **when the failure arrives**
  // (and not for as long as it stands: the person may open the menu again to try the sign-out from it).
  const [failureTold, setFailureTold] = useState(false);
  if (signOutFailed !== failureTold) {
    setFailureTold(signOutFailed);
    if (signOutFailed) setAccountOpen(false);
  }

  const summary = useQueueSummary();
  useRefreshQueueSummaryOnReturn(pathname);
  // A count that failed is not drawn: TanStack Query keeps the last answer beside the error, and the old counts must not stand on every page.
  const counted = summary.isError ? undefined : summary.data;

  // The choice of hub is part of what the summary asks (`useQueueSummary` reads it and keys the query by it): another hub is another query,
  // which reads by itself, and the counts of the hub that was left are never drawn under the name of the one chosen.
  const hubChoice = useHubChoice();
  const [theme, chooseTheme] = useThemeChoice();
  const searchButton = useRef<HTMLButtonElement>(null);
  const palette = usePalette(searchButton);

  const navigation = navigationFor(session.permissions, routes);
  const groups = sidebarGroups(navigation, counted);
  const account = {
    name: session.principal_display_name,
    detail: hubsLine(session.authorized_hubs),
  };

  return (
    <>
      {topBarSlot === null
        ? null
        : createPortal(
            <TopBar
              {...(narrow
                ? {
                    menu: {
                      open: menuOpen,
                      onOpen: () => {
                        sheetFocus.remember();
                        setMenuOpen(true);
                      },
                    },
                    menuButtonRef: menuButton,
                  }
                : {})}
              hub={
                <HubSwitcher
                  hubs={hubChoice.hubs.map((hub) => ({ id: hub.id, name: hub.display_name }))}
                  activeHubId={hubChoice.activeHubId}
                  hasChoice={hubChoice.hasChoice}
                  onChoose={hubChoice.choose}
                />
              }
              search={
                <SearchButton
                  ref={searchButton}
                  shortcut={shortcutHint()}
                  onOpen={palette.openPalette}
                />
              }
              end={
                <>
                  {narrow ? null : <ThemeMenu choice={theme} onChoose={chooseTheme} />}
                  <NewMenu actions={navigation.create} onCloseAutoFocus={keepFocusOnThePage} />
                  <AccountMenu
                    name={account.name}
                    detail={account.detail}
                    pages={navigation.account}
                    theme={{ choice: theme, onChoose: chooseTheme }}
                    signingOut={signingOut}
                    onSignOut={signOut}
                    open={accountOpen}
                    onOpenChange={setAccountOpen}
                    onCloseAutoFocus={keepFocusOnThePage}
                  />
                </>
              }
            />,
            topBarSlot,
          )}
      {narrow ? (
        <MobileSidebar
          open={menuOpen}
          onOpenChange={setMenuOpen}
          groups={groups}
          account={account}
          onCloseAutoFocus={sheetFocus.onCloseAutoFocus}
        />
      ) : sidebarSlot === null ? null : (
        createPortal(
          <Sidebar
            placement="docked"
            groups={groups}
            account={account}
            rail={rail}
            onToggleRail={() => {
              setRailChoice(!rail);
            }}
          />,
          sidebarSlot,
        )
      )}
      <ShellPalette
        open={palette.open}
        onOpenChange={palette.setOpen}
        onCloseAutoFocus={palette.onCloseAutoFocus}
        navigation={navigation}
      />
    </>
  );
}
