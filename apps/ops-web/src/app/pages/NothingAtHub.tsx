import type { ReactNode } from 'react';

import { Button } from '../../components/ui/button/Button';
import { EmptyState } from '../../components/ui/empty-state/EmptyState';
import type { SessionHub } from '../../platform/hub/active-hub';

/**
 * The empty state of a list that is narrowed to one hub by the switcher of the top bar (audit B1, 7 November 2026): **a chosen hub is a filter**, so
 * a list with nothing in it says "Nothing at <hub>" and offers *Show all hubs*, and does not say "No <things> yet" as if nothing existed anywhere.
 * `what` is what the list lists, in the plural ("pickup requests"); `filtered` is whether the page's own filters are set as well, and then `clear` is
 * the page's way to take them off, offered beside the way back to every hub. It is a filtered state, not a success one: the work may be at another hub.
 */
export function NothingAtHub({
  hub,
  showAllHubs,
  what,
  filtered = false,
  clear,
}: {
  readonly hub: SessionHub;
  readonly showAllHubs: () => void;
  readonly what: string;
  readonly filtered?: boolean;
  readonly clear?: ReactNode;
}) {
  return (
    <EmptyState
      kind="filtered"
      heading={`Nothing at ${hub.display_name}`}
      announce
      action={
        <>
          <Button type="button" variant="secondary" onClick={showAllHubs}>
            Show all hubs
          </Button>
          {filtered ? clear : null}
        </>
      }
    >
      {filtered
        ? `No ${what} at ${hub.display_name} fit these filters. Show all hubs, or take the other filters off.`
        : `No ${what} at ${hub.display_name}. Show all hubs to see those of every hub your session reaches.`}
    </EmptyState>
  );
}
