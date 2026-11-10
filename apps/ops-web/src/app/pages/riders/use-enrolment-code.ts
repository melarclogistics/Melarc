import { useState } from 'react';

import {
  useConfirmedCommand,
  type ConfirmedCommand,
} from '../../../platform/api/use-confirmed-command';
import type { EnrolmentGrantView } from '../../../platform/rider/rider-shape';
import {
  lifetimeFromExpiry,
  useTransientSecret,
  type SecretFlow,
  type SecretStatus,
} from '../../../platform/secrets/use-transient-secret';

export interface EnrolmentCodeOptions<Command extends object> {
  /** The operation the failure is worded for. */
  readonly operation: 'registerRiderDevice' | 'reregisterRiderDevice';
  /**
   * Sending the same command again is safe: the registration takes an `Idempotency-Key`, so a retry replays the grant while it stands. A
   * replacement takes none, and an unknown outcome there is resolved by looking at the rider.
   */
  readonly retryable: boolean;
  /** Asks for the grant. The signal ends the request when the screen lets go of the answer; the key is the command's `Idempotency-Key`. */
  readonly request: (
    command: Command,
    idempotencyKey: string,
    signal: AbortSignal,
  ) => Promise<EnrolmentGrantView>;
  /** The person asks to see the rider as it is now. */
  readonly onReload: () => unknown;
}

export interface EnrolmentCode<Command extends object> {
  /** The command that asks for a code: its phase, its refusals and its way out of an unknown outcome. */
  readonly command: ConfirmedCommand<Command>;
  /** The grant, **only while it is held and its time has not passed**: the credential of the QR code, in memory and nowhere else. */
  readonly grant: EnrolmentGrantView | undefined;
  readonly status: SecretStatus;
  /**
   * A code that was on the screen was taken off it because another was asked for. It stays set while the page is open; a page says so where no
   * code is on the screen. **Taking a code off the screen does not end it**: the server ends the earlier code when it makes the new one, and a
   * lost answer may mean it already has. What the page says of it must claim no more.
   */
  readonly withdrawn: boolean;
  /** The code has done its work (the rider scanned it), or is not wanted: it is gone at once. */
  readonly clear: () => void;
}

/**
 * Where an enrolment code lives on a page (S0.60; surfaces/ops-portal.md section 7): the QR code is a short-lived bearer credential, so the
 * grant is a transient secret (`useTransientSecret`) and never a query result, a mutation result, a storage, the address or a log. It is held
 * for the lesser of its own lifetime and the fifteen minutes a page may hold a secret, and it is gone on navigation, on completion (`clear`),
 * when the page is hidden, when the session ends or is replaced, when the screen is removed and **when another code is asked for**.
 *
 * The command that asks for it is a `useConfirmedCommand`: a flow is begun before the request is sent, and the answer is held only if the
 * flow is still current when it arrives, so an answer for a screen that has gone is refused wherever it ends up. The hook keeps no copy of
 * the answer.
 *
 * **Asking for another code lets go of the one held, before the request, and for good.** The answer may be lost, and then the new code may have
 * been made and the earlier one ended, so the earlier one is not shown as usable while the outcome is in doubt; and it must not come back when
 * its time runs out, when the officer looks at the rider, or when the attempt is abandoned. Letting go of it is the screen's own act: it ends
 * nothing at the server, which does that when it makes the new code. Because no code is held while a request is under way or in doubt, the
 * page shows the command's own state (sending, refused, in conflict, outcome unknown) and never the screen of a code, or of a lapsed one.
 */
export function useEnrolmentCode<Command extends object>(
  options: EnrolmentCodeOptions<Command>,
): EnrolmentCode<Command> {
  // The code is let go of the moment the router moves, and not when the page it was on is replaced: a Back in the time the next page takes to be drawn must not show it again.
  const secret = useTransientSecret<EnrolmentGrantView>({ releaseWhenRouterMoves: true });
  const [withdrawn, setWithdrawn] = useState(false);
  const command = useConfirmedCommand<
    Command,
    { readonly flow: SecretFlow; readonly grant: EnrolmentGrantView }
  >({
    operation: options.operation,
    retryable: options.retryable,
    onReload: options.onReload,
    send: async (asked, key) => {
      const flow = secret.begin();
      const grant = await options.request(asked, key, flow.signal);
      return { flow, grant };
    },
    onDone: ({ flow, grant }) => {
      secret.hold(flow, grant, lifetimeFromExpiry(grant.expiresAt));
    },
  });

  async function submit(asked: Command): Promise<void> {
    // Only a code that is on the screen, or has lapsed from it, is let go of: with none held, a request may be on its way, and clearing would
    // call off its flow. A live code is told to the officer (`withdrawn`); a lapsed one has already been told, in the words of its own screen.
    if (secret.status !== 'none') {
      setWithdrawn(secret.status === 'held');
      secret.clear();
    }
    await command.submit(asked);
  }

  return {
    command: { ...command, submit },
    grant: secret.value,
    status: secret.status,
    withdrawn,
    clear: secret.clear,
  };
}
