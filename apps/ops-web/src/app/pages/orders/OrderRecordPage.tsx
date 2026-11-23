import type { UseQueryResult } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';

import { PageHeading } from '../../../components/PageHeading';
import { Alert } from '../../../components/ui/alert/Alert';
import { Button } from '../../../components/ui/button/Button';
import { ButtonLink } from '../../../components/ui/button/ButtonLink';
import { DescriptionList } from '../../../components/ui/description-list/DescriptionList';
import { HubFloor } from '../../../components/ui/hub-floor/HubFloor';
import { Link } from '../../../components/ui/link/Link';
import { PageHeader } from '../../../components/ui/page-header/PageHeader';
import { Panel } from '../../../components/ui/panel/Panel';
import { ReadState } from '../../../components/ui/read-state/ReadState';
import { Skeleton } from '../../../components/ui/skeleton/Skeleton';
import { StatusBadge } from '../../../components/ui/status-badge/StatusBadge';
import { RecordPage } from '../../../components/ui/templates/RecordPage';
import type { TimelineEntry } from '../../../components/ui/timeline/Timeline';
import { destinationOf } from '../../../platform/hub-orders/order-form-model';
import type { OrderView } from '../../../platform/hub-orders/orders-shape';
import { useOrder, type OrderRecordView } from '../../../platform/hub-orders/use-orders-queries';
import { ORDERS_WORDS as WORDS } from '../../../platform/problem/orders-copy';
import { copyFor, problemOf } from '../../../platform/problem/problem-copy';
import { useSignedInSession } from '../../../platform/session/use-permissions';
import { formatInstant } from '../../../platform/time/format-time';
import { serviceDateText } from '../pickup/pickup-presentation';
import { UUID } from '../staff/WithProfile';
import { Cedis } from './Cedis';
import { PayerCorrectionDialog, ReverseArrivalDialog } from './OrderActDialogs';
import {
  amendPath,
  commercialText,
  componentText,
  correctionPath,
  ORDER_STANDING_MAP,
  ordersPath,
  RECEIVING_PATH,
  type OrderStanding,
} from './orders-presentation';
import './orders-pages.css';

const R = WORDS.record;

const standingOf = (order: OrderView): OrderStanding =>
  order.commercial_state === 'REVERSED' ? 'REVERSED' : order.price_status;

/** The code of the order the change page just saved, handed over in the history state: text of the shape of a code and nothing else, because a history state is the browser's and never trusted. */
function amendedCodeOf(state: unknown): string | undefined {
  if (typeof state !== 'object' || state === null || !('amended' in state)) return undefined;
  const code = (state as { readonly amended: unknown }).amended;
  return typeof code === 'string' && /^[A-Za-z0-9-]{1,40}$/.test(code) ? code : undefined;
}

/** The members an amendment changed, in the floor's words, each once: never their values, which hold a person's details. */
function changedText(changed: readonly string[]): string {
  const words = [...new Set(changed.map((member) => R.changedMembers[member] ?? R.unknownMember))];
  const last = words.at(-1);
  if (last === undefined) return R.unknownMember;
  return words.length === 1 ? last : `${words.slice(0, -1).join(', ')} and ${last}`;
}

/** What happened to the order, oldest first: each change with who made it and why, and the reversal of its arrival. */
function historyOf(order: OrderView): readonly TimelineEntry[] {
  const entries: TimelineEntry[] = [
    ...order.amendments.map((amendment) => ({
      key: amendment.id,
      title: R.history.amended(changedText(amendment.changed)),
      details: (
        <>
          {formatInstant(amendment.amended_at) ?? ''}
          <br />
          {R.history.note(amendment.note)}
        </>
      ),
    })),
    ...(order.reversal === null
      ? []
      : [
          {
            key: order.reversal.id,
            title: R.history.reversed,
            details: (
              <>
                {formatInstant(order.reversal.reversed_at) ?? ''}
                <br />
                {R.history.note(order.reversal.note)}
              </>
            ),
          },
        ]),
  ];
  const last = entries.at(-1);
  return last === undefined ? entries : [...entries.slice(0, -1), { ...last, current: true }];
}

/** The price, told as what it is: a price calculated and kept until the order is confirmed, or the price fixed. The estimate of the booking is a third thing and is said to be elsewhere. */
function PriceBlock({ order }: { readonly order: OrderView }) {
  const frozen = order.price_status === 'FROZEN';
  const total =
    order.locked_price ??
    (order.calculated_total_minor === null
      ? undefined
      : ({ amount_minor: order.calculated_total_minor, currency: 'GHS' } as const));
  return (
    <>
      {total === undefined ? (
        <p>{R.price.none}</p>
      ) : (
        <DescriptionList
          items={[
            {
              label: frozen ? R.price.frozen : R.price.earlyQuote,
              value: <Cedis money={total} />,
            },
          ]}
        />
      )}
      <p className="orders-note">{frozen ? R.price.frozenHelp : R.price.earlyHelp}</p>
      {order.components.length === 0 ? null : (
        <DescriptionList
          heading={WORDS.review.components}
          items={order.components.map((component) => ({
            label: componentText(component),
            value: <Cedis money={component.amount} />,
          }))}
        />
      )}
      <p className="orders-note">{R.price.estimateNote}</p>
    </>
  );
}

function PayerBlock({ order }: { readonly order: OrderView }) {
  return (
    <DescriptionList
      items={[
        ...(order.payer_allocation === null
          ? [{ label: R.sections.payer, value: R.payer.notYet }]
          : [
              {
                label: R.payer.sender,
                value: (
                  <Cedis
                    money={{ amount_minor: order.payer_allocation.sender_minor, currency: 'GHS' }}
                  />
                ),
              },
              {
                label: R.payer.recipient,
                value: (
                  <Cedis
                    money={{
                      amount_minor: order.payer_allocation.recipient_minor,
                      currency: 'GHS',
                    }}
                  />
                ),
              },
            ]),
        {
          label: '',
          value:
            order.payer_override === null
              ? R.payer.asBooked
              : `${R.payer.override}: ${WORDS.form.payers[order.payer_override.payer_intent].label}`,
        },
      ]}
    />
  );
}

function Holds({ order }: { readonly order: OrderView }) {
  const recipient = order.recipient;
  return (
    <DescriptionList
      items={[
        ...(recipient === null
          ? []
          : [
              { label: R.facts.recipient, value: recipient.name },
              { label: R.facts.phone, value: recipient.phone },
              { label: R.facts.address, value: recipient.location.address },
              ...(recipient.location.landmark === undefined
                ? []
                : [{ label: R.facts.landmark, value: recipient.location.landmark }]),
            ]),
        { label: R.facts.size, value: WORDS.form.sizes[order.size_class] },
        { label: R.facts.destination, value: R.destinations[destinationOf(order)] },
        ...(order.destination.zone_name === null
          ? []
          : [{ label: R.facts.zone, value: order.destination.zone_name }]),
        ...(order.declared_value_minor === null
          ? []
          : [
              {
                label: R.facts.declared,
                value: (
                  <Cedis money={{ amount_minor: order.declared_value_minor, currency: 'GHS' }} />
                ),
              },
            ]),
        {
          label: R.facts.highValue,
          value: order.is_high_value
            ? order.is_high_value_manual === true
              ? R.manualHighValue
              : R.byDeclaration
            : R.no,
        },
        ...(order.serial_imei === null
          ? []
          : [{ label: R.facts.serial, value: order.serial_imei }]),
        ...(order.requested_delivery_date === null
          ? []
          : [{ label: R.facts.requested, value: serviceDateText(order.requested_delivery_date) }]),
        ...(order.derived_delivery_date === null
          ? []
          : [{ label: R.facts.committed, value: serviceDateText(order.derived_delivery_date) }]),
        ...(order.carrier_cost === null
          ? []
          : [{ label: R.facts.carrier, value: <Cedis money={order.carrier_cost} /> }]),
      ]}
    />
  );
}

function RecordBody({
  record,
  query,
}: {
  readonly record: OrderRecordView;
  readonly query: UseQueryResult<OrderRecordView>;
}) {
  const me = useSignedInSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [dialog, setDialog] = useState<'reverse' | 'correct' | undefined>(undefined);
  // The page says the order changed only when a refusal said it (an act answered `stale`): every other time the officer is looking at what was just read.
  const [stale, setStale] = useState(false);
  // The change page hands the order over with the word that it was changed: said once, here, where the officer lands.
  const [notice, setNotice] = useState<ReactNode>(() => {
    const amended = amendedCodeOf(location.state);
    return amended === undefined ? undefined : <p>{WORDS.form.doneAmend(amended)}</p>;
  });
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (notice !== undefined) box.current?.focus();
  }, [notice]);
  useEffect(() => {
    // A reload or a return to this page later must not say it again: the word is taken off the history state once it has been read.
    if (amendedCodeOf(location.state) !== undefined)
      void navigate('.', { replace: true, state: null });
  }, [location.state, navigate]);
  if (me === undefined) return null;
  const { order, etag } = record;
  const standing = standingOf(order);
  const reversed = standing === 'REVERSED';
  const frozen = order.price_status === 'FROZEN';
  const parcelGone =
    order.intake_parcel_state === 'MISSING' || order.intake_parcel_state === 'VOID';
  const mayAmend = me.holds('hub.intake.itemize') && !frozen && !reversed && !parcelGone;
  const mayReverse =
    me.holds('hub.osd.adjudicate') && frozen && !reversed && order.intake_parcel_id !== null;
  const mayCorrect = me.holds('pricing.correction.create') && frozen && !reversed;
  // A taken-back order says so in its header: its payment line would say it a second time.
  const commercial = reversed ? undefined : commercialText(order.commercial_state);
  const sideFacts = [
    ...(commercial === undefined ? [] : [{ label: R.facts.payment, value: commercial }]),
    ...(order.pickup_intake_id === null
      ? []
      : [
          {
            label: R.facts.vendor,
            value: <Link to={ordersPath(order.pickup_intake_id)}>{R.acts.openVendor}</Link>,
          },
        ]),
  ];

  const primary: ReactNode = mayAmend ? (
    <ButtonLink to={amendPath(order.id)}>{R.acts.amend}</ButtonLink>
  ) : mayCorrect ? (
    <Button
      type="button"
      onClick={() => {
        setDialog('correct');
      }}
    >
      {R.acts.correct}
    </Button>
  ) : undefined;
  const secondary: ReactNode =
    mayReverse || (mayAmend && mayCorrect) ? (
      <>
        {mayReverse ? (
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              setDialog('reverse');
            }}
          >
            {R.acts.reverse}
          </Button>
        ) : null}
      </>
    ) : undefined;
  const note =
    frozen && !reversed && !mayReverse && order.intake_parcel_id !== null
      ? R.notes.seniorReverses
      : undefined;
  const history = historyOf(order);

  return (
    <>
      <RecordPage
        breadcrumb={[
          { label: WORDS.common.receiving, to: RECEIVING_PATH },
          ...(order.pickup_intake_id === null
            ? []
            : [{ label: WORDS.form.breadcrumbOrders, to: ordersPath(order.pickup_intake_id) }]),
        ]}
        header={{
          code: order.code,
          status: <StatusBadge status={standing} map={ORDER_STANDING_MAP} />,
          sentence: R.sentence[standing],
        }}
        acts={{
          ...(primary === undefined ? {} : { primary }),
          ...(secondary === undefined ? {} : { secondary }),
          ...(note === undefined ? {} : { note }),
        }}
        conflict={
          stale
            ? {
                message: R.stale,
                onReload: () => {
                  setStale(false);
                  void query.refetch();
                },
              }
            : undefined
        }
        notice={
          notice === undefined ? undefined : (
            <div className="orders-notice" ref={box} tabIndex={-1}>
              <Alert variant="success">{notice}</Alert>
            </div>
          )
        }
        main={
          <>
            <Panel title={R.sections.holds} headingLevel={2} region>
              <Holds order={order} />
            </Panel>
            <Panel title={R.sections.price} headingLevel={2} region>
              <PriceBlock order={order} />
            </Panel>
            <Panel title={R.sections.payer} headingLevel={2} region>
              <PayerBlock order={order} />
            </Panel>
          </>
        }
        {...(sideFacts.length === 0
          ? {}
          : {
              side: (
                <Panel title={WORDS.common.receiving} headingLevel={2}>
                  <DescriptionList items={sideFacts} />
                </Panel>
              ),
            })}
        {...(history.length === 0
          ? {}
          : { activity: { title: R.sections.history, entries: history } })}
      />
      {dialog === 'reverse' ? (
        <ReverseArrivalDialog
          order={order}
          version={etag}
          onCancel={() => {
            setDialog(undefined);
          }}
          onDone={(done) => {
            setDialog(undefined);
            setNotice(<p>{R.reverseDone(done.received_after)}</p>);
            void query.refetch();
          }}
          onReload={() => {
            setDialog(undefined);
            setStale(false);
            return query.refetch();
          }}
          onStale={() => {
            setStale(true);
          }}
        />
      ) : null}
      {dialog === 'correct' ? (
        <PayerCorrectionDialog
          order={order}
          version={etag}
          onCancel={() => {
            setDialog(undefined);
          }}
          onDone={(done) => {
            setDialog(undefined);
            setNotice(
              <p>
                {R.correctionDone}{' '}
                <Link to={correctionPath(done.correction.id)}>{R.acts.openCorrection}</Link>
              </p>,
            );
            void query.refetch();
          }}
          onReload={() => {
            setDialog(undefined);
            setStale(false);
            return query.refetch();
          }}
          onStale={() => {
            setStale(true);
          }}
        />
      ) : null}
    </>
  );
}

function OrderNotFound() {
  return (
    <>
      <title>{`${WORDS.common.notFoundOrder} · Melarc Ops Portal`}</title>
      <PageHeading>{WORDS.common.notFoundOrder}</PageHeading>
      <p>{copyFor({ operation: 'getOrder', code: 'NOT_FOUND' }) ?? WORDS.common.notFoundOrder}</p>
    </>
  );
}

function Reading({ id }: { readonly id: string }) {
  const query = useOrder(id);
  if (query.status === 'error') {
    const problem = problemOf(query.error, { operation: 'getOrder' });
    if (problem.kind === 'not-found') return <OrderNotFound />;
  }
  const loaded = query.status === 'success';
  return (
    <>
      <title>{`${loaded ? R.documentTitle(query.data.order.code) : 'Order'} · Melarc Ops Portal`}</title>
      <HubFloor>
        {loaded ? null : <PageHeader title="Order" />}
        <ReadState<OrderRecordView>
          query={query}
          isEmpty={() => false}
          empty={null}
          loadingLabel={R.loading}
          skeleton={<Skeleton lines={4} />}
          permission="pricing.read"
          operation="getOrder"
        >
          {(record) => <RecordBody record={record} query={query} />}
        </ReadState>
      </HubFloor>
    </>
  );
}

/**
 * An order (surfaces/ops-portal.md section 7, `/orders/{id}`; S1.40; `getOrder`, `pricing.read`): the record of one order, **read as one snapshot with its history and its version**. It says what the order holds, the
 * price **told as what it is** (a price calculated and kept until the order is confirmed, or the price fixed: the estimate shown at booking is a third thing and is said to be elsewhere), who pays, and what
 * happened to it, each change with who made it and why and **never the values, which hold a person's details**. Acts are offered by key and by what the record says and decide nothing: *Change this order* while
 * its price is not fixed, *Change who pays* once it is (a request a senior officer decides, the price never touching) and *Take back the arrival* for a senior officer, while nothing has been paid for or sent out.
 */
export function OrderRecordPage() {
  const { id = '' } = useParams();
  if (!UUID.test(id)) return <OrderNotFound />;
  return <Reading key={id} id={id} />;
}
