import { useEffect, useRef, useState, type ReactNode, type SubmitEvent } from 'react';
import { Navigate, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';

import { Alert } from '../../../components/ui/alert/Alert';
import { ButtonLink } from '../../../components/ui/button/ButtonLink';
import { OperationalCode } from '../../../components/ui/code/OperationalCode';
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
  readDestinationZones,
  type SavedOrderView,
} from '../../../platform/hub-orders/orders-commands';
import type { WaitingMarkView, WorkItemView } from '../../../platform/hub-orders/orders-shape';
import {
  useLastOrders,
  useNextToOrder,
  useParcelRow,
  useWorklist,
} from '../../../platform/hub-orders/use-orders-queries';
import type { IntakeRecordView } from '../../../platform/hub-receiving/use-intake-record';
import { ORDERS_WORDS as WORDS } from '../../../platform/problem/orders-copy';
import { problemOf } from '../../../platform/problem/problem-copy';
import { recordPath } from '../receiving/receiving-presentation';
import { WithRecord } from '../receiving/WithRecord';
import { OrderFields } from './OrderFields';
import { FlowActions, FlowAlerts, movedRule } from './OrderFlowParts';
import { OrderPhoto } from './OrderPhoto';
import { OrderLayout } from './OrderLayout';
import { ParcelWaiting } from './ParcelWaiting';
import { OrderPrice } from './OrderPrice';
import { errorsOf, refusedFields } from './order-refusal-fields';
import { typedLineOf } from './order-typed';
import {
  closePath,
  newOrderPath,
  orderPath,
  ordersPath,
  TO_MAKE_CRUMB,
} from './orders-presentation';
import { useOrderFlow } from './use-order-flow';
import { vendorFactsOf, type VendorFacts } from './vendor-facts';
import { useSignedInSession } from '../../../platform/session/use-permissions';
import { UUID } from '../staff/WithProfile';
import './orders-pages.css';

const F = WORDS.form;

/** How many of a vendor's last orders the screen of a saved order shows, when the vendor is counted without photos. */
const LAST_ORDERS = 5;

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
  after,
  onReload,
}: {
  readonly facts: VendorFacts;
  readonly order: SavedOrderView;
  /** The place of the parcel just saved: the next order moves forward from it. */
  readonly after: number | undefined;
  /** Reads the vendor again, for its version. */
  readonly onReload: () => Promise<unknown>;
}) {
  const me = useSignedInSession();
  const navigate = useNavigate();
  const box = useRef<HTMLDivElement>(null);
  const left = useWorklist(facts.id, { view: 'needs_order', pageSize: 1 });
  const blind = facts.mode === 'BLIND_COUNT';
  const last = useLastOrders(facts.id, LAST_ORDERS, blind);
  useEffect(() => {
    box.current?.focus();
  }, []);
  const remaining = left.data?.progress.needs_order ?? undefined;
  // The next order and the close are offered only when the server would take them (Run G1, Part 2, item 2): the vendor is cleared (its check-in is final) and not closed. After an early order for a parcel that is
  // not here yet the vendor is still being checked in, and each would open a page that says so: a dead end, which *Back to the orders* is not.
  const open = facts.cleared && !facts.closed;
  const made = left.data?.progress.orders;
  const received = left.data?.progress.received ?? null;
  return (
    <div className="orders-saved" ref={box} tabIndex={-1}>
      <Alert variant="success">
        <p>{F.done(order.code)}</p>
      </Alert>
      {blind ? (
        // A vendor counted without photos has no parcel to show the order on: the code is what goes on the parcel, large, with where the vendor stands by the count, and the orders made last, to check the codes of the
        // parcels on the table against (D-S7-3). Both counts are the server's.
        <div className="orders-blind">
          <p className="orders-blind__lead">{F.blindSaved.writeOnParcel}</p>
          <p className="orders-blind__code">
            <OperationalCode>{order.code}</OperationalCode>
          </p>
          {made === undefined || received === null ? null : (
            <p className="orders-blind__position">{F.blindSaved.position(made, received)}</p>
          )}
          <h2 className="orders-blind__heading">{F.blindSaved.lastTitle}</h2>
          {last.status === 'error' ? (
            <p className="orders-note">{F.blindSaved.lastNone}</p>
          ) : last.status === 'success' ? (
            <ul className="orders-blind__list">
              {last.data.map((each) => (
                <li key={each.id}>
                  <OperationalCode>{each.code}</OperationalCode>
                  {each.recipient_name === null ? null : <span>{each.recipient_name}</span>}
                  <span>{F.sizes[each.size_class]}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {remaining === undefined ? null : (
        <p className="orders-note">
          {remaining > 0
            ? facts.mode === 'BLIND_COUNT'
              ? WORDS.workspace.blind.remaining(remaining)
              : F.parcelsLeft(remaining)
            : WORDS.workspace.notes.allDone}
        </p>
      )}
      <div className="orders-saved__acts">
        {!open ? null : remaining === undefined || remaining > 0 ? (
          <ButtonLink
            to={newOrderPath(facts.id, undefined, after)}
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
              void onReload().then(() => navigate(newOrderPath(facts.id, undefined, after)));
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
  mark,
  onMarkChanged,
}: {
  readonly facts: VendorFacts;
  readonly vendorName: string | undefined;
  readonly parcel: ParcelFacts | undefined;
  /** The officer is waiting on the vendor's details for this parcel (D-S7-12), as the server says; null when it is not. */
  readonly mark: WaitingMarkView | null;
  /** The mark was taken off: the parcel's row is read again. */
  readonly onMarkChanged: () => void;
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
  const navigate = useNavigate();
  const version = useRef(facts.etag);
  // The version a save takes is the latest read of the vendor, whoever read it: the flow's own re-read (below) or the one the page's line asks for when a read failed and the page was kept (`ReadState`), which
  // the flow does not know of. A form that went on with the version it was opened at would be refused as stale for a read it had.
  useEffect(() => {
    version.current = facts.etag;
  }, [facts.etag]);
  const gate = useUploadGate();
  const parcelId = parcel?.id ?? null;

  const flow = useOrderFlow(
    {
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
      zones: () => readDestinationZones(client, facts.id),
      version: () => version.current,
      reload: async () => {
        const read = await reload();
        if (read !== undefined) version.current = vendorFactsOf(read).etag;
      },
      onSaved: setSaved,
      // The price is asked for once what is entered is complete (a photo that is on its way is not): the same completeness the save would be judged by.
      complete: (current, zoneNeeded) =>
        !gate.busy && Object.keys(problemsWith(current, { zoneNeeded })).length === 0,
      keyOf: (current) => JSON.stringify(previewBodyOf(current, parcelId)),
    },
    values,
  );
  const { command } = flow;
  const fromServer = refusedFields(
    command.phase === 'refused' ? command.problem : flow.checkProblem,
  );
  const tiedToAField = Object.keys(fromServer).length > 0;
  const locked = command.locked;
  const terms = flow.price.kind === 'ready' ? flow.price.terms : undefined;

  useEffect(() => {
    if (attempts > 0) focusFirstInvalid(form.current);
  }, [attempts]);
  useEffect(() => {
    // A save refused about a field leaves the error on the field and the focus on it: the officer's eyes go where the fix is. The price's own refusals are told on the fields without taking the focus, which is
    // in the field the officer is typing in.
    if (command.phase === 'refused' && tiedToAField) focusFirstInvalid(form.current);
  }, [command.phase, tiedToAField]);
  useEffect(() => {
    // A refusal that removes the save (the parcel has its order, no place is left) is told where the save was, and the focus, which was on the save, goes to it: it would be lost with the button (Run G1, Part 2, item 8).
    if (command.phase === 'conflict' && !movedRule(command.problem?.rule)) {
      form.current?.querySelector<HTMLElement>('[data-refusal]')?.focus();
    }
  }, [command.phase, command.problem?.rule]);
  useEffect(() => {
    if (command.phase === 'unknown')
      form.current?.querySelector<HTMLElement>('[data-recovery]')?.focus();
  }, [command.phase]);

  if (saved !== undefined) {
    return <Saved facts={facts} order={saved} after={parcel?.ordinal} onReload={() => reload()} />;
  }

  const errors: OrderFieldErrors = errorsOf(fromServer, invalid);

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
    if (command.locked) return;
    // The price is of what is entered: the one save sends the token of the price on the screen.
    if (flow.pressable) {
      flow.save();
      return;
    }
    // Still being priced (or refused): the button says so and the press is nothing. Not complete: the fields that are missing say so, and the first has the focus.
    if (flow.price.kind !== 'waiting' || gate.busy) return;
    const found = problemsWith(values, { zoneNeeded: flow.candidates !== undefined });
    setInvalid(found);
    if (Object.keys(found).length > 0) setAttempts((count) => count + 1);
  }

  const title = parcel === undefined ? F.title : F.titleFor(parcel.ordinal);

  return (
    <TaskForm
      formRef={form}
      busy={command.phase === 'sending'}
      dirty={values !== initial}
      onSubmit={send}
      alerts={<FlowAlerts flow={flow} tiedToAField={tiedToAField} />}
      actions={
        <FlowActions
          flow={flow}
          gate={gate}
          cancelTo={ordersPath(facts.id)}
          typed={typedLineOf(values, terms)}
          save={F.acts.save}
          saveAt={F.acts.saveAt}
          lookLabel={F.checkRecord}
        />
      }
      header={{
        title,
        description: F.description,
        breadcrumb: [
          TO_MAKE_CRUMB,
          { label: vendorName ?? facts.code, to: recordPath(facts.id) },
          { label: F.breadcrumbOrders, to: ordersPath(facts.id) },
        ],
      }}
    >
      <OrderLayout
        photo={
          parcel === undefined ? null : (
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
          )
        }
        price={
          <>
            {remainingNote === undefined ? null : <p className="orders-note">{remainingNote}</p>}
            <OrderPrice flow={flow} />
          </>
        }
      >
        <OrderFields
          values={values}
          errors={errors}
          locked={locked}
          intakeId={facts.id}
          candidates={flow.candidates}
          zonesWhy={flow.zonesWhy}
          gate={gate}
          amendment={false}
          change={change}
        />
        {parcel === undefined ? null : (
          <ParcelWaiting
            parcelId={parcel.id}
            mark={mark}
            version={() => version.current}
            onMarked={() => {
              // The officer goes on to the next parcel that needs an order, after this one, passing over the ones that are waited on.
              void navigate(newOrderPath(facts.id, undefined, parcel.ordinal));
            }}
            onChanged={onMarkChanged}
            onReload={reload}
          />
        )}
      </OrderLayout>
    </TaskForm>
  );
}

/** A page that says why there is nothing to make an order for, with the way back. */
function NothingToOrder({
  facts,
  words,
  acts,
}: {
  readonly facts: VendorFacts;
  readonly words: string;
  /** Acts that lead on from what the words say (the order a parcel has, the parcels that wait), before the way back. */
  readonly acts?: ReactNode;
}) {
  return (
    <div className="orders-saved">
      <p className="orders-note">{words}</p>
      <div className="orders-saved__acts">
        {acts}
        <ButtonLink to={ordersPath(facts.id)} variant="secondary" size="lg">
          {WORDS.common.backToOrders}
        </ButtonLink>
      </div>
    </div>
  );
}

/**
 * For a vendor with door photos and no parcel in the address: **the next parcel that arrived and has no order, moving forward from the parcel just saved or marked** (`after`, its place) and passing over a parcel the
 * officer is waiting on the vendor's details for (D-S7-12), from the server; and the form for it. With none left after it, the lowest again; with every one left waited on, the page says so and leads to them.
 */
function NextParcel({
  facts,
  after,
}: {
  readonly facts: VendorFacts;
  readonly after: number | undefined;
}) {
  const next = useNextToOrder(facts.id, after);
  if (next.status === 'pending') return <Skeleton lines={4} />;
  if (next.status === 'error') {
    return (
      <NothingToOrder
        facts={facts}
        words={problemOf(next.error, { operation: 'listIntakeOrders' }).message}
      />
    );
  }
  if (next.data.kind === 'parcel') {
    return <Navigate replace to={newOrderPath(facts.id, next.data.parcelId)} />;
  }
  if (next.data.kind === 'all-waiting') {
    return (
      <NothingToOrder
        facts={facts}
        words={F.waiting.allWaiting}
        acts={
          <ButtonLink to={`${ordersPath(facts.id)}?view=waiting_for_vendor`} size="lg">
            {F.waiting.seeWaiting}
          </ButtonLink>
        }
      />
    );
  }
  return <NothingToOrder facts={facts} words={F.noParcel} />;
}

/** A parcel that already has its order (the officer went Back to its form): said with the order's code and a link to it, and never an empty form to be refused at the price. */
function ParcelHasOrder({
  facts,
  item,
}: {
  readonly facts: VendorFacts;
  readonly item: WorkItemView;
}) {
  const me = useSignedInSession();
  return (
    <NothingToOrder
      facts={facts}
      words={F.waiting.hasOrder(item.parcel?.ordinal ?? 0, item.order?.code ?? '')}
      acts={
        item.order !== null && me?.holds('pricing.read') === true ? (
          <ButtonLink to={orderPath(item.order.id)} size="lg">
            {F.waiting.openOrder}
          </ButtonLink>
        ) : null
      }
    />
  );
}

/**
 * The form of an order for one parcel of a vendor with door photos: the parcel's own row is read first (`listIntakeOrders`), so that a parcel that already has its order says so and an officer who is waiting on the
 * vendor for it sees the mark. A row that cannot be read does not stop the form: the server judges the order again.
 */
function ParcelEntry({
  facts,
  vendorName,
  parcel,
  reload,
}: {
  readonly facts: VendorFacts;
  readonly vendorName: string | undefined;
  readonly parcel: ParcelFacts;
  readonly reload: () => Promise<IntakeRecordView | undefined>;
}) {
  const row = useParcelRow(facts.id, parcel);
  if (row.status === 'pending') return <Skeleton lines={4} />;
  const item = row.data ?? null;
  if (item?.order != null) return <ParcelHasOrder facts={facts} item={item} />;
  return (
    <OrderForm
      key={parcel.id}
      facts={facts}
      vendorName={vendorName}
      parcel={parcel}
      remainingNote={undefined}
      reload={reload}
      mark={item?.parcel?.waiting_for_vendor ?? null}
      onMarkChanged={() => {
        void row.refetch();
      }}
    />
  );
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
  const afterParam = params.get('after');
  // The place of the parcel just saved or marked, from the address: the next order moves forward from it.
  const after =
    afterParam !== null && /^\d{1,9}$/.test(afterParam) ? Number(afterParam) : undefined;
  const blind = facts.mode === 'BLIND_COUNT';
  // A vendor counted without photos has places, not parcels: how many more orders it can take is the server's count.
  const places = useWorklist(facts.id, {
    pageSize: 1,
    enabled: blind && facts.cleared && !facts.closed,
  });
  const vendorName = facts.name ?? undefined;

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
        mark={null}
        onMarkChanged={() => undefined}
      />
    );
  }
  // While the vendor's check-in is open the parcels that are here wait for it to finish: the server would refuse their order, so the page says so before the officer fills in a form.
  if (!facts.cleared && (parcelParam === null || !UUID.test(parcelParam))) {
    return <NothingToOrder facts={facts} words={F.checkInOpen} />;
  }
  if (parcelParam === null || !UUID.test(parcelParam)) {
    return <NextParcel facts={facts} after={after} />;
  }
  const parcel = parcelOf(record, parcelParam);
  if (parcel === undefined || parcel.state === 'VOID') {
    return <NothingToOrder facts={facts} words={F.parcelNotAvailable} />;
  }
  if (!facts.cleared && parcel.state === 'ARRIVED') {
    return <NothingToOrder facts={facts} words={F.checkInOpen} />;
  }
  return <ParcelEntry facts={facts} vendorName={vendorName} parcel={parcel} reload={reload} />;
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
      breadcrumb={() => [TO_MAKE_CRUMB]}
    >
      {(record, query) => (
        <Entry record={record} reload={async () => (await query.refetch()).data} />
      )}
    </WithRecord>
  );
}
