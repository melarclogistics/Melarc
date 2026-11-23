import type { UseQueryResult } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode, type SubmitEvent } from 'react';
import { useParams } from 'react-router';

import { Alert } from '../../../components/ui/alert/Alert';
import { Button } from '../../../components/ui/button/Button';
import { ButtonLink } from '../../../components/ui/button/ButtonLink';
import { DescriptionList } from '../../../components/ui/description-list/DescriptionList';
import { Field } from '../../../components/ui/field/Field';
import { Link } from '../../../components/ui/link/Link';
import { ReadState } from '../../../components/ui/read-state/ReadState';
import { Skeleton } from '../../../components/ui/skeleton/Skeleton';
import { Textarea } from '../../../components/ui/textarea/Textarea';
import { TaskForm, TaskFormSection } from '../../../components/ui/templates/TaskForm';
import { useApiClient } from '../../../platform/api/api-client';
import { closeIntake, type CloseOutcome } from '../../../platform/hub-orders/orders-commands';
import type { ClosureView } from '../../../platform/hub-orders/orders-shape';
import { useClosure } from '../../../platform/hub-orders/use-orders-queries';
import type { IntakeRecordView } from '../../../platform/hub-receiving/use-intake-record';
import { ORDERS_WORDS as WORDS } from '../../../platform/problem/orders-copy';
import { useSignedInSession } from '../../../platform/session/use-permissions';
import { formatInstant } from '../../../platform/time/format-time';
import { ActDialog } from '../manifests/ManifestActDialogs';
import { recordPath } from '../receiving/receiving-presentation';
import { WithRecord } from '../receiving/WithRecord';
import { OrderPhoto } from './OrderPhoto';
import { ordersPath, RECEIVING_PATH, summaryPath } from './orders-presentation';
import { vendorFactsOf, type VendorFacts } from './vendor-facts';
import './orders-pages.css';

const C = WORDS.close;

interface CloseCommand {
  readonly reviewedAssessment: string;
  readonly exceptionNote?: string;
}

/** A figure the server gave, or the words for one it did not (the count of a vendor not counted yet is awaited, which is not nothing). */
const knownOr = (value: number | null): string =>
  value === null ? C.facts.awaitingCount : String(value);

/** What closing finds, each figure apart: received, made, still without an order, not priced, payment due and missing. The page adds nothing up. */
function Facts({ closure }: { readonly closure: ClosureView }) {
  return (
    <DescriptionList
      items={[
        { label: C.facts.received, value: knownOr(closure.received) },
        { label: C.facts.ordered, value: String(closure.ordered) },
        { label: C.facts.outstanding, value: knownOr(closure.outstanding_count) },
        { label: C.facts.unpriced, value: String(closure.unpriced) },
        { label: C.facts.paymentDue, value: String(closure.payment_required) },
        { label: C.facts.missing, value: String(closure.missing) },
      ]}
    />
  );
}

/** The parcels that were received and have no order, named by their place and their photo: the first hundred, with the way to the rest. */
function Outstanding({
  closure,
  intakeId,
}: {
  readonly closure: ClosureView;
  readonly intakeId: string;
}) {
  if (closure.outstanding_parcels.length === 0) return null;
  const total = closure.outstanding_count ?? closure.outstanding_parcels.length;
  return (
    <TaskFormSection title={C.sections.parcels}>
      <ul className="orders-outstanding">
        {closure.outstanding_parcels.map((parcel) => {
          const title =
            parcel.origin === 'HUB_EXTRA'
              ? WORDS.common.extraParcel(parcel.ordinal)
              : WORDS.common.parcel(parcel.ordinal);
          return (
            <li key={parcel.parcel_id} className="orders-outstanding__item">
              <OrderPhoto parcel={parcel} size="tile" alt={title} />
              <span>{title}</span>
            </li>
          );
        })}
      </ul>
      {total > closure.outstanding_parcels.length ? (
        <p className="orders-note">
          {C.displayLimit(closure.outstanding_parcels.length, total)}{' '}
          <Link to={ordersPath(intakeId)}>{C.seeAllOutstanding}</Link>
        </p>
      ) : null}
    </TaskFormSection>
  );
}

function ClosedPanel({
  facts,
  closure,
  withException,
  paymentDue,
}: {
  readonly facts: VendorFacts;
  readonly closure: ClosureView | undefined;
  readonly withException: boolean;
  readonly paymentDue: number;
}) {
  const me = useSignedInSession();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.focus();
  }, []);
  return (
    <div className="orders-saved" ref={box} tabIndex={-1}>
      <Alert variant="success">
        <p>{withException ? C.done.closedWithException : C.done.closed}</p>
        {paymentDue > 0 ? <p>{C.done.paymentDue(paymentDue)}</p> : null}
      </Alert>
      {closure?.closed_at === null || closure === undefined ? null : (
        <p className="orders-note">{`${WORDS.summary.closedAt}: ${formatInstant(closure.closed_at) ?? ''}`}</p>
      )}
      <p className="orders-note">{C.paymentStill}</p>
      <div className="orders-saved__acts">
        {me?.holds('pickup.read') === true ? (
          <ButtonLink to={summaryPath(facts.id)} size="lg">
            {C.seeSummary}
          </ButtonLink>
        ) : null}
        <ButtonLink to={RECEIVING_PATH} variant="secondary" size="lg">
          {WORDS.common.receiving}
        </ButtonLink>
      </div>
    </div>
  );
}

function CloseForm({
  facts,
  vendorName,
  closure,
  refetchBoth,
  onAssessment,
}: {
  readonly facts: VendorFacts;
  readonly vendorName: string | undefined;
  readonly closure: ClosureView;
  readonly refetchBoth: () => Promise<unknown>;
  /** The close answered that what closing finds is not what the senior read: the assessment as it is. */
  readonly onAssessment: (current: ClosureView) => void;
}) {
  const client = useApiClient();
  const me = useSignedInSession();
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | undefined>(undefined);
  const [confirming, setConfirming] = useState<'parity' | 'exception' | undefined>(undefined);
  const [notice, setNotice] = useState<'changed' | 'stale' | undefined>(undefined);
  const [closed, setClosed] = useState<{ exception: boolean } | undefined>(undefined);
  const form = useRef<HTMLFormElement>(null);
  if (me === undefined) return null;
  const mayClose = me.holds('hub.intake.close');
  const mayException = me.holds('hub.intake.close_exception');

  if (closed !== undefined) {
    return (
      <ClosedPanel
        facts={facts}
        closure={closure}
        withException={closed.exception}
        paymentDue={closure.payment_required}
      />
    );
  }
  if (closure.closed_at !== null || closure.intake_state === 'CLOSED') {
    return (
      <div className="orders-saved">
        <p className="orders-note">
          {closure.parity_exception_note === null
            ? C.standing.closed
            : C.standing.closedWithException}
        </p>
        {closure.parity_exception_note === null ? null : (
          <DescriptionList
            items={[
              { label: WORDS.closedExceptions.facts.reason, value: closure.parity_exception_note },
            ]}
          />
        )}
        <div className="orders-saved__acts">
          {me.holds('pickup.read') ? (
            <ButtonLink to={summaryPath(facts.id)} size="lg">
              {C.seeSummary}
            </ButtonLink>
          ) : null}
          <ButtonLink to={ordersPath(facts.id)} variant="secondary" size="lg">
            {C.acts.cancel}
          </ButtonLink>
        </div>
      </div>
    );
  }

  const blocked = closure.blockers.length > 0;
  const exceptionWay = closure.needs_exception && !blocked;
  const standing = blocked
    ? C.standing.notReady
    : closure.can_close
      ? C.standing.ready
      : closure.needs_exception
        ? C.standing.needsException
        : C.standing.notReady;

  function submit(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (blocked) return;
    if (exceptionWay) {
      if (!mayException) return;
      if (reason.trim() === '') {
        setReasonError(C.exception.reasonRequired);
        form.current?.querySelector<HTMLElement>('textarea')?.focus();
        return;
      }
      setConfirming('exception');
      return;
    }
    if (closure.can_close && mayClose) setConfirming('parity');
  }

  const dialog: ReactNode =
    confirming === undefined ? null : (
      <ActDialog<CloseCommand, CloseOutcome>
        open
        title={C.confirm.title}
        consequence={
          <>
            <p>{C.confirm.body(closure.received, closure.ordered)}</p>
            {confirming === 'exception' ? (
              <p>
                {C.confirm.exceptionBody(
                  closure.outstanding_count ?? closure.outstanding_parcels.length,
                )}
              </p>
            ) : null}
            <p>{C.paymentStill}</p>
          </>
        }
        confirmLabel={C.confirm.yes}
        confirmVariant="primary"
        cancelLabel={C.confirm.no}
        size="lg"
        operation="closeHubIntake"
        retryable
        build={() => ({
          reviewedAssessment: closure.assessment_token,
          ...(confirming === 'exception' ? { exceptionNote: reason.trim() } : {}),
        })}
        send={(command, key) =>
          closeIntake(
            client,
            facts.id,
            {
              reviewedAssessment: command.reviewedAssessment,
              ...(command.exceptionNote === undefined
                ? {}
                : { exceptionNote: command.exceptionNote }),
            },
            facts.etag,
            key,
          )
        }
        onDone={(outcome) => {
          setConfirming(undefined);
          if (outcome.kind === 'closed') {
            setClosed({ exception: confirming === 'exception' });
            return;
          }
          // What closing finds is not what the senior read: the assessment as it is is shown, the reason typed stays, and the officer confirms again.
          setNotice('changed');
          onAssessment(outcome.current);
        }}
        onCancel={() => {
          setConfirming(undefined);
        }}
        onReload={() => {
          // The vendor or what closing finds changed under the officer: both are read again, the reason typed stays, and the officer confirms again.
          setConfirming(undefined);
          setNotice('stale');
          return refetchBoth();
        }}
      />
    );

  const alerts: ReactNode = (
    <>
      {notice === undefined ? null : (
        <Alert variant="danger" announce>
          <p className="orders-review__changed-title">
            {notice === 'changed' ? C.changed.title : C.stale.title}
          </p>
          <p>{notice === 'changed' ? C.changed.text : C.stale.text}</p>
        </Alert>
      )}
      {closure.blockers.map((blocker) => (
        <Alert key={blocker} variant="danger" announce>
          <p>{C.blockers[blocker]}</p>
        </Alert>
      ))}
    </>
  );

  return (
    <>
      <TaskForm
        formRef={form}
        onSubmit={submit}
        alerts={alerts}
        dirty={reason !== ''}
        header={{
          title: C.title(vendorName),
          description: C.description,
          breadcrumb: [
            { label: WORDS.common.receiving, to: RECEIVING_PATH },
            { label: vendorName ?? facts.code, to: recordPath(facts.id) },
            { label: WORDS.form.breadcrumbOrders, to: ordersPath(facts.id) },
          ],
        }}
        actions={
          <>
            {!blocked && ((exceptionWay && mayException) || (closure.can_close && mayClose)) ? (
              <Button type="submit" size="lg">
                {exceptionWay ? C.acts.closeWithException : C.acts.close}
              </Button>
            ) : null}
            <Link to={ordersPath(facts.id)}>{C.acts.cancel}</Link>
          </>
        }
      >
        <TaskFormSection title={C.sections.facts}>
          <p className="orders-note">{standing}</p>
          <Facts closure={closure} />
          {closure.excess_count > 0 ? (
            <p className="orders-note">{C.blockers.orders_exceed_received}</p>
          ) : null}
        </TaskFormSection>
        <Outstanding closure={closure} intakeId={facts.id} />
        {exceptionWay ? (
          <TaskFormSection title={C.sections.exception}>
            {mayException ? (
              <>
                <p className="orders-note">{C.exception.intro}</p>
                <Field
                  label={C.exception.reasonLabel}
                  help={C.exception.reasonHelp}
                  required
                  {...(reasonError === undefined ? {} : { error: reasonError })}
                >
                  <Textarea
                    name="reason"
                    rows={3}
                    maxLength={1000}
                    value={reason}
                    onChange={(event) => {
                      setReason(event.target.value);
                      setReasonError(undefined);
                    }}
                  />
                </Field>
              </>
            ) : (
              <p className="orders-note">{C.exception.mustAsk}</p>
            )}
          </TaskFormSection>
        ) : null}
        <p className="orders-note">{C.paymentStill}</p>
      </TaskForm>
      {dialog}
    </>
  );
}

function Closing({
  record,
  query,
}: {
  readonly record: IntakeRecordView;
  readonly query: UseQueryResult<IntakeRecordView>;
}) {
  const facts = vendorFactsOf(record);
  const read = useClosure(facts.id);
  // The closure the close answered with (what closing finds now, when it is not what the senior read) belongs to the read it answered: a closure read again is the last word, so the replacement is left behind.
  const [answered, setAnswered] = useState<
    { readonly read: number; readonly closure: ClosureView } | undefined
  >(undefined);
  const replacement = answered?.read === read.dataUpdatedAt ? answered.closure : undefined;
  const vendorName = record.kind === 'check-in' ? record.view.vendor_name : undefined;
  return (
    <ReadState<ClosureView>
      query={read}
      isEmpty={() => false}
      empty={null}
      loadingLabel={C.loading}
      skeleton={<Skeleton lines={4} />}
      permission="hub.intake.close"
      operation="getIntakeClosure"
    >
      {(closure) => (
        <CloseForm
          facts={facts}
          vendorName={vendorName}
          closure={replacement ?? closure}
          refetchBoth={() => Promise.all([query.refetch(), read.refetch()])}
          onAssessment={(current) => {
            setAnswered({ read: read.dataUpdatedAt, closure: current });
          }}
        />
      )}
    </ReadState>
  );
}

/**
 * Close a vendor (surfaces/ops-portal.md section 7, `/intakes/{id}/close`; S1.40; `getIntakeClosure` then `closeHubIntake`, `hub.intake.close`; the exception under `hub.intake.close_exception`; AC-SLICE-001-51, -52):
 * **the officer closes with the facts in front of them**: what was received, how many orders stand for those parcels, what is still without an order (named, with its photo: the first hundred, with the way
 * to the rest), what is not priced, what waits for payment and what is missing, each apart, and the page adds none of them up. An unpriced order of a parcel that arrived blocks the close, and so does a surplus of
 * orders. **The way past a vendor with parcels still to order is the senior officer's exception**: the reason is written against the facts the senior read (the digest of what closing found), and when the facts changed
 * since, the new ones are shown, the reason stays and the senior confirms again. **Closing is not payment and sends nothing out**: payment that is still due is said after a close. A lost answer is sent again under the
 * same key and never closes twice.
 */
export function ClosePage() {
  const { id = '' } = useParams();
  return (
    <WithRecord
      id={id}
      ownsHeading
      named
      heading={(_record, vendor) => ({
        title: C.title(vendor),
        documentTitle: C.documentTitle,
      })}
      breadcrumb={() => [{ label: WORDS.common.receiving, to: RECEIVING_PATH }]}
    >
      {(record, query) => <Closing record={record} query={query} />}
    </WithRecord>
  );
}
