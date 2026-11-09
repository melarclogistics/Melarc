import { useEffect, useRef, useState } from 'react';

import { Alert } from '../../../components/ui/alert/Alert';
import { Button } from '../../../components/ui/button/Button';
import { ConfirmationDialog } from '../../../components/ui/confirmation/ConfirmationDialog';
import { EmptyStateV2 } from '../../../components/ui/empty-state/EmptyStateV2';
import { QueueWorkspace, type QueueResult } from '../../../components/ui/templates/QueueWorkspace';
import { useApiClient } from '../../../platform/api/api-client';
import { isNotFound } from '../../../platform/api/api-response';
import { problemOf } from '../../../platform/problem/problem-copy';
import { revokeTrustedBrowser } from '../../../platform/staff/staff-commands';
import type { TrustedBrowserView } from '../../../platform/staff/staff-shape';
import { useOwnTrustedBrowsers } from '../../../platform/staff/use-staff-queries';
import { formatInstant } from '../../../platform/time/format-time';
import { trustedBrowserRows } from './TrustedBrowserTable';
import './account-pages.css';

/** What removing one came to: it was removed, or it had already gone (which is what was asked for). */
type Removed = 'removed' | 'already-gone';

/**
 * `/account/trusted-browsers` (`listTrustedBrowsers`, `revokeTrustedBrowser`; staff-authentication.md section 5.8, AC-SLICE-000-136, -138): the
 * browsers the signed-in person chose to be remembered at the second step, and the means to remove one. Any signed-in staff session may open it
 * and no permission is held: it is the person's own, and the server shows nobody else's. It is drawn by the queue workspace template (redesign
 * step R7b): the browsers are its rows, a table that is cards in a narrow room, each with its removal where it is read. The list is not paged,
 * filtered or counted, so the template shows no views, filters or pager.
 *
 * A person whose role signs in without an authenticator has none, and the page says that plainly rather than showing an unexplained empty
 * list. Removing one is a confirmation, and says what it means: that browser will ask for a code at its next sign-in, and for the browser in use
 * that is this one. It is removed at once (the credential stops standing in for the code), and one that is already gone reads as done. The page
 * shows labels and dates and **no credential** — it has none to show, and the list is read again after every removal so what is shown is what
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

  const updatedAt =
    browsers.dataUpdatedAt > 0
      ? formatInstant(new Date(browsers.dataUpdatedAt).toISOString())
      : undefined;

  const result: QueueResult<TrustedBrowserView> = (() => {
    if (browsers.status === 'pending') return { status: 'loading' };
    if (browsers.status === 'error') {
      const problem = problemOf(browsers.error, { operation: 'listTrustedBrowsers' });
      // A session that has ended or an answer that is stale is the session boundary's, which has already taken the person away.
      if (problem.kind === 'session-ended' || problem.kind === 'stale') {
        return { status: 'loading' };
      }
      const retryable = problem.kind === 'unavailable' || problem.kind === 'rate-limited';
      return {
        status: 'error',
        message:
          problem.reference === undefined
            ? problem.message
            : `${problem.message} Reference: ${problem.reference}`,
        ...(retryable
          ? {
              onRetry: () => {
                void browsers.refetch();
              },
            }
          : {}),
      };
    }
    // The list is read again after a removal and its rows stay where they are while it is.
    return { status: 'ready', rows: browsers.data, refreshing: browsers.isFetching };
  })();

  return (
    <>
      <title>Trusted browsers · Melarc Ops Portal</title>
      <QueueWorkspace<TrustedBrowserView>
        header={{
          title: 'Trusted browsers',
          description:
            'Browsers where you chose not to be asked for an authenticator code. Your password is still asked every time.',
          freshness: {
            state: browsers.isFetching ? 'refreshing' : browsers.isError ? 'failed' : 'idle',
            ...(updatedAt === undefined ? {} : { updatedAt }),
            onRefresh: () => {
              void browsers.refetch({ cancelRefetch: false });
            },
          },
        }}
        notice={
          notice === undefined ? undefined : (
            <div className="trusted-browsers__notice" ref={noticeBox} tabIndex={-1}>
              <Alert variant="success">
                <p>{notice}</p>
              </Alert>
            </div>
          )
        }
        result={result}
        empty={{
          noun: 'trusted browsers',
          none: 'None of your browsers is remembered.',
        }}
        emptyState={
          <EmptyStateV2 variant="empty" title="No trusted browsers" headingLevel={3}>
            None of your browsers is remembered. You can choose to remember one when you enter your
            authenticator code to sign in. Roles that sign in without an authenticator have nothing
            to remember.
          </EmptyStateV2>
        }
        table={{
          label: 'Your trusted browsers',
          ...trustedBrowserRows((row) => (
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
          )),
        }}
      />

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
