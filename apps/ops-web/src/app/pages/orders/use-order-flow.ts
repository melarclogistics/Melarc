import { useCallback, useEffect, useRef, useState } from 'react';

import {
  useConfirmedCommand,
  type ConfirmedCommand,
} from '../../../platform/api/use-confirmed-command';
import type { OrderFormValues } from '../../../platform/hub-orders/order-form-model';
import type {
  PreviewOutcome,
  SaveOutcome,
  SavedOrderView,
} from '../../../platform/hub-orders/orders-commands';
import type { TermsView, ZoneCandidateView } from '../../../platform/hub-orders/orders-shape';
import { problemOf, type Problem } from '../../../platform/problem/problem-copy';

/**
 * The flow of an order, **review and then save** (the reviews of 19 and 20 November 2026, approved; PRODUCT_DESIGN_DIRECTION section 6.3: *a short review before submit*): the officer fills the form, the server
 * works out what confirming would give (`previewOrder`, `previewOrderAmendment`), the officer reads it, and the save is made on **the digest of those terms** (`reviewed_terms`). It is one flow for a new order and
 * for the amendment of one that is not confirmed yet, so that they cannot disagree about what a review is.
 *
 * - **Editing**: the form. **Checking**: the server is working the terms out. **Reviewing**: the terms are on the screen with what they say; the form is still in the page, only hidden, so that nothing entered is lost
 *   by looking at the review.
 * - **A price that changed while the officer looked** is not an error: the save answers with the terms as they are now (`terms-changed`), the screen shows them **beside the earlier ones** and asks for a
 *   second, explicit confirmation. The officer's entries stay.
 * - **A vendor that changed**, or **prices that are being changed** (`stale`, `configuration_changing`): nothing was saved, the entries stay, and one press reads the vendor again and checks the price again.
 * - **A save is one command** (`useConfirmedCommand`): a lost answer is sent again under the same key and never makes an order twice, and a refusal ends the attempt.
 */
export type FlowStage =
  | { readonly kind: 'editing' }
  | { readonly kind: 'checking' }
  | {
      readonly kind: 'reviewing';
      readonly terms: TermsView;
      /** The terms the officer read before they changed: shown beside the new ones, and the reason a second confirmation is asked for. */
      readonly earlier: TermsView | undefined;
    };

export interface OrderCommand {
  readonly values: OrderFormValues;
  /** The `terms_token` of the review the save is made on. */
  readonly token: string;
  /** The version the act takes (`If-Match`), exactly as it was read. */
  readonly version: string;
}

export interface OrderFlowConfig {
  /** The operation the save is, so that a refusal is worded for it. */
  readonly operation: 'itemizeOrder' | 'amendOrder';
  /** The operation the review is, so that a refusal of it is worded for it. */
  readonly previewOperation: 'previewOrder' | 'previewOrderAmendment';
  readonly preview: (values: OrderFormValues) => Promise<PreviewOutcome>;
  readonly save: (command: OrderCommand, key: string) => Promise<SaveOutcome>;
  /** The version the save takes: the latest read. */
  readonly version: () => string;
  /** Reads the record again, for the version, after the vendor or the order changed under the officer. */
  readonly reload: () => Promise<unknown>;
  readonly onSaved: (order: SavedOrderView) => void;
}

/** What differs between two reviews of one order, in the parts an officer reads: a price, a date, who pays, the photos attached, the zone, the high-value status. */
export type TermsDifference =
  'price' | 'date' | 'payer' | 'evidence' | 'zone' | 'highValue' | 'other';

const sameIds = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((id) => b.includes(id));

/** What changed between the terms the officer read and the terms now, read off the two answers and never worked out: an empty list for terms that are the same. */
export function termsDifferences(before: TermsView, now: TermsView): readonly TermsDifference[] {
  const found: TermsDifference[] = [];
  if (before.total.amount_minor !== now.total.amount_minor) found.push('price');
  if (before.delivery.committed_date !== now.delivery.committed_date) found.push('date');
  if (
    before.payer.sender.amount_minor !== now.payer.sender.amount_minor ||
    before.payer.recipient.amount_minor !== now.payer.recipient.amount_minor ||
    before.payer.commercial_state_after_confirmation !==
      now.payer.commercial_state_after_confirmation
  ) {
    found.push('payer');
  }
  if (
    !sameIds(before.cited_evidence.high_value, now.cited_evidence.high_value) ||
    before.cited_evidence.carrier_waybill !== now.cited_evidence.carrier_waybill
  ) {
    found.push('evidence');
  }
  if (
    before.destination.zone_name !== now.destination.zone_name ||
    before.destination.resolution !== now.destination.resolution
  ) {
    found.push('zone');
  }
  if (before.is_high_value !== now.is_high_value) found.push('highValue');
  if (found.length === 0 && before.terms_token !== now.terms_token) found.push('other');
  return found;
}

export interface OrderFlow {
  readonly stage: FlowStage;
  readonly command: ConfirmedCommand<OrderCommand>;
  /** The refusal of the review, if the server refused to work the terms out: the form tells it on the field it names. */
  readonly checkProblem: Problem | undefined;
  /** The zones an address matched with each other, for the officer to choose one: the server's own, from the refusal. */
  readonly candidates: readonly ZoneCandidateView[] | undefined;
  /** Asks the server to work the terms out. */
  readonly check: (values: OrderFormValues) => Promise<void>;
  /** Saves the order on the terms on the screen. Only while reviewing. */
  readonly confirm: (values: OrderFormValues) => void;
  /** Goes back to the form, with everything entered. */
  readonly back: () => void;
  /** Takes the refusal of the review and the zone choice off the screen: the officer changed something. */
  readonly changed: () => void;
  readonly clearCandidates: () => void;
}

/** Whether a refusal is the kind the page shows and the officer reads: a session that has ended or an answer for one that has gone shows nothing. */
const worthShowing = (problem: Problem): boolean =>
  problem.kind !== 'session-ended' && problem.kind !== 'stale';

export function useOrderFlow(config: OrderFlowConfig): OrderFlow {
  const [stage, setStage] = useState<FlowStage>({ kind: 'editing' });
  const [checkProblem, setCheckProblem] = useState<Problem | undefined>(undefined);
  const [candidates, setCandidates] = useState<readonly ZoneCandidateView[] | undefined>(undefined);
  const latest = useRef(config);
  const alive = useRef(true);
  const lastValues = useRef<OrderFormValues | undefined>(undefined);
  const reviewed = useRef<TermsView | undefined>(undefined);
  useEffect(() => {
    latest.current = config;
  });
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const check = useCallback(async (values: OrderFormValues, earlier?: TermsView): Promise<void> => {
    lastValues.current = values;
    setStage({ kind: 'checking' });
    setCheckProblem(undefined);
    try {
      const outcome = await latest.current.preview(values);
      if (!alive.current) return;
      if (outcome.kind === 'zone-choice') {
        setCandidates(outcome.candidates);
        setStage({ kind: 'editing' });
        return;
      }
      reviewed.current = outcome.terms;
      // Terms that are the ones the officer read (the vendor was read again and nothing changed) need no second look: the alert and the second confirmation are for terms that differ.
      const differs = earlier !== undefined && termsDifferences(earlier, outcome.terms).length > 0;
      setStage({ kind: 'reviewing', terms: outcome.terms, earlier: differs ? earlier : undefined });
    } catch (error) {
      if (!alive.current) return;
      const problem = problemOf(error, { operation: latest.current.previewOperation });
      if (worthShowing(problem)) setCheckProblem(problem);
      setStage({ kind: 'editing' });
    }
  }, []);

  const command = useConfirmedCommand<OrderCommand, SaveOutcome>({
    send: (sent, key) => latest.current.save(sent, key),
    onDone: (outcome) => {
      if (outcome.kind === 'saved') {
        latest.current.onSaved(outcome.order);
        return;
      }
      // The terms are not the ones the officer read: they are shown beside the earlier ones, and a second confirmation is asked for.
      const earlier = reviewed.current;
      reviewed.current = outcome.current;
      setStage({ kind: 'reviewing', terms: outcome.current, earlier });
    },
    // The save takes an Idempotency-Key: a lost answer is sent again under the same key, and an order is not made twice.
    retryable: true,
    operation: config.operation,
    onReload: async () => {
      // The vendor or the prices changed under the officer: read the vendor again, and check the price again on what was entered.
      await latest.current.reload();
      const values = lastValues.current;
      if (values !== undefined && alive.current) await check(values, reviewed.current);
    },
  });

  const confirm = useCallback(
    (values: OrderFormValues): void => {
      if (stage.kind !== 'reviewing') return;
      lastValues.current = values;
      void command.submit({
        values,
        token: stage.terms.terms_token,
        version: latest.current.version(),
      });
    },
    [command, stage],
  );

  return {
    stage,
    command,
    checkProblem,
    candidates,
    check: (values) => check(values),
    confirm,
    back: () => {
      command.dismiss();
      setStage({ kind: 'editing' });
    },
    changed: () => {
      setCheckProblem(undefined);
      command.dismiss();
    },
    clearCandidates: () => {
      setCandidates(undefined);
    },
  };
}
