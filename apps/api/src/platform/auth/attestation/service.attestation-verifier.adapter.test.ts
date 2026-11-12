import { generateKeyPairSync } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { inspect } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { ManualClock } from '../../../test-support/manual-clock.js';
import { SystemClock } from '../clock/system.clock.adapter.js';
import { Secret } from '../../config/secret.js';
import {
  BudgetClosedError,
  BudgetExpiredError,
  ExecutionBudget,
  runWithBudget,
} from '../../execution/execution-budget.js';
import { runWithRequestContext } from '../../logging/request-context.js';
import { BoundedMetrics } from '../../metrics/bounded.metrics.adapter.js';
import type { AttestationEvidence } from '../ports/attestation-verifier.port.js';
import { AttestationInterfaceError } from './attestation-errors.js';
import { ServiceAttestationVerifier } from './service.attestation-verifier.adapter.js';
import { MAX_ANSWER_BYTES } from './verifier-answer.js';

const KEY = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  .publicKey.export({ type: 'spki', format: 'der' })
  .toString('base64');
const SECRET = 'S'.repeat(43);
const CHALLENGE_HASH = Buffer.alloc(32, 0xab);

const evidence: AttestationEvidence = {
  expectedChallengeSha256: new Uint8Array(CHALLENGE_HASH),
  certificateChain: ['AAAA', 'BBBB', 'CCCC'],
  devicePublicKey: KEY,
};

const verifiedBody = {
  version: 1,
  verdict: 'VERIFIED',
  attested_public_key: KEY,
  summary: {
    security_level: 'STRONG_BOX',
    attestation_version: 300,
    key_mint_version: 300,
    package_name: 'com.melarc.rider',
    signer_digests: ['a'.repeat(64)],
  },
};

interface Seen {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingMessage['headers'];
  body: string;
}

type Handler = (seen: Seen, response: ServerResponse) => void;

const clock = new SystemClock();
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((done) => {
          server.closeAllConnections();
          server.close(() => {
            done();
          });
        }),
    ),
  );
});

/** A stand-in for the verifier service on a free loopback port, and what it was asked. */
async function serve(handler: Handler): Promise<{ url: string; requests: Seen[] }> {
  const requests: Seen[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const seen: Seen = {
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(seen);
      handler(seen, response);
    });
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return { url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`, requests };
}

const json = (
  response: ServerResponse,
  status: number,
  body: unknown,
  type = 'application/json; charset=utf-8',
) => {
  response.writeHead(status, { 'Content-Type': type });
  response.end(typeof body === 'string' ? body : JSON.stringify(body));
};

/**
 * A response whose length is declared, as a server that sets `Content-Length` sends it. `json` above writes its head first, so its body is
 * always chunked: the two ways of knowing the size of an answer are two paths of the adapter, and each has its own test.
 */
const declared = (
  response: ServerResponse,
  status: number,
  body: string,
  type = 'application/json',
) => {
  response.writeHead(status, {
    'Content-Type': type,
    'Content-Length': String(Buffer.byteLength(body)),
  });
  response.end(body);
};

/** The smallest answer that is a verdict, padded with the white space JSON allows to exactly `length` bytes. */
const paddedVerdict = (length: number): string => {
  const verdict = '{"version":1,"verdict":"DEVICE_SECURITY_UNSUPPORTED"}';
  return verdict + ' '.repeat(length - verdict.length);
};

function metrics() {
  return new BoundedMetrics({ policy: 'throw', clock });
}

function adapter(
  url: string,
  options: { timeoutMs?: number; secret?: string; registry?: BoundedMetrics } = {},
) {
  const registry = options.registry ?? metrics();
  const verifier = new ServiceAttestationVerifier({
    url,
    timeoutMs: options.timeoutMs ?? 5_000,
    ...(options.secret === undefined ? {} : { callerSecret: new Secret(options.secret) }),
    metrics: registry,
  });
  return { verifier, registry };
}

const counts = (registry: BoundedMetrics) =>
  Object.fromEntries(
    registry
      .snapshot()
      .counters.map((counter) => [
        `${counter.name}${Object.values(counter.labels).length > 0 ? `{${Object.values(counter.labels).join(',')}}` : ''}`,
        counter.value,
      ]),
  );

describe('the production attestation verifier over the private service', () => {
  describe('what it asks', () => {
    it('posts the evidence as the four members of the versioned request, with the caller’s secret and a request id', async () => {
      const { url, requests } = await serve((_seen, response) => {
        json(response, 200, verifiedBody);
      });
      const { verifier } = adapter(url, { secret: SECRET });

      await verifier.verify(evidence);

      expect(requests).toHaveLength(1);
      const [seen] = requests;
      expect(seen?.method).toBe('POST');
      expect(seen?.url).toBe('/v1/verify');
      expect(seen?.headers['content-type']).toBe('application/json');
      expect(seen?.headers.accept).toBe('application/json');
      expect(seen?.headers.authorization).toBe(`Bearer ${SECRET}`);
      expect(seen?.headers['x-request-id']).toMatch(/^[0-9a-f]{16}$/);
      expect(JSON.parse(seen?.body ?? '')).toEqual({
        version: 1,
        certificate_chain: ['AAAA', 'BBBB', 'CCCC'],
        expected_challenge_sha256: 'ab'.repeat(32),
        device_public_key: KEY,
      });
    });

    it('sends no Authorization where it holds no secret, and the request’s own id when it is well formed', async () => {
      const { url, requests } = await serve((_seen, response) => {
        json(response, 200, verifiedBody);
      });
      const { verifier } = adapter(url);

      await runWithRequestContext({ requestId: 'req-123.abc_DEF' }, () =>
        verifier.verify(evidence),
      );
      await runWithRequestContext({ requestId: 'not a safe id\r\nX: y' }, () =>
        verifier.verify(evidence),
      );

      expect(requests[0]?.headers.authorization).toBeUndefined();
      expect(requests[0]?.headers['x-request-id']).toBe('req-123.abc_DEF');
      expect(requests[1]?.headers['x-request-id']).toMatch(/^[0-9a-f]{16}$/);
    });

    it.each([
      ['http://127.0.0.1:PORT', '/v1/verify'],
      ['http://127.0.0.1:PORT/', '/v1/verify'],
      ['http://127.0.0.1:PORT/attest', '/attest/v1/verify'],
      ['http://127.0.0.1:PORT/attest/', '/attest/v1/verify'],
      ['http://127.0.0.1:PORT/a//', '/a/v1/verify'],
      // Break caught: a query that rides along to the verifier (a token, a routing hint), and one that is not the path's to carry.
      ['http://127.0.0.1:PORT/attest?token=1#fragment', '/attest/v1/verify'],
      ['http://127.0.0.1:PORT/?x=1', '/v1/verify'],
    ])('reaches %s at %s', async (template, path) => {
      const { url, requests } = await serve((_seen, response) => {
        json(response, 200, verifiedBody);
      });
      const port = new URL(url).port;

      await adapter(template.replace('PORT', port)).verifier.verify(evidence);

      expect(requests[0]?.url).toBe(path);
    });

    // Break caught: the secret printed by an inspector, a serialiser or an error.
    it('does not give its secret to anything that prints it', async () => {
      const { url } = await serve((_seen, response) => {
        json(response, 200, verifiedBody);
      });
      const { verifier } = adapter(url, { secret: SECRET });

      expect(inspect(verifier, { depth: 5 })).not.toContain(SECRET);
      expect(JSON.stringify(verifier)).not.toContain(SECRET);
      expect(Object.prototype.toString.call(verifier)).not.toContain(SECRET);
    });
  });

  describe('what it answers', () => {
    it('hands back the verdict the service gave, unchanged, and counts it', async () => {
      const verdicts: unknown[] = [
        verifiedBody,
        { version: 1, verdict: 'DEVICE_INTEGRITY_FAILED', cause: 'CERTIFICATE_REVOKED' },
        { version: 1, verdict: 'DEVICE_SECURITY_UNSUPPORTED' },
        { version: 1, verdict: 'TRUST_DATA_UNAVAILABLE', cause: 'TRUST_DATA_STALE' },
      ];
      let next = 0;
      const { url } = await serve((_seen, response) => {
        json(response, 200, verdicts[next++]);
      });
      const { verifier, registry } = adapter(url);

      const answered = [
        await verifier.verify(evidence),
        await verifier.verify(evidence),
        await verifier.verify(evidence),
        await verifier.verify(evidence),
      ];

      expect(answered).toEqual([
        {
          verdict: 'VERIFIED',
          attestedPublicKey: KEY,
          summary: {
            securityLevel: 'STRONG_BOX',
            attestationVersion: 300,
            keyMintVersion: 300,
            packageName: 'com.melarc.rider',
            signerDigests: ['a'.repeat(64)],
          },
        },
        { verdict: 'DEVICE_INTEGRITY_FAILED', cause: 'CERTIFICATE_REVOKED' },
        { verdict: 'DEVICE_SECURITY_UNSUPPORTED' },
        { verdict: 'TRUST_DATA_UNAVAILABLE', cause: 'TRUST_DATA_STALE' },
      ]);
      expect(counts(registry)).toEqual({
        'attestation_verifier_calls_total{VERIFIED}': 1,
        'attestation_verifier_calls_total{DEVICE_INTEGRITY_FAILED}': 1,
        'attestation_verifier_calls_total{DEVICE_SECURITY_UNSUPPORTED}': 1,
        'attestation_verifier_calls_total{TRUST_DATA_UNAVAILABLE}': 1,
        'attestation_integrity_failures_total{CERTIFICATE_REVOKED}': 1,
        'attestation_verifier_unavailable_total{TRUST_DATA_STALE}': 1,
      });
    });

    it('answers the service’s own refusal when it is overloaded or late, as a 503 with the verdict of an unavailable verifier', async () => {
      const { url } = await serve((_seen, response) => {
        json(response, 503, {
          version: 1,
          verdict: 'TRUST_DATA_UNAVAILABLE',
          cause: 'VERIFIER_OVERLOADED',
        });
      });
      const { verifier, registry } = adapter(url);

      expect(await verifier.verify(evidence)).toEqual({
        verdict: 'TRUST_DATA_UNAVAILABLE',
        cause: 'VERIFIER_OVERLOADED',
      });
      expect(counts(registry)['attestation_verifier_unavailable_total{VERIFIER_OVERLOADED}']).toBe(
        1,
      );
    });

    // Break caught: a chain too big for the service to read (the caller's to make, up to the API's own body limit) taken for a broken interface,
    // which would be a 500 for anyone who asked and an alert for a request that was only too big; it is a malformed chain, counted so.
    it('answers a chain the service will not read for its size as a malformed chain, and counts it so', async () => {
      const { url } = await serve((_seen, response) => {
        json(response, 413, { version: 1, error: 'REQUEST_TOO_LARGE', field: 'body' });
      });
      const { verifier, registry } = adapter(url);

      expect(await verifier.verify(evidence)).toEqual({
        verdict: 'DEVICE_INTEGRITY_FAILED',
        cause: 'EVIDENCE_MALFORMED',
      });
      expect(counts(registry)).toEqual({
        'attestation_verifier_calls_total{DEVICE_INTEGRITY_FAILED}': 1,
        'attestation_integrity_failures_total{EVIDENCE_MALFORMED}': 1,
      });
    });

    // Break caught: an unreachable verifier read as a device refused, which would tell a rider that their phone is wrong.
    it.each([
      ['a server error', 500, 'oops', 'text/plain'],
      ['a bad gateway', 502, '<html>bad gateway</html>', 'text/html'],
      ['a proxy’s unavailable page', 503, '<html>busy</html>', 'text/html'],
      ['a gateway time-out', 504, '', 'text/plain'],
    ])('treats %s as a verifier that did not answer', async (_label, status, body, type) => {
      const { url } = await serve((_seen, response) => {
        json(response, status, body, type);
      });
      const { verifier, registry } = adapter(url);

      expect(await verifier.verify(evidence)).toEqual({
        verdict: 'TRUST_DATA_UNAVAILABLE',
        cause: 'VERIFIER_UNREACHABLE',
      });
      expect(counts(registry)['attestation_verifier_unavailable_total{VERIFIER_UNREACHABLE}']).toBe(
        1,
      );
    });

    it('treats a server error with an enormous page as a verifier that did not answer', async () => {
      const { url } = await serve((_seen, response) => {
        json(response, 502, 'x'.repeat(MAX_ANSWER_BYTES * 4), 'text/html');
      });

      expect(await adapter(url).verifier.verify(evidence)).toEqual({
        verdict: 'TRUST_DATA_UNAVAILABLE',
        cause: 'VERIFIER_UNREACHABLE',
      });
    });

    it('treats a server error whose enormous page is declared in its length as a verifier that did not answer', async () => {
      const { url } = await serve((_seen, response) => {
        declared(response, 502, 'x'.repeat(MAX_ANSWER_BYTES * 4), 'text/html');
      });

      expect(await adapter(url).verifier.verify(evidence)).toEqual({
        verdict: 'TRUST_DATA_UNAVAILABLE',
        cause: 'VERIFIER_UNREACHABLE',
      });
    });

    // Break caught: a cap that is off by one in either place it is applied, the length the service declares and the bytes counted as they arrive.
    it('reads an answer of exactly the cap, whether its length is declared or not', async () => {
      const body = paddedVerdict(MAX_ANSWER_BYTES);
      const sent = await serve((_seen, response) => {
        declared(response, 200, body);
      });
      const chunked = await serve((_seen, response) => {
        json(response, 200, body);
      });

      expect(await adapter(sent.url).verifier.verify(evidence)).toEqual({
        verdict: 'DEVICE_SECURITY_UNSUPPORTED',
      });
      expect(await adapter(chunked.url).verifier.verify(evidence)).toEqual({
        verdict: 'DEVICE_SECURITY_UNSUPPORTED',
      });
    });

    it('treats a connection that cannot be made as a verifier that is unreachable', async () => {
      const { url } = await serve((_seen, response) => {
        json(response, 200, verifiedBody);
      });
      const [first] = servers;
      await new Promise<void>((done) => {
        first?.close(() => {
          done();
        });
      });

      expect(await adapter(url).verifier.verify(evidence)).toEqual({
        verdict: 'TRUST_DATA_UNAVAILABLE',
        cause: 'VERIFIER_UNREACHABLE',
      });
    });

    it('treats a connection cut mid-answer as a verifier that is unreachable', async () => {
      const { url } = await serve((_seen, response) => {
        response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '500' });
        response.write('{"version":1,');
        setTimeout(() => response.destroy(), 20);
      });

      expect(await adapter(url).verifier.verify(evidence)).toEqual({
        verdict: 'TRUST_DATA_UNAVAILABLE',
        cause: 'VERIFIER_UNREACHABLE',
      });
    });

    // Break caught: a call with no bound, which holds a rider’s request for as long as the verifier likes.
    it('gives up after its time-out and says the verifier was late', async () => {
      const { url } = await serve(() => undefined);
      const { verifier, registry } = adapter(url, { timeoutMs: 150 });

      const started = performance.now();
      const verdict = await verifier.verify(evidence);

      expect(verdict).toEqual({ verdict: 'TRUST_DATA_UNAVAILABLE', cause: 'VERIFIER_TIMEOUT' });
      expect(performance.now() - started).toBeLessThan(2_000);
      expect(counts(registry)['attestation_verifier_unavailable_total{VERIFIER_TIMEOUT}']).toBe(1);
    });

    it('gives up on a body that never ends', async () => {
      const { url } = await serve((_seen, response) => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.write('{"version":1,');
      });

      expect(await adapter(url, { timeoutMs: 150 }).verifier.verify(evidence)).toEqual({
        verdict: 'TRUST_DATA_UNAVAILABLE',
        cause: 'VERIFIER_TIMEOUT',
      });
    });
  });

  describe('an answer that breaks the interface is a defect', () => {
    const broken = async (handler: Handler, expected: string) => {
      const { url } = await serve(handler);
      const { verifier, registry } = adapter(url);
      let thrown: unknown;
      try {
        await verifier.verify(evidence);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AttestationInterfaceError);
      expect((thrown as AttestationInterfaceError).field).toBe(expected);
      expect(counts(registry)).toEqual({ 'attestation_verifier_calls_total{INTERFACE_BROKEN}': 1 });
    };

    it('does not follow a redirect', async () => {
      const other = await serve((_seen, response) => {
        json(response, 200, verifiedBody);
      });
      await broken((_seen, response) => {
        response.writeHead(302, { Location: `${other.url}/v1/verify` });
        response.end();
      }, 'status.redirect');
      expect(other.requests).toHaveLength(0);
    });

    it.each([
      [400, 'status.refused'],
      [401, 'status.refused'],
      [403, 'status.refused'],
      [404, 'status.refused'],
      [415, 'status.refused'],
      [429, 'status.refused'],
      [204, 'status'],
    ])('refuses to read status %i as an answer', async (status, field) => {
      await broken((_seen, response) => {
        json(response, status, { version: 1, error: 'X' });
      }, field);
    });

    // Break caught (S0.57): a `VERIFIED` for another key than the one the service was asked about, read as a verdict and counted as one. The
    // service attests only the key it is given, so another is a service that has broken its interface, and it is counted as that, which is
    // what an alert on the interface reads. (The enrolment compares the keys itself as well, whatever adapter it is given.)
    it('refuses a VERIFIED for another key than the one it was asked about, and counts it as a broken interface', async () => {
      const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
        .publicKey.export({ type: 'spki', format: 'der' })
        .toString('base64');
      await broken((_seen, response) => {
        json(response, 200, { ...verifiedBody, attested_public_key: other });
      }, 'body.attested_public_key');
    });

    it('refuses a verdict that is not in the interface', async () => {
      await broken((_seen, response) => {
        json(response, 200, { version: 1, verdict: 'VERIFIED' });
      }, 'body.attested_public_key');
    });

    it('refuses an answer that is not json', async () => {
      await broken((_seen, response) => {
        json(response, 200, 'verified', 'text/plain');
      }, 'content_type');
    });

    it('refuses an answer larger than the cap, declared or not', async () => {
      await broken((_seen, response) => {
        declared(response, 200, paddedVerdict(MAX_ANSWER_BYTES + 1));
      }, 'body.size');
      await broken((_seen, response) => {
        json(response, 200, 'x'.repeat(MAX_ANSWER_BYTES + 1));
      }, 'body.size');
      await broken((_seen, response) => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.write(' '.repeat(MAX_ANSWER_BYTES));
        response.write(' ');
        response.end();
      }, 'body.size');
    });
  });

  describe('under the request’s budget', () => {
    it('makes the call as an effect of the budget, and bounds it by what the budget has left', async () => {
      const { url } = await serve(() => undefined);
      const { verifier } = adapter(url, { timeoutMs: 30_000 });
      const budget = new ExecutionBudget(clock, 'request', 200);

      const started = performance.now();
      const outcome = await runWithBudget(budget, () => verifier.verify(evidence)).catch(
        (error: unknown) => error,
      );
      // Two ends are right, and which is seen first is a race of about a millisecond: the call's own deadline is the whole milliseconds
      // the budget has left (`Math.floor`), so it fires with, or just before, the budget's timer. When both are due in the same timer
      // phase the budget has expired by the time the call returns, and the answer is the budget's error; when they are split (seen in
      // a hosted run of 8 November 2026) the call gives up first and answers `VERIFIER_TIMEOUT`. Each mechanism alone is held
      // by the two tests below (a clock that has not moved leaves only the call's deadline; an optimistic budget leaves only the
      // budget's abort). What this one holds is that the call ends by what the budget has left, and not at its own 30 s time-out.
      const ended = outcome instanceof BudgetExpiredError ? 'the budget expired' : outcome;
      expect([
        'the budget expired',
        { verdict: 'TRUST_DATA_UNAVAILABLE', cause: 'VERIFIER_TIMEOUT' },
      ]).toContainEqual(ended);
      expect(performance.now() - started).toBeLessThan(2_000);
    });

    // Break caught: a call bounded only by the budget's own signal, which a budget that has time left on a clock that has not moved never
    // raises. The call has the lesser of its time-out and what the budget has left.
    it('gives up when the time the budget has left has passed, though the budget has not run out', async () => {
      const { url } = await serve(() => undefined);
      const { verifier, registry } = adapter(url, { timeoutMs: 30_000 });
      const budget = new ExecutionBudget(new ManualClock(), 'request', 250);

      const started = performance.now();
      const verdict = await runWithBudget(budget, () => verifier.verify(evidence));
      budget.finish();

      expect(verdict).toEqual({ verdict: 'TRUST_DATA_UNAVAILABLE', cause: 'VERIFIER_TIMEOUT' });
      expect(performance.now() - started).toBeLessThan(2_000);
      expect(counts(registry)['attestation_verifier_unavailable_total{VERIFIER_TIMEOUT}']).toBe(1);
    });

    // Break caught: a call that outlives its budget because the time it was given is longer than the budget's own: it is aborted with the budget.
    it('is aborted with the budget, whatever time the budget says it has left', async () => {
      class Optimistic extends ExecutionBudget {
        override remainingMilliseconds(): number {
          return 60_000;
        }
      }
      const { url } = await serve(() => undefined);
      const { verifier } = adapter(url, { timeoutMs: 30_000 });
      const budget = new Optimistic(clock, 'request', 200);

      const started = performance.now();
      await expect(runWithBudget(budget, () => verifier.verify(evidence))).rejects.toBeInstanceOf(
        BudgetExpiredError,
      );
      expect(performance.now() - started).toBeLessThan(2_000);
    });

    it('starts no call under a budget that has run out or been finished', async () => {
      const { url, requests } = await serve((_seen, response) => {
        json(response, 200, verifiedBody);
      });
      const { verifier } = adapter(url);
      const finished = new ExecutionBudget(clock, 'request', 5_000);
      finished.finish();

      await expect(runWithBudget(finished, () => verifier.verify(evidence))).rejects.toBeInstanceOf(
        BudgetClosedError,
      );
      expect(requests).toHaveLength(0);
    });

    it('answers normally inside a budget it fits in', async () => {
      const { url } = await serve((_seen, response) => {
        json(response, 200, verifiedBody);
      });
      const { verifier } = adapter(url);
      const budget = new ExecutionBudget(clock, 'request', 5_000);

      const verdict = await runWithBudget(budget, () => verifier.verify(evidence));

      expect(verdict.verdict).toBe('VERIFIED');
      expect(budget.lateEffects).toEqual([]);
      budget.finish();
    });
  });
});
