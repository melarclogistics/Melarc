import type { ReactNode } from 'react';

import { Alert } from '../../../components/ui/alert/Alert';
import { Button } from '../../../components/ui/button/Button';
import { ButtonLink } from '../../../components/ui/button/ButtonLink';
import {
  UploadGateNotice,
  type UploadGate,
} from '../../../components/ui/evidence-upload/UploadGate';
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
            <p>{WORDS.common.reference(command.problem.reference)}</p>
          )}
        </Alert>
      ) : null}
      {flow.checkProblem !== undefined && !tiedToAField ? (
        <Alert variant="danger" announce>
          <p>{flow.checkProblem.message}</p>
          {flow.checkProblem.reference === undefined ? null : (
            <p>{WORDS.common.reference(flow.checkProblem.reference)}</p>
          )}
        </Alert>
      ) : null}
    </>
  );
}

/**
 * The actions of the form of an order, by where the flow is (D-S7-2): **one save**, with the line of what was typed right above it. The save says what it will do and at what price (*Save the order at GH₵40.00*);
 * while the price of what is entered is being checked it says so and cannot be pressed; when the price changed at the save it is a button of its own that says the new figure (*Save at GH₵45.00*), which the flow
 * ignores for a moment after it appears. *Try again* and *Look at the orders* are for an outcome nobody knows (looking sends nothing), and *Check the price again* for a vendor or prices that moved under the officer.
 */
export function FlowActions({
  flow,
  gate,
  cancelTo,
  typed,
  save,
  saveAt,
  lookLabel,
}: {
  readonly flow: OrderFlow;
  readonly gate: UploadGate;
  readonly cancelTo: string;
  /** What was typed, in one line: shown above the save. */
  readonly typed: string;
  /** What the save says before there is a price: *Save the order*, or *Save the change*. */
  readonly save: string;
  /** What the save says with the price: *Save the order at GH₵40.00*. */
  readonly saveAt: (price: string) => string;
  /** Where looking leads: the vendor's orders, or the order. */
  readonly lookLabel: string;
}): ReactNode {
  const { price, command } = flow;
  const total =
    price.kind === 'ready' ? formatMinor(price.terms.total.amount_minor, 'GHS') : undefined;
  const changed = price.kind === 'ready' && price.earlier !== undefined;
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
          <ButtonLink to={cancelTo} variant="secondary" size="lg">
            {F.acts.cancel}
          </ButtonLink>
        )
      ) : (
        <>
          {typed === '' ? null : (
            <p className="orders-typed" id="orders-typed">
              <span className="orders-typed__label">{WORDS.form.typed}</span> {typed}
            </p>
          )}
          <Button
            // A save at a changed price is another button, so that a press meant for the first is not a press of this one.
            key={changed ? 'save-new' : 'save'}
            type="submit"
            size="lg"
            loading={command.phase === 'sending'}
            disabled={price.kind === 'checking' || price.kind === 'refused' || gate.busy}
            aria-describedby={typed === '' ? 'orders-form-gate' : 'orders-typed orders-form-gate'}
          >
            {total === undefined
              ? price.kind === 'checking'
                ? F.acts.checking
                : save
              : changed
                ? F.acts.saveAtNew(total)
                : saveAt(total)}
          </Button>
          <ButtonLink to={cancelTo} variant="secondary" size="lg">
            {F.acts.cancel}
          </ButtonLink>
        </>
      )}
      <UploadGateNotice gate={gate} id="orders-form-gate" />
    </>
  );
}
