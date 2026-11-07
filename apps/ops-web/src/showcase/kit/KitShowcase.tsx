import { useEffect, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';

import { PageHeading } from '../../components/PageHeading';
import { Toaster } from '../../components/ui/toast/Toast';
import { DataGroup } from './DataGroup';
import { BlindCountExample, QueueWorkspaceExample, RecordPageExample } from './Examples';
import { FormsGroup } from './FormsGroup';
import { HeaderGroup } from './HeaderGroup';
import { ListsGroup } from './ListsGroup';
import { MenusGroup } from './MenusGroup';
import { PanelsGroup } from './PanelsGroup';
import './kit.css';

/**
 * The development-only showcase of the Melarc component kit (design/COMPONENT_PATTERNS.md sections 27 and 37; redesign step R5): one page for each group of
 * components, with every variant and every state in real Melarc words, in both themes, and the composed examples built from them. It is a place to look at the
 * components and to give the browser tests real ones to drive; it is not a second specification of any of them, and nothing here is a route of the application.
 * Everything on it that stands for data is labelled "Sample". Its route and its code are absent from the production build (test/build.test.ts).
 */
interface Group {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly page: () => ReactNode;
}

export const KIT_GROUPS: readonly Group[] = [
  {
    id: 'header',
    title: 'Header and views',
    summary: 'PageHeader, ViewTabs and FilterBar',
    page: () => <HeaderGroup />,
  },
  { id: 'data', title: 'Data', summary: 'DataTable', page: () => <DataGroup /> },
  {
    id: 'panels',
    title: 'Panels and records',
    summary: 'SidePanel, RecordHeader with StageTracker, DescriptionList, Panel and StatTile',
    page: () => <PanelsGroup />,
  },
  {
    id: 'menus',
    title: 'Menus and messages',
    summary: 'ActionMenu and Toast',
    page: () => <MenusGroup />,
  },
  { id: 'forms', title: 'Forms', summary: 'DateField', page: () => <FormsGroup /> },
  { id: 'lists', title: 'Lists', summary: 'ReorderList', page: () => <ListsGroup /> },
  {
    id: 'example-queue',
    title: 'Example: the queue workspace',
    summary: 'PageHeader, ViewTabs, FilterBar, DataTable and SidePanel together',
    page: () => <QueueWorkspaceExample />,
  },
  {
    id: 'example-record',
    title: 'Example: the record page',
    summary: 'RecordHeader, StageTracker, two columns and a timeline',
    page: () => <RecordPageExample />,
  },
  {
    id: 'example-count',
    title: 'Example: the tablet blind count',
    summary: 'A hub-floor task at 768px, with 56px targets',
    page: () => <BlindCountExample />,
  },
];

type ThemeChoice = 'system' | 'light' | 'dark';

/** A switch for this page only, held in memory and never stored: the theme toggle and its stored choice are step R4's. */
function ThemeSwitch() {
  const [choice, setChoice] = useState<ThemeChoice>(() => {
    const set = document.documentElement.getAttribute('data-theme');
    return set === 'light' || set === 'dark' ? set : 'system';
  });
  useEffect(() => {
    if (choice === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', choice);
  }, [choice]);

  return (
    <div role="group" aria-label="Theme of this page" className="showcase-kit-theme">
      {(['system', 'light', 'dark'] as const).map((value) => (
        <button
          key={value}
          type="button"
          className="showcase-kit-theme__choice"
          aria-pressed={choice === value}
          onClick={() => {
            setChoice(value);
          }}
        >
          {value === 'system' ? 'System' : value === 'light' ? 'Light' : 'Dark'}
        </button>
      ))}
    </div>
  );
}

export function KitShowcasePage() {
  const { group: id } = useParams();
  const group = KIT_GROUPS.find((candidate) => candidate.id === id);

  return (
    <main className="showcase-kit">
      <div className="showcase-kit__top">
        <PageHeading>Kit showcase</PageHeading>
        <ThemeSwitch />
      </div>
      <p className="showcase-kit__note">
        The components of the Ops Portal kit, drawn on the tokens in both themes. Everything on
        these pages is made up; what stands for data says so, and nothing is saved or sent.
      </p>
      <nav aria-label="Groups of the kit" className="showcase-kit__nav">
        <ul>
          {KIT_GROUPS.map((candidate) => (
            <li key={candidate.id}>
              <Link
                to={`/__showcase/kit/${candidate.id}`}
                aria-current={candidate.id === id ? 'page' : undefined}
              >
                {candidate.title}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      {group === undefined ? (
        <section aria-label="The groups">
          <h2>Choose a group</h2>
          <ul className="showcase-kit__index">
            {KIT_GROUPS.map((candidate) => (
              <li key={candidate.id}>
                <Link to={`/__showcase/kit/${candidate.id}`}>{candidate.title}</Link>
                <span>{candidate.summary}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <>
          <h2 className="showcase-kit__group">{group.title}</h2>
          {group.page()}
        </>
      )}
      <Toaster />
    </main>
  );
}
