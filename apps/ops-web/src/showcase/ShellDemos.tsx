import { useState, type ReactNode } from 'react';

import { Button } from '../components/ui/button/Button';
import { AccountMenu } from '../components/ui/app-shell/AccountMenu';
import {
  CommandPalette,
  type PaletteLink,
  type PaletteRecords,
} from '../components/ui/app-shell/CommandPalette';
import { HubSwitcher } from '../components/ui/app-shell/HubSwitcher';
import { NewMenu } from '../components/ui/app-shell/NewMenu';
import { SearchButton } from '../components/ui/app-shell/SearchButton';
import { Sidebar } from '../components/ui/app-shell/Sidebar';
import type { SidebarGroup } from '../components/ui/app-shell/sidebar-types';
import { ThemeMenu } from '../components/ui/app-shell/ThemeMenu';
import type { ThemeValue } from '../components/ui/app-shell/theme-options';
import { TopBar } from '../components/ui/app-shell/TopBar';

/**
 * The shell of the signed-in screens, drawn with made-up entries that go nowhere (redesign step R4): the sidebar expanded and as the rail, the top
 * bar with its menus, and the command palette in each state of its search. Everything on it is synthetic and says "Demo"; the choices (a hub, a
 * theme, the rail) are held in this page's memory and change nothing outside it. The shell itself is `app/shell/`, which draws these same components
 * from the session; nothing here is a second description of it.
 */
const GROUPS: SidebarGroup[] = [
  {
    id: 'today',
    label: 'Demo today',
    entries: [
      { to: '/__showcase', label: 'Demo my work', icon: 'my-work' },
      {
        to: '/__showcase/demo-decisions',
        label: 'Demo decisions',
        icon: 'exception-approvals',
        badge: { count: 3, meaning: 'waiting for a decision (demo)' },
      },
    ],
  },
  {
    id: 'people',
    label: 'Demo people',
    entries: [
      {
        to: '/__showcase/demo-staff',
        label: 'Demo staff',
        icon: 'staff',
        badge: { count: 0, meaning: 'waiting for approval (demo)' },
      },
      { to: '/__showcase/demo-sessions', label: 'Demo sessions', icon: 'sessions' },
    ],
  },
];

const HUBS = [
  { id: 'demo-hub-a', name: 'Demo hub A' },
  { id: 'demo-hub-b', name: 'Demo hub B' },
];

const GO_TO: PaletteLink[] = [
  { to: '/__showcase', label: 'Demo my work', icon: 'my-work' },
  { to: '/__showcase/demo-staff', label: 'Demo staff', icon: 'staff' },
];
const CREATE: PaletteLink[] = [
  { to: '/__showcase/demo-new', label: 'Demo new request', icon: 'book-pickup' },
];

const RECORDS: Record<string, PaletteRecords> = {
  hint: { state: 'hint' },
  loading: { state: 'loading' },
  empty: { state: 'empty', text: 'zzz' },
  error: {
    state: 'error',
    message: 'The search could not be completed.',
    onRetry: () => undefined,
  },
  results: {
    state: 'results',
    items: [
      {
        id: 'demo-1',
        to: '/__showcase/demo-record',
        title: 'DEMO-0001',
        isCode: true,
        subtitle:
          'Demo sender · Waiting for confirmation · Demo hub A · Mon 2 Nov 2026 · +233******123',
        icon: 'pickup-requests',
      },
      {
        id: 'demo-2',
        to: '/__showcase/demo-person',
        title: 'Demo Rider',
        isCode: false,
        subtitle: 'Active · Demo hub A',
        icon: 'riders',
      },
    ],
  },
};

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="showcase-section">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

export function ShellDemos() {
  const [rail, setRail] = useState(false);
  const [hub, setHub] = useState<string | undefined>(undefined);
  const [theme, setTheme] = useState<ThemeValue>('system');
  const [accountOpen, setAccountOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [state, setState] = useState('hint');
  const [chosen, setChosen] = useState('nothing yet');

  return (
    <>
      <Section title="Sidebar">
        <p>
          The Ink sidebar: 248px wide, or the 64px rail with the name of each entry in a tooltip.
          The current entry is a solid crimson fill.
        </p>
        <div className="showcase-sidebars">
          <div className="showcase-sidebar" aria-label="Demo sidebar, expanded" role="group">
            <Sidebar
              placement="docked"
              rail={rail}
              onToggleRail={() => {
                setRail(!rail);
              }}
              groups={GROUPS}
              account={{ name: 'Demo Person', detail: 'Demo hub A' }}
            />
          </div>
          <div className="showcase-sidebar" aria-label="Demo sidebar, rail" role="group">
            <Sidebar
              placement="docked"
              rail
              onToggleRail={() => undefined}
              groups={GROUPS}
              account={{ name: 'Demo Person', detail: 'Demo hub A' }}
            />
          </div>
        </div>
      </Section>
      <Section title="Top bar">
        <p>
          The hub switcher, the search, the theme control, the New menu and the account menu.
          Nothing here goes anywhere.
        </p>
        <div className="showcase-topbar">
          <TopBar
            hub={<HubSwitcher hubs={HUBS} activeHubId={hub} hasChoice onChoose={setHub} />}
            search={
              <SearchButton
                shortcut="Ctrl K"
                onOpen={() => {
                  setPaletteOpen(true);
                }}
              />
            }
            end={
              <>
                <ThemeMenu choice={theme} onChoose={setTheme} />
                <NewMenu
                  actions={[
                    { to: '/__showcase/demo-new', label: 'Demo new request', icon: 'book-pickup' },
                    { to: '/__showcase/demo-run', label: 'Demo new run', icon: 'build-manifest' },
                  ]}
                />
                <AccountMenu
                  name="Demo Person"
                  detail="Demo hub A"
                  pages={[
                    {
                      to: '/__showcase/demo-browsers',
                      label: 'Demo trusted browsers',
                      icon: 'trusted-browsers',
                    },
                  ]}
                  theme={{ choice: theme, onChoose: setTheme }}
                  signingOut={false}
                  onSignOut={() => undefined}
                  open={accountOpen}
                  onOpenChange={setAccountOpen}
                />
              </>
            }
          />
        </div>
      </Section>
      <Section title="Command palette">
        <p>
          The search of records in each state:{' '}
          {Object.keys(RECORDS).map((name) => (
            <Button
              key={name}
              type="button"
              variant="secondary"
              onClick={() => {
                setState(name);
                setPaletteOpen(true);
              }}
            >
              {`Open: ${name}`}
            </Button>
          ))}
        </p>
        <p>
          Chosen: <span data-testid="demo-palette-chosen">{chosen}</span>
        </p>
        <CommandPalette
          open={paletteOpen}
          onOpenChange={setPaletteOpen}
          query={query}
          onQueryChange={setQuery}
          goTo={GO_TO}
          create={CREATE}
          records={RECORDS[state] ?? { state: 'hint' }}
          onSelect={(to) => {
            setChosen(to);
            setPaletteOpen(false);
          }}
          onCloseAutoFocus={() => undefined}
        />
      </Section>
    </>
  );
}
