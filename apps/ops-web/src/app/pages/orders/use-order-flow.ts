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
 * The flow of an order, **one step** (the Product Owner's decision D-S7-2, 23 November 2026; it replaces the review of the decisions of 19 and 20 November, whose second button an officer could press unread by
 * tapping twice): the price is shown beside the form **by itself**. Once what was entered is complete (the size, the destination and the address among it) the form asks the server for the price
 * (`previewOrder`, `previewOrderAmendment`), a moment after the last key (`PRICE_DEBOUNCE_MS`), **at most one request at a time, and an answer to what was entered before is thrown away**: the figure on the screen is
 * the price of what is on the screen, never of what was there a moment ago. Nothing is worked out in the browser.
 *
 * - **One save.** It sends the token of the price on the screen (`reviewed_terms`), so the server saves exactly what was shown. While what is entered differs from what was priced, the button says that the price is being
 *   checked and cannot be pressed.
 * - **A price that changed at the save** (`terms-changed`, the rates moved while the officer looked) is not an error: the price on the screen becomes the new one, the earlier one is shown beside it, and the save is
 *   offered again as a separate button that says the new figure; **a press in the moment after it appears is ignored** (`SAVE_GUARD_MS`), so that a second tap meant for the first button never saves a price nobody read.
 * - **A vendor that changed**, or **prices that are being changed** (`stale`, `configuration_changing`): nothing was saved, the entries stay, and one press reads the vendor again and checks the price again.
 * - **A save is one command** (`useConfirmedCommand`): a lost answer is sent again under the same key and never makes an order twice, and a refusal ends the attempt.
 * It is one flow for a new order and for the change of one that is not confirmed yet, so that they cannot disagree about what a price on the screen is.
 */
export const PRICE_DEBOUNCE_MS = 600;
export const SAVE_GUARD_MS = 600;

export type PriceState =
  /** What was entered is not complete enough to be priced: nothing is asked. */
  | { readonly kind: 'waiting' }
  /** The server is working the price out for what is entered. */
  | { readonly kind: 'checking' }
  /** The price of what is entered. `earlier` is the price the officer read before it changed at the save, when it did. */
  | { readonly kind: 'ready'; readonly terms: TermsView; readonly earlier: TermsView | undefined }
  /** The server would not price what is entered: the refusal is on the fields (`checkProblem`, `candidates`). */
  | { readonly kind: 'refused' };

export interface OrderCommand {
  readonly values: OrderFormValues;
  /** The `terms_token` of the price the save is made on. */
  readonly token: string;
  /** The version the act takes (`If-Match`), exactly as it was read. */
  readonly version: string;
}

export interface OrderFlowConfig {
  /** The operation the save is, so that a refusal is worded for it. */
  readonly operation: 'itemizeOrder' | 'amendOrder';
  /** The operation the price is, so that a refusal of it is worded for it. */
  readonly previewOperation: 'previewOrder' | 'previewOrderAmendment';
  readonly preview: (values: OrderFormValues) => Promise<PreviewOutcome>;
  readonly save: (command: OrderCommand, key: string) => Promise<SaveOutcome>;
  /** The version the save takes: the latest read. */
  readonly version: () => string;
  /** Reads the record again, for the version, after the vendor or the order changed under the officer. */
  readonly reload: () => Promise<unknown>;
  readonly onSaved: (order: SavedOrderView) => void;
  /** Whether what is entered can be priced, **given whether a zone has to be chosen** (an address that matches more than one zone). It is the form's own completeness and says nothing of what the server will answer. */
  readonly complete: (values: OrderFormValues, zoneNeeded: boolean) => boolean;
  /** What a price is of: two sets of entries with the same key have the same price, so a change that does not move it (the reason of a change) does not ask again. */
  readonly keyOf: (values: OrderFormValues) => string;
  /** How long after the last key the price is asked for. Default `PRICE_DEBOUNCE_MS`. */
  readonly debounceMs?: number;
}

/** What differs between two prices, in the parts an officer reads: a price, a date, who pays, the photos attached, the zone, the high-value status. */
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

/** The answer of the server to the entries of one key: a price, or a refusal (told on the fields). */
interface Answer {
  readonly key: string;
  readonly terms?: TermsView;
  readonly earlier?: TermsView;
  readonly problem?: Problem;
}

export interface OrderFlow {
  readonly price: PriceState;
  /** The save, and its states (`sending`, `unknown`, `refused`, `conflict`). */
  readonly command: ConfirmedCommand<OrderCommand>;
  /** Whether the save may be pressed now: the price on the screen is the price of what is entered, and nothing is being sent. */
  readonly pressable: boolean;
  /** The refusal of the price, if the server refused to work it out: the form tells it on the field it names. */
  readonly checkProblem: Problem | undefined;
  /** The zones an address matched with each other, for the officer to choose one: the server's own, from the refusal. */
  readonly candidates: readonly ZoneCandidateView[] | undefined;
  /** Saves the order on the price on the screen. Ignored unless the price is the price of what is entered, and for a moment after the price changed at the save. */
  readonly save: () => void;
  /** Takes the refusal of the save off the screen: the officer changed something. */
  readonly changed: () => void;
  readonly clearCandidates: () => void;
}

/** Whether a refusal is the kind the page shows and the officer reads: a session that has ended or an answer for one that has gone shows nothing. */
const worthShowing = (problem: Problem): boolean =>
  problem.kind !== 'session-ended' && problem.kind !== 'stale';

export function useOrderFlow(config: OrderFlowConfig, values: OrderFormValues): OrderFlow {
  const [answer, setAnswer] = useState<Answer | undefined>(undefined);
  const [candidates, setCandidates] = useState<readonly ZoneCandidateView[] | undefined>(undefined);
  const latest = useRef(config);
  const entered = useRef(values);
  const alive = useRef(true);
  const desired = useRef<{ readonly key: string; readonly values: OrderFormValues } | undefined>(
    undefined,
  );
  const inFlight = useRef(false);
  const due = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const armedUntil = useRef(0);
  const shown = useRef<Answer | undefined>(undefined);

  useEffect(() => {
    latest.current = config;
    entered.current = values;
  });
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (timer.current !== undefined) clearTimeout(timer.current);
    };
  }, []);

  const key = config.keyOf(values);
  const complete = config.complete(values, candidates !== undefined);

  /** Asks for the price of what is wanted now. One request at a time: a request that is out when another is due makes the finishing one ask again, for what is wanted then. */
  const pump = useCallback((): Promise<void> => {
    const run = async (): Promise<void> => {
      if (inFlight.current) {
        due.current = true;
        return;
      }
      const target = desired.current;
      if (target === undefined) return;
      inFlight.current = true;
      let outcome: PreviewOutcome | undefined;
      let failure: unknown;
      try {
        outcome = await latest.current.preview(target.values);
      } catch (error) {
        failure = error;
      }
      inFlight.current = false;
      if (!alive.current) return;
      // An answer is for the entries it was asked for: if they have changed since, it is thrown away and never drawn.
      if (desired.current?.key === target.key) {
        if (outcome?.kind === 'terms') {
          setAnswer({ key: target.key, terms: outcome.terms });
        } else if (outcome?.kind === 'zone-choice') {
          setCandidates(outcome.candidates);
          setAnswer({ key: target.key });
        } else {
          const problem = problemOf(failure, { operation: latest.current.previewOperation });
          setAnswer({ key: target.key, ...(worthShowing(problem) ? { problem } : {}) });
        }
      }
      if (due.current || (desired.current !== undefined && desired.current.key !== target.key)) {
        due.current = false;
        await run();
      }
    };
    return run();
  }, []);

  useEffect(() => {
    if (timer.current !== undefined) clearTimeout(timer.current);
    if (!complete) {
      desired.current = undefined;
      return;
    }
    desired.current = { key, values: entered.current };
    timer.current = setTimeout(() => {
      void pump();
    }, latest.current.debounceMs ?? PRICE_DEBOUNCE_MS);
    return () => {
      if (timer.current !== undefined) clearTimeout(timer.current);
    };
  }, [key, complete, pump]);

  const command = useConfirmedCommand<OrderCommand, SaveOutcome>({
    send: (sent, commandKey) => latest.current.save(sent, commandKey),
    onDone: (outcome) => {
      if (outcome.kind === 'saved') {
        latest.current.onSaved(outcome.order);
        return;
      }
      if (outcome.kind === 'zone-choice') {
        // The address matches more than one zone now: the officer chooses one and says why, as the price offers it.
        setCandidates(outcome.candidates);
        setAnswer(undefined);
        return;
      }
      // The price is not the one the officer read: it replaces it on the screen, the earlier one is shown beside it, and the save is offered again as a separate button that ignores a press for a moment.
      const earlier = shown.current?.terms;
      armedUntil.current = Date.now() + SAVE_GUARD_MS;
      setAnswer({
        key: desired.current?.key ?? key,
        terms: outcome.current,
        ...(earlier === undefined ? {} : { earlier }),
      });
    },
    // The save takes an Idempotency-Key: a lost answer is sent again under the same key, and an order is not made twice.
    retryable: true,
    operation: config.operation,
    onReload: async () => {
      // The vendor or the prices changed under the officer: nothing on the screen is the price of things as they are now, so the price comes off the screen at once (a press in the meantime would save on the version
      // and the figure that just proved wrong), the vendor is read again, and the price is asked for again of what was entered.
      setAnswer(undefined);
      await latest.current.reload();
      if (!alive.current) return;
      await pump();
    },
  });

  const forThese = complete && answer?.key === key;
  const price: PriceState = !complete
    ? { kind: 'waiting' }
    : !forThese
      ? { kind: 'checking' }
      : answer.terms === undefined
        ? { kind: 'refused' }
        : { kind: 'ready', terms: answer.terms, earlier: answer.earlier };
  useEffect(() => {
    shown.current = forThese ? answer : undefined;
  });
  const pressable = price.kind === 'ready' && !command.locked;
  const checkProblem = forThese ? answer.problem : undefined;

  const save = useCallback((): void => {
    // A press in the moment after the price changed is meant for the button that was there: it saves nothing. (A second press while a save is on its way is the command's own: it does nothing.)
    if (Date.now() < armedUntil.current) return;
    const onScreen = shown.current;
    if (onScreen?.terms === undefined || desired.current?.key !== onScreen.key) return;
    void command.submit({
      values: entered.current,
      token: onScreen.terms.terms_token,
      version: latest.current.version(),
    });
  }, [command]);

  return {
    price,
    command,
    pressable,
    checkProblem,
    candidates,
    save,
    changed: () => {
      command.dismiss();
    },
    clearCandidates: () => {
      setCandidates(undefined);
    },
  };
}
