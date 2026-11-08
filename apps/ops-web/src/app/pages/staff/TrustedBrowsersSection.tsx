import { useState } from 'react';

import { Alert } from '../../../components/ui/alert/Alert';
import { Button } from '../../../components/ui/button/Button';
import { ReasonConfirmationDialog } from '../../../components/ui/reason-confirmation/ReasonConfirmationDialog';
import { ReadState } from '../../../components/ui/read-state/ReadState';
import { Skeleton } from '../../../components/ui/skeleton/Skeleton';
import { useApiClient } from '../../../platform/api/api-client';
import { revokeStaffTrustedBrowsers } from '../../../platform/staff/staff-commands';
import type { TrustedBrowserView } from '../../../platform/staff/staff-shape';
import { useStaffTrustedBrowsers } from '../../../platform/staff/use-staff-queries';
import { TrustedBrowserTable } from '../account/TrustedBrowserTable';
import './staff-pages.css';

/**
 * The trusted browsers of one person, on their profile (`listStaffTrustedBrowsers`, `revokeStaffTrustedBrowsers`; staff-authentication.md section 5.8,
 * AC-SLICE-000-137): what each is called and when it was added, used and ends, and one act, *Remove all trusted browsers*, with a reason of the
 * session-revocation domain. Nothing that could be used to sign in is drawn or held.
 *
 * It is offered to a session that holds `staff.session.revoke`; the server decides the rest. The session lists keys and no tiers, so the page
 * cannot tell a Platform Admin (whose tier opens this) from a Senior Ops user (who holds the key and is refused with `INSUFFICIENT_AUTHORITY`):
 * the refusal is told in words, in place of the list. Removing leaves the person's sessions open — it ends only what lets a browser skip the
 * code. The act takes an `Idempotency-Key`, held by the dialog until the outcome is settled: a lost answer offers a retry under the same key,
 * which replays the first count and removes nothing the person has been remembered on since (audit G03 of 26 October 2026).
 */
export function TrustedBrowsersSection({
  id,
  name,
}: {
  readonly id: string;
  readonly name: string;
}) {
  const client = useApiClient();
  const browsers = useStaffTrustedBrowsers(id);
  const [asking, setAsking] = useState(false);
  const [notice, setNotice] = useState<string | undefined>(undefined);

  return (
    <section className="staff-actions" aria-labelledby="staff-trusted-browsers">
      <h2 id="staff-trusted-browsers">Trusted browsers</h2>
      <p className="staff-action__text">
        Browsers where {name} chose to skip the authenticator code at sign-in.
      </p>

      {notice === undefined ? null : (
        <Alert variant="success">
          <p>{notice}</p>
        </Alert>
      )}

      <ReadState<TrustedBrowserView[]>
        query={browsers}
        isEmpty={(data) => data.length === 0}
        empty={<p className="staff-note">{name} has no browser that skips the code.</p>}
        loadingLabel="Loading the trusted browsers…"
        skeleton={<Skeleton lines={2} />}
        permission="staff.session.revoke"
        operation="listStaffTrustedBrowsers"
      >
        {(data) => (
          <>
            <TrustedBrowserTable caption={`Trusted browsers of ${name}`} browsers={data} />
            <div className="staff-action__buttons">
              <Button
                type="button"
                variant="danger"
                onClick={() => {
                  setAsking(true);
                }}
              >
                Remove all trusted browsers
              </Button>
            </div>
          </>
        )}
      </ReadState>

      <ReasonConfirmationDialog<number>
        open={asking}
        title={`Remove the trusted browsers of ${name}?`}
        consequence={
          <p>
            Every browser {name} has chosen to remember will ask for an authenticator code at its
            next sign-in. Their open sessions stay open, and their password is still asked.
          </p>
        }
        confirmLabel="Remove trusted browsers"
        operation="revokeSession"
        copyOperation="revokeStaffTrustedBrowsers"
        retryable
        send={(command, idempotencyKey) =>
          revokeStaffTrustedBrowsers(
            client,
            id,
            {
              reasonCode: command.reasonCode,
              ...(command.note === undefined ? {} : { note: command.note }),
            },
            idempotencyKey,
          )
        }
        onDone={(count) => {
          setAsking(false);
          setNotice(
            count === 0
              ? `${name} had no trusted browser left to remove.`
              : `${String(count)} trusted ${count === 1 ? 'browser' : 'browsers'} removed.`,
          );
          void browsers.refetch();
        }}
        onCancel={() => {
          setAsking(false);
        }}
        onReload={() => {
          setAsking(false);
          return browsers.refetch();
        }}
      />
    </section>
  );
}
