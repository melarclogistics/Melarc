import { useState } from 'react';

import { Button } from '../../../components/ui/button/Button';
import { DescriptionList } from '../../../components/ui/description-list/DescriptionList';
import { Field } from '../../../components/ui/field/Field';
import { Link } from '../../../components/ui/link/Link';
import { ReadState } from '../../../components/ui/read-state/ReadState';
import { Skeleton } from '../../../components/ui/skeleton/Skeleton';
import { StatusBadge } from '../../../components/ui/status-badge/StatusBadge';
import { Textarea } from '../../../components/ui/textarea/Textarea';
import { useApiClient } from '../../../platform/api/api-client';
import { formatMinor } from '../../../components/ui/money/money-value';
import {
  decidePayerCorrection,
  type CorrectionWithVersion,
} from '../../../platform/hub-orders/orders-commands';
import type {
  AllocationView,
  CorrectionView,
  PayerChoiceView,
} from '../../../platform/hub-orders/orders-shape';
import {
  usePayerCorrection,
  type CorrectionRecordView,
} from '../../../platform/hub-orders/use-orders-queries';
import { ORDERS_WORDS as WORDS } from '../../../platform/problem/orders-copy';
import { formatInstant } from '../../../platform/time/format-time';
import { ActDialog } from '../manifests/ManifestActDialogs';
import { Cedis } from './Cedis';
import { CORRECTION_STATE_MAP, GATE_WORDS, orderPath } from './orders-presentation';
import './orders-pages.css';

const K = WORDS.corrections;

/** What an allocation says, in actual amounts as the server gave them: the page adds nothing up. */
function Amounts({ allocation }: { readonly allocation: AllocationView }) {
  return (
    <>
      {K.amounts(
        formatMinor(allocation.sender_minor, 'GHS'),
        formatMinor(allocation.recipient_minor, 'GHS'),
      )}
    </>
  );
}

/** What was asked for, as an intent and the numbers that go with it. The amounts it would come to are the server's (`proposed_allocation`). */
function proposalText(proposed: PayerChoiceView): string {
  const base = WORDS.form.payers[proposed.payer_intent].label;
  if (proposed.payer_intent !== 'SPLIT') return base;
  if (proposed.split_basis === 'FIXED_AMOUNT' && proposed.split_sender_amount !== null) {
    return `${base}: the sender pays ${formatMinor(proposed.split_sender_amount.amount_minor, 'GHS')}`;
  }
  if (proposed.split_basis === 'PERCENTAGE' && proposed.split_sender_percentage !== null) {
    return `${base}: the sender pays ${String(proposed.split_sender_percentage)}%`;
  }
  return base;
}

interface DecisionCommand {
  readonly decision: 'APPROVE' | 'REJECT';
  readonly note?: string;
}

/**
 * One change of who pays, read with its version (`getPayerCorrection`, `pricing.correction.create`), so that a checker opens it from the queue, after a reload or on another device and sees **the order's unchanged
 * price, how it is paid now, what is asked for in actual amounts (calculated by the server), who asked and why**, and, once decided, what the approval did. The checker (`pricing.correction.approve`) approves or
 * rejects on the version read, under a key; a different officer than the one who asked decides it (a Platform Admin may decide their own), and the server says when it is not so. The page works nothing out.
 */
export function CorrectionDetail({
  correctionId,
  mayDecide,
  onDecided,
  onReloadList,
}: {
  readonly correctionId: string;
  readonly mayDecide: boolean;
  /** The decision was saved: the page says what it came to and reads its list again. */
  readonly onDecided: (done: CorrectionWithVersion, decision: 'APPROVE' | 'REJECT') => void;
  readonly onReloadList?: () => unknown;
}) {
  const query = usePayerCorrection(correctionId);
  return (
    <ReadState<CorrectionRecordView>
      query={query}
      isEmpty={() => false}
      empty={null}
      loadingLabel={K.loading}
      skeleton={<Skeleton lines={4} />}
      permission="pricing.correction.create"
      operation="getPayerCorrection"
    >
      {(record) => (
        <Body
          record={record}
          mayDecide={mayDecide}
          onDecided={onDecided}
          reload={async () => {
            const read = await query.refetch();
            void onReloadList?.();
            return read;
          }}
        />
      )}
    </ReadState>
  );
}

function Body({
  record,
  mayDecide,
  onDecided,
  reload,
}: {
  readonly record: CorrectionRecordView;
  readonly mayDecide: boolean;
  readonly onDecided: (done: CorrectionWithVersion, decision: 'APPROVE' | 'REJECT') => void;
  readonly reload: () => Promise<unknown>;
}) {
  const client = useApiClient();
  const correction: CorrectionView = record.correction;
  const [deciding, setDeciding] = useState<'APPROVE' | 'REJECT' | undefined>(undefined);
  const [note, setNote] = useState('');
  const waiting = correction.state === 'REQUESTED';
  return (
    <>
      <DescriptionList
        items={[
          ...(correction.order_code === null
            ? []
            : [
                {
                  label: K.facts.order,
                  value: <Link to={orderPath(correction.order_id)}>{correction.order_code}</Link>,
                },
              ]),
          ...(correction.total === null
            ? []
            : [{ label: K.facts.price, value: <Cedis money={correction.total} /> }]),
          { label: K.facts.before, value: <Amounts allocation={correction.previous_allocation} /> },
          { label: K.facts.after, value: proposalText(correction.proposed) },
          ...(correction.proposed_allocation === null
            ? []
            : [{ label: '', value: <Amounts allocation={correction.proposed_allocation} /> }]),
          ...(correction.proposed_commercial_state === null
            ? []
            : [
                {
                  label: K.facts.afterState,
                  value: GATE_WORDS[correction.proposed_commercial_state],
                },
              ]),
          {
            label: K.facts.requestedBy,
            value: correction.requested_by_name ?? K.state.REQUESTED,
          },
          ...(correction.created_at === null
            ? []
            : [{ label: K.facts.requestedAt, value: formatInstant(correction.created_at) ?? '' }]),
          ...(correction.note === null ? [] : [{ label: K.facts.note, value: correction.note }]),
          {
            label: K.columns.standing,
            value: <StatusBadge status={correction.state} map={CORRECTION_STATE_MAP} />,
          },
          ...(correction.state === 'REQUESTED' || correction.decided_at === null
            ? []
            : [
                ...(correction.approved_by_name === null
                  ? []
                  : [{ label: K.facts.decidedBy, value: correction.approved_by_name }]),
                { label: K.facts.decidedAt, value: formatInstant(correction.decided_at) ?? '' },
              ]),
          ...(correction.resulting_allocation === null
            ? []
            : [
                {
                  label: K.facts.result,
                  value: <Amounts allocation={correction.resulting_allocation} />,
                },
              ]),
        ]}
      />
      {waiting && !mayDecide ? <p className="orders-note">{K.mayNotDecide}</p> : null}
      {waiting && mayDecide ? (
        <div className="orders-saved__acts">
          <Button
            type="button"
            size="lg"
            onClick={() => {
              setDeciding('APPROVE');
            }}
          >
            {K.acts.approve}
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="lg"
            onClick={() => {
              setDeciding('REJECT');
            }}
          >
            {K.acts.reject}
          </Button>
        </div>
      ) : null}
      {deciding === undefined ? null : (
        <ActDialog<DecisionCommand, CorrectionWithVersion>
          open
          title={deciding === 'APPROVE' ? K.decide.approveTitle : K.decide.rejectTitle}
          consequence={<p>{deciding === 'APPROVE' ? K.decide.approveBody : K.decide.rejectBody}</p>}
          confirmLabel={deciding === 'APPROVE' ? K.decide.approveYes : K.decide.rejectYes}
          confirmVariant="primary"
          cancelLabel={K.decide.cancel}
          size="lg"
          operation="approvePayerCorrection"
          retryable
          build={() => ({
            decision: deciding,
            ...(note.trim() === '' ? {} : { note: note.trim() }),
          })}
          send={(command, key) =>
            decidePayerCorrection(
              client,
              correction.id,
              command.decision,
              command.note,
              record.etag,
              key,
            )
          }
          onDone={(done) => {
            setDeciding(undefined);
            onDecided(done, deciding);
          }}
          onCancel={() => {
            setDeciding(undefined);
          }}
          onReload={() => {
            setDeciding(undefined);
            return reload();
          }}
        >
          <Field label={K.decide.noteLabel} help={K.decide.noteHelp}>
            <Textarea
              name="note"
              rows={2}
              maxLength={1000}
              value={note}
              onChange={(event) => {
                setNote(event.target.value);
              }}
            />
          </Field>
        </ActDialog>
      )}
    </>
  );
}
