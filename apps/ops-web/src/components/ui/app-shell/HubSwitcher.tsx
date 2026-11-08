import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../primitives/dropdown-menu';
import { Icon } from '../icon/Icon';
import './top-bar.css';

/** The value of the choice of every hub the session reaches: no hub id is this, since a hub's id is a UUID. */
const ALL_HUBS = 'all';

export interface HubSwitcherProps {
  /** The hubs the session lists, by name. */
  readonly hubs: readonly { readonly id: string; readonly name: string }[];
  /** The hub the person narrowed to, or nothing for *All hubs* (and for a session with one hub). */
  readonly activeHubId: string | undefined;
  /** There is more than one hub to choose among, so the menu exists and *All hubs* is in it. */
  readonly hasChoice: boolean;
  readonly onChoose: (hubId: string | undefined) => void;
}

/**
 * The hub switcher of the top bar (surfaces/ops-portal.md sections 3 and 4): a button with a 6px crimson square and the name of the hub whose work
 * the screens show, which opens a menu of the hubs the session lists and, for a session that lists more than one, *All hubs*. A session with one
 * hub has nothing to choose, so it gets the name and no menu; a session with none gets nothing. Choosing is a request for a view, creates no access
 * and is kept in memory only (`platform/hub`).
 */
export function HubSwitcher({ hubs, activeHubId, hasChoice, onChoose }: HubSwitcherProps) {
  const [only] = hubs;
  if (only === undefined) return null;

  if (!hasChoice) {
    return (
      <p className="ui-hub ui-hub--static">
        <span className="ui-hub__square" aria-hidden="true" />
        <span className="ui-hub__name">
          <span className="sr-only">Hub: </span>
          {only.name}
        </span>
      </p>
    );
  }

  const active = hubs.find((hub) => hub.id === activeHubId);
  const name = active?.name ?? 'All hubs';
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="ui-hub" aria-label={`Hub: ${name}`}>
          <span className="ui-hub__square" aria-hidden="true" />
          <span className="ui-hub__name">{name}</span>
          <Icon name="opens-menu" size="sm" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={8} className="ui-menu ui-menu--hubs">
        <DropdownMenuLabel>Show work for</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup
          value={activeHubId ?? ALL_HUBS}
          onValueChange={(value) => {
            onChoose(value === ALL_HUBS ? undefined : value);
          }}
        >
          <DropdownMenuRadioItem value={ALL_HUBS}>All hubs</DropdownMenuRadioItem>
          {hubs.map((hub) => (
            <DropdownMenuRadioItem key={hub.id} value={hub.id}>
              {hub.name}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
