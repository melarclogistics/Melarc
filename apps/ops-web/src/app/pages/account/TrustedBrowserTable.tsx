import type { ReactNode } from 'react';

import { DataTable, type DataColumn } from '../../../components/ui/data-table/DataTable';
import type { QueueTableConfig } from '../../../components/ui/templates/QueueWorkspace';
import type { TrustedBrowserView } from '../../../platform/staff/staff-shape';
import { formatInstant } from '../../../platform/time/format-time';
import '../pickup/pickup-pages.css';
import './account-pages.css';

function Time({ instant }: { readonly instant: string }) {
  const text = formatInstant(instant);
  return text === undefined ? <>Not recorded</> : <time dateTime={instant}>{text}</time>;
}

/** When a browser was last used, or that it never has been. */
function LastUsed({ instant }: { readonly instant: string | null }) {
  return instant === null ? <>Not used yet</> : <Time instant={instant} />;
}

/** The browser asking is told in words, under what it is called. */
function ThisBrowser({ browser }: { readonly browser: TrustedBrowserView }) {
  return browser.current ? <span className="trusted-browser__current">This browser</span> : null;
}

function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="pickup-card__fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/**
 * The trusted browsers of a person as the rows of a data table (staff-authentication.md section 5.8): what each is called, when it was added, when it was last used and when it
 * ends, and, where the page gives one, its act. It draws **nothing that could be used to sign in**: the shape the page was given (`parseTrustedBrowser`) has no field for a
 * credential, a hash or an authenticator, so there is nothing here to draw one from. The browser asking is marked in words. A card is the same facts under the browser's name,
 * with the act where it is read.
 */
export function trustedBrowserRows(
  action?: (browser: TrustedBrowserView) => ReactNode,
): Omit<QueueTableConfig<TrustedBrowserView>, 'label'> {
  const columns: DataColumn<TrustedBrowserView>[] = [
    {
      id: 'browser',
      header: 'Browser',
      rowHeader: true,
      cell: (row) => (
        <>
          {row.label}
          <ThisBrowser browser={row} />
        </>
      ),
    },
    { id: 'added', header: 'Added', cell: (row) => <Time instant={row.created_at} /> },
    { id: 'used', header: 'Last used', cell: (row) => <LastUsed instant={row.last_used_at} /> },
    { id: 'ends', header: 'Ends', cell: (row) => <Time instant={row.expires_at} /> },
    ...(action === undefined
      ? []
      : [{ id: 'action', header: 'Action', cell: (row: TrustedBrowserView) => action(row) }]),
  ];
  return {
    columns,
    rowId: (row) => row.id,
    density: 'two-line',
    // The browser is the card's heading, for heading navigation.
    cardTitle: (row) => row.label,
    card: (row) => (
      <>
        <ThisBrowser browser={row} />
        <dl className="pickup-card__facts">
          <Fact label="Added">
            <Time instant={row.created_at} />
          </Fact>
          <Fact label="Last used">
            <LastUsed instant={row.last_used_at} />
          </Fact>
          <Fact label="Ends">
            <Time instant={row.expires_at} />
          </Fact>
        </dl>
        {action?.(row)}
      </>
    ),
  };
}

export interface TrustedBrowserTableProps {
  readonly browsers: readonly TrustedBrowserView[];
  /** Names the table for assistive technology; the page's own heading says it to the eye. */
  readonly label: string;
  /** The level of a card's heading, so that the page's outline stays in order: 2 under the page's title (the default), 3 under a panel's heading. */
  readonly headingLevel?: 2 | 3;
  /** A control for a row (the person's own removal); the table has no action column without one. */
  readonly action?: (browser: TrustedBrowserView) => ReactNode;
}

/** The table of a record's section, where the page has already read the browsers: the same rows and cards as the page of one's own browsers. */
export function TrustedBrowserTable({
  browsers,
  label,
  headingLevel = 2,
  action,
}: TrustedBrowserTableProps) {
  return (
    <DataTable<TrustedBrowserView>
      label={label}
      rows={browsers}
      cardHeadingLevel={headingLevel}
      {...trustedBrowserRows(action)}
    />
  );
}
