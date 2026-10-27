import { useEffect, useRef, useState } from 'react';

import { PageHeader } from '../../../components/PageHeader';
import { Alert } from '../../../components/ui/alert/Alert';
import { Button } from '../../../components/ui/button/Button';
import { ConfirmationDialog } from '../../../components/ui/confirmation/ConfirmationDialog';
import { EmptyState } from '../../../components/ui/empty-state/EmptyState';
import { ReadState } from '../../../components/ui/read-state/ReadState';
import { Skeleton } from '../../../components/ui/skeleton/Skeleton';
import { useApiClient } from '../../../platform/api/api-client';
import { isNotFound } from '../../../platform/api/api-response';
import { revokeTrustedBrowser } from '../../../platform/staff/staff-commands';
import type { TrustedBrowserView } from '../../../platform/staff/staff-shape';
import { useOwnTrustedBrowsers } from '../../../platform/staff/use-staff-queries';
import { TrustedBrowserTable } from './TrustedBrowserTable';
import './account-pages.css';

/** What removing one came to: it was removed, or it had already gone (which is what was asked for). */
type Removed = 'removed' | 'already-gone';

/**
 * `/account/trusted-browsers` (`listTrustedBrowsers`, `revokeTrustedBrowser`; staff-authentication.md section 5.8, AC-SLICE-000-136, -138): the
 * browsers the signed-in person chose to be remembered at the second step, and the means to remove one. Any signed-in staff session may open it
 * and no permission is held: it is the person's own, and the server shows nobody else's.
 *
 * A person whose role signs in without an authenticator has none, and the page says that plainly rather than showing an unexplained empty
 * list. Removing one is a confirmation, and says what it means: that browser will ask for a code at its next sign-in, and for the browser in use
 * that is this one. It is removed at once (the credential stops standing in for the code), and one that is already gone reads as done. The page
 * shows labels and dates and **no credential** — it has none to show, and the list is read again after every removal so what is drawn is what
 * is in force.
 */
export function TrustedBrowsersPage() {
  const client = useApiClient();
  const browsers = useOwnTrustedBrowsers();
  const [target, setTarget] = useState<TrustedBrowserView | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const noticeBox = useRef<HTMLDivElement>(null);

  // The news replaces what the person was looking at, so a keyboard user lands on it.
  useEffect(() => {
    if (notice !== undefined) noticeBox.current?.focus();
  }, [notice]);

  function refresh(): Promise<unknown> {
    return browsers.refetch();
  }

  return (
    <>
      <title>Trusted browsers · Melarc Ops Portal</title>
      <PageHeader
        title="Trusted browsers"
        description="Browsers where you chose not to be asked for an authenticator code."
      />
      <p className="trusted-browsers__note">
        Your password is still asked every time. Remove a browser you no longer use, or one you do
        not recognise.
      </p>

      {notice === undefined ? null : (
        <div className="trusted-browsers__notice" ref={noticeBox} tabIndex={-1}>
          <Alert variant="success">
            <p>{notice}</p>
          </Alert>
        </div>
      )}

      <ReadState<TrustedBrowserView[]>
        query={browsers}
        isEmpty={(data) => data.length === 0}
        empty={
          <EmptyState kind="none" heading="No trusted browsers">
            None of your browsers is remembered. You can choose to remember one when you enter your
            authenticator code to sign in. Roles that sign in without an authenticator have nothing
            to remember.
          </EmptyState>
        }
        loadingLabel="Loading your trusted browsers…"
        skeleton={<Skeleton lines={3} />}
        operation="listTrustedBrowsers"
      >
        {(data) => (
          <TrustedBrowserTable
            caption="Your trusted browsers"
            browsers={data}
            action={(row) => (
              <Button
                type="button"
                variant="danger"
                aria-label={`Remove ${row.label}${row.current ? ' (this browser)' : ''}`}
                onClick={() => {
                  setTarget(row);
                }}
              >
                Remove
              </Button>
            )}
          />
        )}
      </ReadState>

      <ConfirmationDialog<Removed>
        open={target !== undefined}
        title="Remove this browser?"
        consequence={
          <p>
            {target?.current === true
              ? 'This is the browser you are using. '
              : `${target?.label ?? 'That browser'} `}
            {target?.current === true
              ? 'It will ask for an authenticator code the next time you sign in. Your session stays open.'
              : 'will ask for an authenticator code the next time you sign in on it.'}
          </p>
        }
        confirmLabel="Remove browser"
        confirmVariant="danger"
        operation="revokeTrustedBrowser"
        retryable
        send={async () => {
          try {
            await revokeTrustedBrowser(client, target?.id ?? '');
            return 'removed' as const;
          } catch (error) {
            // A browser that is already gone — removed from another tab, or past its seven days — is what was asked for.
            if (isNotFound(error)) return 'already-gone' as const;
            throw error;
          }
        }}
        onDone={(result) => {
          setTarget(undefined);
          setNotice(
            result === 'already-gone'
              ? 'That browser had already been removed.'
              : 'The browser is removed. It will ask for a code at its next sign-in.',
          );
          void refresh();
        }}
        onCancel={() => {
          setTarget(undefined);
        }}
        onReload={() => {
          setTarget(undefined);
          return refresh();
        }}
      />
    </>
  );
}
