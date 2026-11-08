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
  /** The code has done its work (the rider scanned it), or is not wanted: it is gone at once. */
  readonly clear: () => void;
}

/**
 * Where an enrolment code lives on a page (S0.60; surfaces/ops-portal.md section 7): the QR code is a short-lived bearer credential, so the
 * grant is a transient secret (`useTransientSecret`) and never a query result, a mutation result, a storage, the address or a log. It is held
 * for the lesser of its own lifetime and the fifteen minutes a page may hold a secret, and it is gone on navigation, on completion (`clear`),
 * when the page is hidden, when the session ends or is replaced and when the screen is removed.
 *
 * The command that asks for it is a `useConfirmedCommand`: a flow is begun before the request is sent, and the answer is held only if the
 * flow is still current when it arrives, so an answer for a screen that has gone is refused wherever it ends up. The hook keeps no copy of
 * the answer.
 */
export function useEnrolmentCode<Command extends object>(
  options: EnrolmentCodeOptions<Command>,
): EnrolmentCode<Command> {
  const secret = useTransientSecret<EnrolmentGrantView>();
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
  return { command, grant: secret.value, status: secret.status, clear: secret.clear };
}
