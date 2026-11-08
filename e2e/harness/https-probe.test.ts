import { EventEmitter } from 'node:events';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { originAnswers, type HttpsRequest } from './https-probe.ts';

/**
 * The probe that shows the HTTPS origin is up and its leaf validates against the disposable CA (the review of 12 October 2026, F03),
 * tried without a certificate: no test makes one. What these show is what the probe asks, trusting what, and how it reports what it
 * got; that a real leaf validates is what the first run in a clean environment shows.
 */
const CA = Buffer.from('not a real certificate: the fake request reads no certificate');

interface Fake {
  readonly request: HttpsRequest;
  readonly asked: RequestOptions[];
}

function fake(behaviour: 'answer' | 'error' | 'silence', status = 200): Fake {
  const asked: RequestOptions[] = [];
  const request: HttpsRequest = (options, callback) => {
    asked.push(options);
    const outgoing = new EventEmitter() as EventEmitter & {
      end: () => void;
      destroy: (error?: Error) => void;
    };
    outgoing.destroy = (error) => {
      if (error !== undefined) queueMicrotask(() => outgoing.emit('error', error));
    };
    outgoing.end = () => {
      queueMicrotask(() => {
        if (behaviour === 'error') {
          outgoing.emit('error', new Error('self-signed certificate in certificate chain'));
        } else if (behaviour === 'silence') {
          outgoing.emit('timeout');
        } else {
          const response = Object.assign(new PassThrough(), { statusCode: status });
          callback(response as unknown as IncomingMessage);
          response.end('<html></html>');
        }
      });
    };
    return outgoing as unknown as ClientRequest;
  };
  return { request, asked };
}

describe('originAnswers', () => {
  // Break caught: the probe trusting the machine's store, or anything, instead of the one CA: it would then show the endpoint is up and
  // say nothing of whether the CA validates it.
  it('asks the origin for its root page, naming the host, trusting the CA given and nothing else', async () => {
    const { request, asked } = fake('answer');

    const status = await originAnswers('https://localhost:8443', CA, { request });

    expect(status).toBe(200);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      host: 'localhost',
      port: 8443,
      servername: 'localhost',
      path: '/',
      method: 'GET',
      minVersion: 'TLSv1.2',
    });
    expect(asked[0]?.ca).toBe(CA);
    expect(asked[0]).not.toHaveProperty('rejectUnauthorized');
  });

  // Break caught: a status other than 200 reported as an answer of 200, or any answer taken as the endpoint being fit for the proof.
  it('reports the status the origin answered', async () => {
    expect(
      await originAnswers('https://localhost:8443', CA, { request: fake('answer', 502).request }),
    ).toBe(502);
  });

  // Break caught: a failed handshake or a connection that did not work reported as an answer.
  it('rejects with the reason when the handshake fails', async () => {
    await expect(
      originAnswers('https://localhost:8443', CA, { request: fake('error').request }),
    ).rejects.toThrow(/self-signed certificate/);
  });

  // Break caught: an origin that never answers waited for until the test's own deadline, so that the report says nothing of why.
  it('rejects when the origin does not answer in time', async () => {
    await expect(
      originAnswers('https://localhost:8443', CA, {
        request: fake('silence').request,
        timeoutMs: 25,
      }),
    ).rejects.toThrow(/did not answer within 25 ms/);
  });

  // Break caught: the probe asking a plain-HTTP origin, which proves nothing about a certificate.
  it('refuses an origin that is not https', () => {
    expect(() =>
      originAnswers('http://localhost:8080', CA, { request: fake('answer').request }),
    ).toThrow(TypeError);
  });
});
