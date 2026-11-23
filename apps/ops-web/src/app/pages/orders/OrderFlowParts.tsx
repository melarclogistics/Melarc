import type { ReactNode } from 'react';

import { Alert } from '../../../components/ui/alert/Alert';
import { Button } from '../../../components/ui/button/Button';
import { ButtonLink } from '../../../components/ui/button/ButtonLink';
import {
  UploadGateNotice,
  type UploadGate,
} from '../../../components/ui/evidence-upload/UploadGate';
import { Link } from '../../../components/ui/link/Link';
import { formatMinor } from '../../../components/ui/money/money-value';
import { ORDERS_WORDS as WORDS } from '../../../platform/problem/orders-copy';
import type { OrderFlow } from './use-order-flow';
import './orders-pages.css';

const F = WORDS.form;

/** Whether a conflict is the vendor or the prices having moved under the officer (the version, the hub's rates): the only conflicts that one press of *Check the price again* answers. Any other is a rule about the parcel. */
export const movedRule = (rule: string | undefined): boolean =>
  rule === undefined || rule === 'stale' || rule === 'configuration_changing';

/**
 * What the flow of an order says above the form, in the words of the floor: an outcome nobody knows, a vendor or a price that changed under the officer (nothing was saved, the entries stay), a refusal that is
 * about no field, and the refusal of the review. A refusal about a field is told on the field and not here (`tiedToAField`).
 */
export function FlowAlerts({
  flow,
  tiedToAField,
}: {
  readonly flow: OrderFlow;
  readonly tiedToAField: boolean;
}): ReactNode {
  const { command } = flow;
  const rule = command.phase === 'conflict' ? command.problem?.rule : undefined;
  const moved = movedRule(rule);
  return (
    <>
      {command.phase === 'unknown' ? (
        <Alert variant="danger" announce>
          <p>{F.unknownOutcome}</p>
        </Alert>
      ) : null}
      {command.phase === 'conflict' && command.problem !== undefined ? (
        <Alert variant="danger" announce>
          {moved ? (
            <>
              <p className="orders-review__changed-title">
                {rule === 'configuration_changing'
                  ? WORDS.review.changing.title
                  : WORDS.review.stale.title}
              </p>
              <p>
                {rule === 'configuration_changing'
                  ? WORDS.review.changing.text
                  : WORDS.review.stale.text}
              </p>
            </>
          ) : (
            // A refusal of the state of the parcel or of the vendor (the parcel has its order, is missing, the check-in is open, no place is left) is told in its own words, and not as a vendor that changed.
            <p>{command.problem.message}</p>
          )}
        </Alert>
      ) : null}
      {command.phase === 'refused' && command.problem !== undefined && !tiedToAField ? (
        <Alert variant="danger" announce>
          <p>{command.problem.message}</p>
          {command.problem.reference === undefined ? null : (
            <p>Reference: {command.problem.reference}</p>
          )}
        </Alert>
      ) : null}
      {flow.checkProblem !== undefined && !tiedToAField ? (
        <Alert variant="danger" announce>
          <p>{flow.checkProblem.message}</p>
          {flow.checkProblem.reference === undefined ? null : (
            <p>Reference: {flow.checkProblem.reference}</p>
          )}
        </Alert>
      ) : null}
    </>
  );
}

/**
 * The actions of the form of an order, by where the flow is: *Check the price* while editing (waiting for a photo that is on its way, and saying so); *Confirm the order* while reviewing (*Confirm at GH₵40.00* when
 * the terms changed, because the officer is asked to confirm the new figure and not the old); *Try again* and *Look at the orders* when nobody knows whether the order was saved; and *Check the price again* when
 * the vendor or the hub's prices changed under the officer.
 */
export function FlowActions({
  flow,
  gate,
  cancelTo,
  confirm,
  lookLabel,
}: {
  readonly flow: OrderFlow;
  readonly gate: UploadGate;
  readonly cancelTo: string;
  /** What confirming says: *Confirm the order*, or *Save the change* for an amendment. */
  readonly confirm: string;
  /** What looking at the record says: *Look at the orders*. */
  readonly lookLabel: string;
}): ReactNode {
  const { stage, command } = flow;
  const reviewing = stage.kind === 'reviewing';
  const busy = stage.kind === 'checking' || command.phase === 'sending';
  const confirmLabel =
    stage.kind === 'reviewing' && stage.earlier !== undefined
      ? F.acts.confirmAt(formatMinor(stage.terms.total.amount_minor, 'GHS'))
      : confirm;
  return (
    <>
      {command.phase === 'unknown' ? (
        <>
          <Button
            key="retry"
            type="button"
            size="lg"
            data-recovery
            onClick={() => {
              void command.retry();
            }}
          >
            {F.acts.retry}
          </Button>
          {/* Looking is looking: it opens the record, where the officer finds out whether the order was made. It sends nothing and checks no price, and what was entered stays in the held command, which only *Try again* sends. */}
          <ButtonLink to={cancelTo} variant="secondary" size="lg">
            {lookLabel}
          </ButtonLink>
        </>
      ) : command.phase === 'conflict' ? (
        movedRule(command.problem?.rule) ? (
          <Button key="again" type="button" size="lg" onClick={command.checkRecord}>
            {F.acts.checkAgain}
          </Button>
        ) : (
          <Link to={cancelTo}>{F.acts.cancel}</Link>
        )
      ) : (
        <>
          <Button
            key="submit"
            type="submit"
            size="lg"
            loading={busy}
            disabled={!reviewing && gate.busy}
            aria-describedby="orders-form-gate"
          >
            {reviewing ? confirmLabel : stage.kind === 'checking' ? F.acts.checking : F.acts.check}
          </Button>
          <Link to={cancelTo}>{F.acts.cancel}</Link>
        </>
      )}
      <UploadGateNotice gate={gate} id="orders-form-gate" />
    </>
  );
}
