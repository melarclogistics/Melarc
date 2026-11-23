import { useEffect, useRef, useState, type SubmitEvent } from 'react';
import { Navigate, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';

import { Alert } from '../../../components/ui/alert/Alert';
import { ButtonLink } from '../../../components/ui/button/ButtonLink';
import { useUploadGate } from '../../../components/ui/evidence-upload/UploadGate';
import { focusFirstInvalid } from '../../../components/ui/form/use-submission';
import { Skeleton } from '../../../components/ui/skeleton/Skeleton';
import { TaskForm } from '../../../components/ui/templates/TaskForm';
import { useApiClient } from '../../../platform/api/api-client';
import {
  EMPTY_ORDER_FORM,
  previewBodyOf,
  problemsWith,
  saveBodyOf,
  type OrderField,
  type OrderFieldErrors,
  type OrderFormValues,
} from '../../../platform/hub-orders/order-form-model';
import {
  itemizeOrder,
  previewOrder,
  type SavedOrderView,
} from '../../../platform/hub-orders/orders-commands';
import { useWorklist } from '../../../platform/hub-orders/use-orders-queries';
import type { IntakeRecordView } from '../../../platform/hub-receiving/use-intake-record';
import { ORDERS_WORDS as WORDS } from '../../../platform/problem/orders-copy';
import { problemOf } from '../../../platform/problem/problem-copy';
import { recordPath } from '../receiving/receiving-presentation';
import { WithRecord } from '../receiving/WithRecord';
import { OrderFields } from './OrderFields';
import { FlowActions, FlowAlerts } from './OrderFlowParts';
import { OrderPhoto } from './OrderPhoto';
import { OrderReview } from './OrderReview';
import { refusedFields } from './order-refusal-fields';
import {
  closePath,
  newOrderPath,
  orderPath,
  ordersPath,
  RECEIVING_PATH,
} from './orders-presentation';
import { useOrderFlow } from './use-order-flow';
import { vendorFactsOf, type VendorFacts } from './vendor-facts';
import { useSignedInSession } from '../../../platform/session/use-permissions';
import { UUID } from '../staff/WithProfile';
import './orders-pages.css';

const F = WORDS.form;

/** The parcel the form is for, as the vendor's record knows it: its place in the list and its photo. A vendor counted without photos has none. */
interface ParcelFacts {
  readonly id: string;
  readonly ordinal: number;
  readonly origin: 'DOOR_PHOTO' | 'HUB_EXTRA';
  readonly photo_evidence_id: string;
  readonly state: string;
}

function parcelOf(record: IntakeRecordView, parcelId: string): ParcelFacts | undefined {
  if (record.kind !== 'check-in') return undefined;
  const found = record.view.parcels.find(
    (parcel) => parcel.id.toLowerCase() === parcelId.toLowerCase(),
  );
  return found === undefined
    ? undefined
    : {
        id: found.id,
        ordinal: found.ordinal,
        origin: found.origin,
        photo_evidence_id: found.photo_evidence_id,
        state: found.state,
      };
}

/** Where the officer goes after an order is saved, and what is left: counted by the server for the whole vendor, never by the page. */
function Saved({
  facts,
  order,
  onReload,
}: {
  readonly facts: VendorFacts;
  readonly order: SavedOrderView;
  /** Reads the vendor again, for its version. */
  readonly onReload: () => Promise<unknown>;
}) {
  const me = useSignedInSession();
  const navigate = useNavigate();
  const box = useRef<HTMLDivElement>(null);
  const left = useWorklist(facts.id, { view: 'needs_order', pageSize: 1 });
  useEffect(() => {
    box.current?.focus();
  }, []);
  const remaining = left.data?.progress.needs_order ?? undefined;
  return (
    <div className="orders-saved" ref={box} tabIndex={-1}>
      <Alert variant="success">
        <p>{F.done(order.code)}</p>
      </Alert>
      {remaining === undefined ? null : (
        <p className="orders-note">
          {remaining > 0
            ? facts.mode === 'BLIND_COUNT'
              ? WORDS.workspace.blind.remaining(remaining)
              : `${String(remaining)} ${remaining === 1 ? 'parcel needs' : 'parcels need'} an order.`
            : WORDS.workspace.notes.allDone}
        </p>
      )}
      <div className="orders-saved__acts">
        {remaining === undefined || remaining > 0 ? (
          <ButtonLink
            to={newOrderPath(facts.id)}
            size="lg"
            onClick={(event) => {
              // The first order of a vendor moves it from ready to being worked, and its version with it: the next order is made on the vendor as it is now, read before the next form opens, or its
              // save would be refused as stale and the officer would have to check the price again for nothing. A click that opens a new tab or window is left alone.
              if (
                event.button !== 0 ||
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey
              )
                return;
              event.preventDefault();
              void onReload().then(() => navigate(newOrderPath(facts.id)));
            }}
          >
            {WORDS.workspace.acts.makeNext}
          </ButtonLink>
        ) : me?.holds('hub.intake.close') === true ? (
          <ButtonLink to={closePath(facts.id)} size="lg">
            {WORDS.workspace.acts.close}
          </ButtonLink>
        ) : null}
        {me?.holds('pricing.read') === true ? (
          <ButtonLink to={orderPath(order.id)} variant="secondary" size="lg">
            {F.open}
          </ButtonLink>
        ) : null}
        <ButtonLink
          to={ordersPath(facts.id)}
          variant="secondary"
          size="lg"
          onClick={() => {
            void onReload();
          }}
        >
          {WORDS.common.backToOrders}
        </ButtonLink>
      </div>
    </div>
  );
}

function OrderForm({
  facts,
  vendorName,
  parcel,
  remainingNote,
  reload,
}: {
  readonly facts: VendorFacts;
  readonly vendorName: string | undefined;
  readonly parcel: ParcelFacts | undefined;
  /** What the vendor says of its orders (blind: how many more are needed). */
  readonly remainingNote: string | undefined;
  readonly reload: () => Promise<IntakeRecordView | undefined>;
}) {
  const client = useApiClient();
  const [values, setValues] = useState<OrderFormValues>(EMPTY_ORDER_FORM);
  const [initial] = useState(values);
  const [invalid, setInvalid] = useState<OrderFieldErrors>({});
  const [attempts, setAttempts] = useState(0);
  const [saved, setSaved] = useState<SavedOrderView | undefined>(undefined);
  const form = useRef<HTMLFormElement>(null);
  const version = useRef(facts.etag);
  const gate = useUploadGate();
  const parcelId = parcel?.id ?? null;

  const flow = useOrderFlow({
    operation: 'itemizeOrder',
    previewOperation: 'previewOrder',
    preview: (current) => previewOrder(client, facts.id, previewBodyOf(current, parcelId)),
    save: (command, key) =>
      itemizeOrder(
        client,
        facts.id,
        saveBodyOf(command.values, parcelId, command.token),
        command.version,
        key,
      ),
    version: () => version.current,
    reload: async () => {
      const read = await reload();
      if (read !== undefined) version.current = vendorFactsOf(read).etag;
    },
    onSaved: setSaved,
  });
  const { stage, command } = flow;
  const reviewing = stage.kind === 'reviewing';
  const fromServer = refusedFields(
    command.phase === 'refused' ? command.problem : flow.checkProblem,
  );
  const tiedToAField = Object.keys(fromServer).length > 0;
  const locked = command.locked || stage.kind === 'checking';

  useEffect(() => {
    if (attempts > 0) focusFirstInvalid(form.current);
  }, [attempts]);
  useEffect(() => {
    if (flow.checkProblem !== undefined) focusFirstInvalid(form.current);
  }, [flow.checkProblem]);
  useEffect(() => {
    if (command.phase === 'unknown')
      form.current?.querySelector<HTMLElement>('[data-recovery]')?.focus();
  }, [command.phase]);

  if (saved !== undefined) {
    return <Saved facts={facts} order={saved} onReload={() => reload()} />;
  }

  const errors: OrderFieldErrors = { ...fromServer, ...invalid };

  function change(patch: Partial<OrderFormValues>, ...fields: OrderField[]): void {
    setValues((current) => ({ ...current, ...patch }));
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
    const found = problemsWith(values, { zoneNeeded: flow.candidates !== undefined });
    setInvalid(found);
    if (Object.keys(found).length > 0) {
      setAttempts((count) => count + 1);
      return;
    }
    void flow.check(values);
  }

  const title = parcel === undefined ? F.title : F.titleFor(parcel.ordinal);

  return (
    <TaskForm
      formRef={form}
      busy={stage.kind === 'checking' || command.phase === 'sending'}
      dirty={values !== initial}
      onSubmit={send}
      alerts={<FlowAlerts flow={flow} tiedToAField={tiedToAField} />}
      summary={{
        title: parcel === undefined ? F.summary.title : F.sections.parcel,
        children: (
          <>
            {parcel === undefined ? null : (
              <OrderPhoto
                parcel={{
                  door_photo_evidence_id:
                    parcel.origin === 'DOOR_PHOTO' ? parcel.photo_evidence_id : null,
                  hub_photo_evidence_id:
                    parcel.origin === 'HUB_EXTRA' ? parcel.photo_evidence_id : null,
                }}
                size="full"
                alt={`${F.photoOf}: ${WORDS.common.parcel(parcel.ordinal)}`}
              />
            )}
            {remainingNote === undefined ? null : <p>{remainingNote}</p>}
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
          cancelTo={ordersPath(facts.id)}
          confirm={F.acts.confirm}
          lookLabel={F.checkRecord}
        />
      }
      header={{
        title,
        description: F.description,
        breadcrumb: [
          { label: WORDS.common.receiving, to: RECEIVING_PATH },
          { label: vendorName ?? facts.code, to: recordPath(facts.id) },
          { label: F.breadcrumbOrders, to: ordersPath(facts.id) },
        ],
      }}
    >
      <OrderFields
        values={values}
        errors={errors}
        locked={locked}
        intakeId={facts.id}
        candidates={flow.candidates}
        gate={gate}
        amendment={false}
        change={change}
      />
    </TaskForm>
  );
}

/** A page that says why there is nothing to make an order for, with the way back. */
function NothingToOrder({ facts, words }: { readonly facts: VendorFacts; readonly words: string }) {
  return (
    <div className="orders-saved">
      <p className="orders-note">{words}</p>
      <div className="orders-saved__acts">
        <ButtonLink to={ordersPath(facts.id)} variant="secondary" size="lg">
          {WORDS.common.backToOrders}
        </ButtonLink>
      </div>
    </div>
  );
}

/** For a vendor with door photos and no parcel in the address: the first parcel that arrived and has no order, from the server, and the form for it. */
function NextParcel({ facts }: { readonly facts: VendorFacts }) {
  const next = useWorklist(facts.id, { view: 'needs_order', pageSize: 1 });
  if (next.status === 'pending') return <Skeleton lines={4} />;
  const first = next.data?.items[0]?.parcel;
  if (first === undefined || first === null) {
    return (
      <NothingToOrder
        facts={facts}
        words={
          next.status === 'error'
            ? problemOf(next.error, { operation: 'listIntakeOrders' }).message
            : F.noParcel
        }
      />
    );
  }
  return <Navigate replace to={newOrderPath(facts.id, first.id)} />;
}

function Entry({
  record,
  reload,
}: {
  readonly record: IntakeRecordView;
  readonly reload: () => Promise<IntakeRecordView | undefined>;
}) {
  const [params] = useSearchParams();
  const location = useLocation();
  const facts = vendorFactsOf(record);
  const parcelParam = params.get('parcel');
  const blind = facts.mode === 'BLIND_COUNT';
  // A vendor counted without photos has places, not parcels: how many more orders it can take is the server's count.
  const places = useWorklist(facts.id, {
    pageSize: 1,
    enabled: blind && facts.cleared && !facts.closed,
  });
  const vendorName = record.kind === 'check-in' ? record.view.vendor_name : undefined;

  if (facts.closed) return <NothingToOrder facts={facts} words={F.closedVendor} />;
  if (blind) {
    if (!facts.cleared) return <NothingToOrder facts={facts} words={F.blindAwaitingCount} />;
    if (places.status === 'pending') return <Skeleton lines={4} />;
    const progress = places.data?.progress;
    if (progress !== undefined) {
      if (progress.needs_order === null)
        return <NothingToOrder facts={facts} words={F.blindAwaitingCount} />;
      if (progress.needs_order === 0)
        return <NothingToOrder facts={facts} words={F.blindNoPlace} />;
    }
    return (
      <OrderForm
        key={location.key}
        facts={facts}
        vendorName={vendorName}
        parcel={undefined}
        remainingNote={
          progress?.needs_order === null || progress?.needs_order === undefined
            ? undefined
            : WORDS.workspace.blind.remaining(progress.needs_order)
        }
        reload={reload}
      />
    );
  }
  if (parcelParam === null || !UUID.test(parcelParam)) return <NextParcel facts={facts} />;
  const parcel = parcelOf(record, parcelParam);
  if (parcel === undefined || parcel.state === 'VOID') {
    return <NothingToOrder facts={facts} words={F.parcelNotAvailable} />;
  }
  return (
    <OrderForm
      key={parcel.id}
      facts={facts}
      vendorName={vendorName}
      parcel={parcel}
      remainingNote={undefined}
      reload={reload}
    />
  );
}

/**
 * Make an order (surfaces/ops-portal.md section 7, `/intakes/{id}/orders/new`; S1.40; `previewOrder` then `itemizeOrder`, `hub.intake.itemize`; AC-SLICE-001-47 to 59, 90, 104): **an order is made for one parcel,
 * with the parcel's photo beside the form**, or, for a vendor counted without photos, for one of the places its count leaves. The size has no default; the price is never a field, and the officer **checks the price
 * before anything is saved**: the server works out what confirming gives (the price and what it is made of, the zone, the delivery date, who pays and what that means for the order), the officer reads it, and the
 * save is made on the digest of exactly those terms. When the terms changed while the officer looked, the new ones are shown beside the earlier ones and a second confirmation is asked for; when the vendor or the
 * hub's prices changed, nothing was saved, the entries stay, and one press checks again. A lost answer is sent again under the same key and never makes an order twice. The page computes no price.
 */
export function OrderFormPage() {
  const { id = '' } = useParams();
  return (
    <WithRecord
      id={id}
      ownsHeading
      named
      heading={(record, vendor) => ({
        title: F.title,
        documentTitle: vendor === undefined ? F.documentTitle : `${F.documentTitle} · ${vendor}`,
        ...(record === undefined ? {} : {}),
      })}
      breadcrumb={() => [{ label: WORDS.common.receiving, to: RECEIVING_PATH }]}
    >
      {(record, query) => (
        <Entry record={record} reload={async () => (await query.refetch()).data} />
      )}
    </WithRecord>
  );
}
