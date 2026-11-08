import type { ClientRequest, IncomingMessage } from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';

/** `https.request`, as a parameter so that the probe can be tried without a certificate (none is ever made by a test). */
export type HttpsRequest = (
  options: RequestOptions,
  callback: (response: IncomingMessage) => void,
) => ClientRequest;

/**
 * Asks the HTTPS origin for its root page and says what it answered, trusting **the disposable test CA and nothing else**
 * (S0.23; the review of 12 October 2026, F03). It is made by a client that is not a browser, in the same test as the browser's
 * refusal, so that the refusal is attributable to trust alone: the endpoint is up, it answers, and its leaf validates against the CA
 * for the name the browser used. A refusal by a browser that has not been given the CA, beside this answer, can only be that
 * browser's verdict on the certificate. The CA is public, and nothing here prints or keeps it.
 *
 * A name that does not resolve, a connection refused, a handshake that fails and a deadline all reject, with the reason: they are not
 * an answer.
 */
export function originAnswers(
  origin: string,
  ca: Buffer,
  options: { readonly request?: HttpsRequest; readonly timeoutMs?: number } = {},
): Promise<number> {
  const url = new URL(origin);
  if (url.protocol !== 'https:') throw new TypeError('The probe asks an https origin');
  const request = options.request ?? httpsRequest;
  const timeoutMs = options.timeoutMs ?? 10_000;
  return new Promise<number>((resolve, reject) => {
    const outgoing = request(
      {
        host: url.hostname,
        port: Number(url.port),
        servername: url.hostname,
        path: '/',
        method: 'GET',
        ca,
        minVersion: 'TLSv1.2',
        timeout: timeoutMs,
      },
      (response) => {
        // The body is read off and dropped: the probe is about the handshake and the status, not the page.
        response.resume();
        response.once('end', () => {
          resolve(response.statusCode ?? 0);
        });
      },
    );
    outgoing.once('timeout', () => {
      outgoing.destroy(new Error(`the origin did not answer within ${String(timeoutMs)} ms`));
    });
    outgoing.once('error', reject);
    outgoing.end();
  });
}
