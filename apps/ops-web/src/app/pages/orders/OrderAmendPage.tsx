import { useEffect, useRef, useState, type SubmitEvent } from 'react';
import { useNavigate, useParams } from 'react-router';

import { PageHeading } from '../../../components/PageHeading';
import { Alert } from '../../../components/ui/alert/Alert';
import { ButtonLink } from '../../../components/ui/button/ButtonLink';
import { useUploadGate } from '../../../components/ui/evidence-upload/UploadGate';
import { focusFirstInvalid } from '../../../components/ui/form/use-submission';
import { HubFloor } from '../../../components/ui/hub-floor/HubFloor';
import { PageHeader } from '../../../components/ui/page-header/PageHeader';
import { ReadState } from '../../../components/ui/read-state/ReadState';
import { Skeleton } from '../../../components/ui/skeleton/Skeleton';
import { TaskForm } from '../../../components/ui/templates/TaskForm';
import { useApiClient } from '../../../platform/api/api-client';
import {
  amendPatchOf,
  amendSaveBodyOf,
  isEmptyPatch,
  problemsWith,
  valuesOf,
  type OrderField,
  type OrderFieldErrors,
  type OrderFormValues,
} from '../../../platform/hub-orders/order-form-model';
import { amendOrder, previewOrderAmendment } from '../../../platform/hub-orders/orders-commands';
import { useOrder, type OrderRecordView } from '../../../platform/hub-orders/use-orders-queries';
import { ORDERS_WORDS as WORDS } from '../../../platform/problem/orders-copy';
import { copyFor } from '../../../platform/problem/problem-copy';
import { UUID } from '../staff/WithProfile';
import { OrderFields } from './OrderFields';
import { FlowActions, FlowAlerts } from './OrderFlowParts';
import { OrderReview } from './OrderReview';
import { refusedFields } from './order-refusal-fields';
import { orderPath, ordersPath, TO_MAKE_CRUMB } from './orders-presentation';
import { useOrderFlow } from './use-order-flow';
import './orders-pages.css';

const F = WORDS.form;

function AmendForm({
  record,
  reload,
}: {
  readonly record: OrderRecordView;
  readonly reload: () => Promise<OrderRecordView | undefined>;
}) {
  const client = useApiClient();
  const navigate = useNavigate();
  const { order } = record;
  const intakeId = order.pickup_intake_id ?? '';
  const [initial] = useState<OrderFormValues>(() => valuesOf(order));
  const [values, setValues] = useState<OrderFormValues>(initial);
  const [invalid, setInvalid] = useState<OrderFieldErrors>({});
  const [attempts, setAttempts] = useState(0);
  const [nothing, setNothing] = useState(false);
  // The code of the order once the change is saved: the page follows it to the order (below), not in the same breath.
  const [saved, setSaved] = useState<string | undefined>(undefined);
  const form = useRef<HTMLFormElement>(null);
  const version = useRef(record.etag);
  const gate = useUploadGate();

  const flow = useOrderFlow({
    operation: 'amendOrder',
    previewOperation: 'previewOrderAmendment',
    preview: (current) =>
      previewOrderAmendment(client, order.id, intakeId, amendPatchOf(initial, current)),
    save: (command, key) =>
      amendOrder(
        client,
        order.id,
        amendSaveBodyOf(
          amendPatchOf(initial, command.values),
          command.values.reason,
          command.token,
        ),
        command.version,
        key,
      ),
    version: () => version.current,
    reload: async () => {
      const read = await reload();
      if (read !== undefined) version.current = read.etag;
    },
    onSaved: (done) => {
      setSaved(done.code);
    },
  });
  const { stage, command } = flow;
  const reviewing = stage.kind === 'reviewing';
  const fromServer = refusedFields(
    command.phase === 'refused' ? command.problem : flow.checkProblem,
  );
  const tiedToAField = Object.keys(fromServer).length > 0;
  const locked = command.locked || stage.kind === 'checking';
  const errors: OrderFieldErrors = { ...fromServer, ...invalid };

  useEffect(() => {
    // A form that was sent holds nothing unsaved: the guard against leaving is off once `saved` is set, and only then does the page go on to the order, with the word that it was changed.
    if (saved !== undefined) void navigate(orderPath(order.id), { state: { amended: saved } });
  }, [saved, navigate, order.id]);
  useEffect(() => {
    if (attempts > 0) focusFirstInvalid(form.current);
  }, [attempts]);
  useEffect(() => {
    if (flow.checkProblem !== undefined) focusFirstInvalid(form.current);
  }, [flow.checkProblem]);
  useEffect(() => {
    // A save refused about a field has brought the form back: the first field it names is where the officer's eyes go.
    if (command.phase === 'refused' && stage.kind === 'editing' && tiedToAField) {
      focusFirstInvalid(form.current);
    }
  }, [command.phase, stage.kind, tiedToAField]);

  useEffect(() => {
    if (command.phase === 'unknown')
      form.current?.querySelector<HTMLElement>('[data-recovery]')?.focus();
  }, [command.phase]);

  function change(patch: Partial<OrderFormValues>, ...fields: OrderField[]): void {
    setValues((current) => ({ ...current, ...patch }));
    setNothing(false);
    if (fields.length > 0) {
      setInvalid((current) => {
        const next: Partial<Record<OrderField, string>> = { ...current };
        for (const field of fields) next[field] = undefined;
        return next;
      });
    }
    flow.changed();
    if ('address' in patch || 'landmark' in patch) flow.clearCandidates();
  }

  function send(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (command.locked || stage.kind === 'checking') return;
    if (stage.kind === 'reviewing') {
      flow.confirm(values);
      return;
    }
    if (gate.busy) return;
    const found = problemsWith(values, {
      amendment: true,
      zoneNeeded: flow.candidates !== undefined,
    });
    setInvalid(found);
    if (Object.keys(found).length > 0) {
      setAttempts((count) => count + 1);
      return;
    }
    // Nothing was changed is told before anything is sent: the server would say the same.
    if (isEmptyPatch(amendPatchOf(initial, values))) {
      setNothing(true);
      return;
    }
    void flow.check(values);
  }

  return (
    <TaskForm
      formRef={form}
      busy={stage.kind === 'checking' || command.phase === 'sending'}
      dirty={saved === undefined && values !== initial}
      onSubmit={send}
      alerts={
        <>
          {nothing ? (
            <Alert variant="danger" announce>
              <p>{F.errors.noChange}</p>
            </Alert>
          ) : null}
          <FlowAlerts flow={flow} tiedToAField={tiedToAField} />
        </>
      }
      summary={{
        title: F.summary.title,
        children: (
          <>
            {F.summary.lines.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </>
        ),
      }}
      review={{
        active: reviewing,
        title: WORDS.review.title,
        backLabel: F.acts.back,
        onBack: flow.back,
        children: reviewing ? <OrderReview terms={stage.terms} earlier={stage.earlier} /> : null,
      }}
      actions={
        <FlowActions
          flow={flow}
          gate={gate}
          cancelTo={orderPath(order.id)}
          confirm={F.acts.saveChange}
          lookLabel={WORDS.record.acts.openVendor}
        />
      }
      header={{
        title: F.amendTitle(order.code),
        description: F.amendDescription,
        breadcrumb: [
          TO_MAKE_CRUMB,
          ...(order.pickup_intake_id === null
            ? []
            : [{ label: F.breadcrumbOrders, to: ordersPath(order.pickup_intake_id) }]),
          { label: order.code, to: orderPath(order.id) },
        ],
      }}
    >
      <OrderFields
        values={values}
        errors={errors}
        locked={locked}
        intakeId={intakeId}
        candidates={flow.candidates}
        gate={gate}
        amendment
        change={change}
      />
    </TaskForm>
  );
}

/** What stops an order being changed: its price is fixed, its arrival was taken back, or its parcel is gone. It is the record's own, read before the form is drawn. */
function whyNot(record: OrderRecordView): string | undefined {
  const { order } = record;
  if (order.commercial_state === 'REVERSED') return F.amendReversed;
  if (order.price_status === 'FROZEN') return F.amendNotAllowed;
  return undefined;
}

function Reading({ id }: { readonly id: string }) {
  const query = useOrder(id);
  const loaded = query.status === 'success';
  return (
    <>
      <title>{`${loaded ? F.amendTitle(query.data.order.code) : F.documentTitle} · Melarc Ops Portal`}</title>
      <HubFloor>
        {loaded ? null : <PageHeader title={F.documentTitle} />}
        <ReadState<OrderRecordView>
          query={query}
          isEmpty={() => false}
          empty={null}
          loadingLabel={WORDS.record.loading}
          skeleton={<Skeleton lines={4} />}
          permission="pricing.read"
          operation="getOrder"
        >
          {(record) => {
            const reason = whyNot(record);
            return reason === undefined ? (
              <AmendForm record={record} reload={async () => (await query.refetch()).data} />
            ) : (
              <>
                <PageHeader title={F.amendTitle(record.order.code)} />
                <p className="orders-note">{reason}</p>
                <div className="orders-saved__acts">
                  <ButtonLink to={orderPath(record.order.id)} variant="secondary" size="lg">
                    {WORDS.record.acts.openVendor}
                  </ButtonLink>
                </div>
              </>
            );
          }}
        </ReadState>
      </HubFloor>
    </>
  );
}

/**
 * Change an order (surfaces/ops-portal.md section 7, `/orders/{id}/amend`; S1.40; `previewOrderAmendment` then `amendOrder`, `hub.intake.itemize`; AC-SLICE-001-47 to 59): **an order is prepared before it is
 * confirmed.** While its price is not fixed, an officer corrects what was written down, with a reason, and the server works the price, the zone and the date out again from the corrected facts; the officer
 * checks them beside the price the order holds now before anything is saved. Only what the officer changed is sent (a member not named is kept), on the version of the order that was read, so that an order that
 * changed since is told and never overwritten. An order whose price is fixed is never edited here: who pays is a correction and a mistaken arrival is for a senior officer to take back.
 */
export function OrderAmendPage() {
  const { id = '' } = useParams();
  if (!UUID.test(id)) {
    return (
      <>
        <title>{`${WORDS.common.notFoundOrder} · Melarc Ops Portal`}</title>
        <PageHeading>{WORDS.common.notFoundOrder}</PageHeading>
        <p>{copyFor({ operation: 'getOrder', code: 'NOT_FOUND' }) ?? WORDS.common.notFoundOrder}</p>
      </>
    );
  }
  return <Reading key={id} id={id} />;
}
