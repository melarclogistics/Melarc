export type HandshakeDirection = 'VENDOR_ENTERED_RIDER_DISPLAYED' | 'SENDER_SMS_RIDER_ENTERED';

export type HandshakeState =
  | 'PENDING'
  | 'CODE_GENERATED'
  | 'CODE_DELIVERED'
  | 'VERIFIED'
  | 'EXPIRED'
  | 'EXHAUSTED'
  | 'MANUALLY_RESOLVED'
  | 'DISPUTED';

export type HandshakeChannel = 'PORTAL' | 'SMS_FALLBACK' | 'OPS_OVERRIDE';

/**
 * The contract's `Handshake`: where the handshake of a stop stands. **The code never appears on it** (it is shown once, in the answer of
 * `initiateHandshake`, to the rider that asked), and neither do the digest, the key version, the generation, the officer's note or the lane's
 * bookkeeping.
 */
export interface HandshakeView {
  readonly stop_id: string;
  readonly state: HandshakeState;
  readonly direction: HandshakeDirection;
  readonly channel: HandshakeChannel | null;
  readonly attempts: number;
  readonly expires_at: string | null;
  readonly fallback_used: boolean;
  readonly authorised_by: string | null;
}

/** The answer of `initiateHandshake`: the handshake, and the code once for the rider to display to the vendor. */
export interface HandshakeIssuedView extends HandshakeView {
  readonly display_code?: string;
}

/** What the operations of the database return of a handshake, under the names of the contract, before it is a view. */
export interface HandshakeFacts {
  readonly stopId: string;
  readonly state: string;
  readonly direction: string;
  readonly channel: string | null;
  readonly attempts: number;
  readonly expiresAt: string | Date | null;
  readonly fallbackSends: number;
  readonly authorisedBy: string | null;
}

const iso = (value: string | Date | null): string | null =>
  value === null ? null : (value instanceof Date ? value : new Date(value)).toISOString();

/** The handshake as the contract states it: the members it names and no other. */
export function handshakeViewOf(facts: HandshakeFacts): HandshakeView {
  return {
    stop_id: facts.stopId,
    state: facts.state as HandshakeState,
    direction: facts.direction as HandshakeDirection,
    channel: facts.channel as HandshakeChannel | null,
    attempts: facts.attempts,
    expires_at: iso(facts.expiresAt),
    fallback_used: facts.fallbackSends > 0,
    authorised_by: facts.authorisedBy,
  };
}

/**
 * The operations of the database answer in `out_*` columns; this reads the members a view needs of one row of any of them, and refuses a row that
 * lacks the ones every handshake has (a defect of the function, never of the caller).
 */
export function handshakeFactsOf(
  stopId: string,
  row: Readonly<Record<string, unknown>>,
): HandshakeFacts {
  const state = row.out_state;
  const direction = row.out_direction;
  const attempts = row.out_attempts;
  const fallbackSends = row.out_fallback_sends;
  if (
    typeof state !== 'string' ||
    typeof direction !== 'string' ||
    typeof attempts !== 'number' ||
    typeof fallbackSends !== 'number'
  ) {
    throw new Error('An operation of the handshake answered without the facts of one');
  }
  const channel = row.out_channel;
  const expires = row.out_expires_at;
  const authorised = row.out_authorised_by;
  return {
    stopId,
    state,
    direction,
    channel: typeof channel === 'string' ? channel : null,
    attempts,
    expiresAt: expires instanceof Date || typeof expires === 'string' ? expires : null,
    fallbackSends,
    authorisedBy: typeof authorised === 'string' ? authorised : null,
  };
}
