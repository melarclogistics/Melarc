import type { ReactNode } from 'react';

import { Table, type TableColumn } from '../../../components/ui/table/Table';
import type { TrustedBrowserView } from '../../../platform/staff/staff-shape';
import { formatInstant } from '../../../platform/time/format-time';
import './account-pages.css';

function Time({ instant }: { readonly instant: string }) {
  const text = formatInstant(instant);
  return text === undefined ? <>Not recorded</> : <time dateTime={instant}>{text}</time>;
}

export interface TrustedBrowserTableProps {
  readonly browsers: readonly TrustedBrowserView[];
  /** Names the table for assistive technology; the page's own heading says it to the eye. */
  readonly caption: string;
  /** A control for a row (the person's own removal); the table has no action column without one. */
  readonly action?: (browser: TrustedBrowserView) => ReactNode;
}

/**
 * The trusted browsers of a person as a table (staff-authentication.md section 5.8): what each is called, when it was added, when it was last
 * used and when it ends. It draws **nothing that could be used to sign in**: the shape the page was given (`parseTrustedBrowser`) has no field
 * for a credential, a hash or an authenticator, so there is nothing here to draw one from. The browser asking is marked in words.
 */
export function TrustedBrowserTable({ browsers, caption, action }: TrustedBrowserTableProps) {
  const columns: TableColumn<TrustedBrowserView>[] = [
    {
      key: 'browser',
      header: 'Browser',
      rowHeader: true,
      cell: (row) => (
        <>
          {row.label}
          {row.current ? <span className="trusted-browser__current">This browser</span> : null}
        </>
      ),
    },
    { key: 'added', header: 'Added', cell: (row) => <Time instant={row.created_at} /> },
    {
      key: 'used',
      header: 'Last used',
      cell: (row) =>
        row.last_used_at === null ? <>Not used yet</> : <Time instant={row.last_used_at} />,
    },
    { key: 'ends', header: 'Ends', cell: (row) => <Time instant={row.expires_at} /> },
    ...(action === undefined
      ? []
      : [{ key: 'action', header: 'Action', cell: (row: TrustedBrowserView) => action(row) }]),
  ];
  return (
    <Table
      caption={caption}
      hideCaption
      columns={columns}
      rows={browsers}
      rowKey={(row) => row.id}
    />
  );
}
