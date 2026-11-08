import { randomBytes } from 'node:crypto';
import type { ReadableStreamReadResult } from 'node:stream/web';

import type { Secret } from '../../config/secret.js';
import { currentBudget, type ExecutionBudget } from '../../execution/execution-budget.js';
import { currentRequestContext } from '../../logging/request-context.js';
import type {
  AttestationEvidence,
  AttestationVerdict,
  AttestationVerifier,
} from '../ports/attestation-verifier.port.js';
import type { Metrics } from '../ports/metrics.port.js';
import { AttestationInterfaceError } from './attestation-errors.js';
import { MAX_ANSWER_BYTES, readVerifierAnswer } from './verifier-answer.js';

export interface ServiceAttestationVerifierOptions {
  /** The endpoint of the private verifier service (`ATTESTATION_VERIFIER_URL`): https, or plain http to a loopback host in a local run. */
  readonly url: string;
  /** The longest one call may take (`ATTESTATION_VERIFIER_TIMEOUT_MS`), further bounded by what the request's budget has left. */
  readonly timeoutMs: number;
  /** What the service requires as `Authorization: Bearer` (`ATTESTATION_VERIFIER_CALLER_SECRET`); absent only on loopback outside production. */
  readonly callerSecret?: Secret;
  readonly metrics: Metrics;
}

const REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * The production `AttestationVerifier`: it asks the private verifier service (apps/attestation-verifier; SECURITY_DESIGN.md §15.2.3) over
 * HTTP and reads its answer strictly (`verifier-answer.ts`). It decides nothing about a device and relabels nothing.
 *
 * - **Outside any transaction**, under the request's budget: the call runs as an `effect` of it (a request whose budget is gone starts no
 *   call, one that ends late is recorded), is bounded by the lesser of the configured time-out and what the budget has left, and is aborted
 *   with the budget.
 * - **Unreachable, late and overloaded are verdicts, not exceptions**: a connection that fails, a time-out and the service's own refusal
 *   answer `TRUST_DATA_UNAVAILABLE` with their closed cause, which says nothing about the device. An answer that breaks the interface (a
 *   status or a member that is not in it, a cause outside the closed sets, a key that is not the canonical form or is not the key it was
 *   asked about, an answer too large) is
 *   thrown as `AttestationInterfaceError`: a defect, alerted, and never a device refusal.
 * - **No redirect is followed**, TLS is verified by the platform's own store (nothing here relaxes it), nothing but the evidence is sent, and
 *   nothing of it is logged or counted: the metrics carry the outcome class and the closed cause.
 * - The caller secret is read once, here, into the header value it is sent as, and goes nowhere else.
 */
export class ServiceAttestationVerifier implements AttestationVerifier {
  readonly #endpoint: URL;
  readonly #timeoutMs: number;
  readonly #authorization: string | undefined;
  readonly #metrics: Metrics;

  constructor(options: ServiceAttestationVerifierOptions) {
    const base = new URL(options.url);
    this.#endpoint = new URL(base);
    this.#endpoint.pathname = `${base.pathname.replace(/\/+$/, '')}/v1/verify`;
    this.#endpoint.search = '';
    this.#endpoint.hash = '';
    this.#timeoutMs = options.timeoutMs;
    this.#authorization =
      options.callerSecret === undefined ? undefined : `Bearer ${options.callerSecret.reveal()}`;
    this.#metrics = options.metrics;
  }

  async verify(evidence: AttestationEvidence): Promise<AttestationVerdict> {
    const budget = currentBudget();
    let verdict: AttestationVerdict;
    try {
      verdict =
        budget === undefined
          ? await this.#exchange(evidence, undefined)
          : await budget.effect('attestation_verifier', () => this.#exchange(evidence, budget));
    } catch (error) {
      if (error instanceof AttestationInterfaceError) {
        this.#metrics.increment('attestation_verifier_calls_total', {
          outcome: 'INTERFACE_BROKEN',
        });
      }
      throw error;
    }
    // The service attests the key it is given and no other (its tenth step compares them): `VERIFIED` for another key is a service that has
    // broken its interface, and it is a defect counted as one, never a verdict about the handset. Both keys are in the one canonical form.
    if (verdict.verdict === 'VERIFIED' && verdict.attestedPublicKey !== evidence.devicePublicKey) {
      this.#metrics.increment('attestation_verifier_calls_total', { outcome: 'INTERFACE_BROKEN' });
      throw new AttestationInterfaceError('body.attested_public_key');
    }
    this.#count(verdict);
    return verdict;
  }

  #count(verdict: AttestationVerdict): void {
    this.#metrics.increment('attestation_verifier_calls_total', { outcome: verdict.verdict });
    if (verdict.verdict === 'TRUST_DATA_UNAVAILABLE') {
      this.#metrics.increment('attestation_verifier_unavailable_total', { cause: verdict.cause });
    } else if (verdict.verdict === 'DEVICE_INTEGRITY_FAILED') {
      this.#metrics.increment('attestation_integrity_failures_total', { cause: verdict.cause });
    }
  }

  async #exchange(
    evidence: AttestationEvidence,
    budget: ExecutionBudget | undefined,
  ): Promise<AttestationVerdict> {
    // Whole milliseconds, and at least one: the budget's reading is fractional, and a signal's time-out is an integer.
    const remaining = budget?.remainingMilliseconds();
    const limit =
      remaining === undefined
        ? this.#timeoutMs
        : Math.min(this.#timeoutMs, Math.max(1, Math.floor(remaining)));
    const timer = AbortSignal.timeout(limit);
    const signal = budget === undefined ? timer : AbortSignal.any([timer, budget.signal]);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Request-Id': requestId(),
    };
    if (this.#authorization !== undefined) headers.Authorization = this.#authorization;
    const body = JSON.stringify({
      version: 1,
      certificate_chain: evidence.certificateChain,
      expected_challenge_sha256: Buffer.from(evidence.expectedChallengeSha256).toString('hex'),
      device_public_key: evidence.devicePublicKey,
    });

    try {
      const response = await fetch(this.#endpoint, {
        method: 'POST',
        headers,
        body,
        redirect: 'manual',
        signal,
      });
      const status = response.status;
      // An answer that cannot be a verdict is not read: a redirect or a refusal breaks the interface whatever it says.
      if (status < 200 || (status >= 300 && status < 500)) {
        await response.body?.cancel().catch(() => undefined);
        return readVerifierAnswer({ status, contentType: null, body: new Uint8Array(0) });
      }
      const declared = response.headers.get('content-length');
      if (declared !== null && Number(declared) > MAX_ANSWER_BYTES) {
        await response.body?.cancel().catch(() => undefined);
        if (status >= 500)
          return { verdict: 'TRUST_DATA_UNAVAILABLE', cause: 'VERIFIER_UNREACHABLE' };
        throw new AttestationInterfaceError('body.size');
      }
      return readVerifierAnswer({
        status,
        contentType: response.headers.get('content-type'),
        // Too much from something that answered with a server error is a proxy's page, not a verdict that broke the interface.
        body: await readCapped(response, status >= 500),
      });
    } catch (error) {
      if (error instanceof AttestationInterfaceError) throw error;
      // The budget ran out while the call was in flight: the platform answers that, not this port.
      const expired = budget?.expiredWith;
      if (expired !== undefined) throw expired;
      if (timer.aborted) return { verdict: 'TRUST_DATA_UNAVAILABLE', cause: 'VERIFIER_TIMEOUT' };
      return { verdict: 'TRUST_DATA_UNAVAILABLE', cause: 'VERIFIER_UNREACHABLE' };
    }
  }
}

/** The correlation id the service echoes: the request's own when it is well formed, else a fresh one. */
function requestId(): string {
  const own = currentRequestContext()?.requestId;
  return own !== undefined && REQUEST_ID.test(own) ? own : randomBytes(8).toString('hex');
}

/** The body, read up to the cap and no further: past it, an empty body when `lenient`, else the interface is broken. */
async function readCapped(response: Response, lenient: boolean): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (reader === undefined) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    // The platform types a response body's chunks as `any`: a chunk of a fetch body is bytes.
    const { done, value } = (await reader.read()) as ReadableStreamReadResult<Uint8Array>;
    if (done) break;
    total += value.byteLength;
    if (total > MAX_ANSWER_BYTES) {
      await reader.cancel().catch(() => undefined);
      if (lenient) return new Uint8Array(0);
      throw new AttestationInterfaceError('body.size');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
