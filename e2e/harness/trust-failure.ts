import type { Engine } from './engine-trust.ts';

/**
 * What a navigation failure says about trust (S0.23; the review of 12 October 2026, F03). The negative half of the spike opens the
 * HTTPS origin in a browser of the engine that has **not** been given the test CA and expects it to refuse. A refusal proves the
 * point only if it is the engine's rejection of the certificate: a timeout, a name that did not resolve, a connection that was
 * refused, a request the harness blocked, a crash and a page or context closed under the test all fail a navigation too, and none
 * of them says anything about trust. So the failure is classified, and only the engine's own certificate diagnostic counts.
 *
 * The signatures are the engine's, by engine (and, for WebKit, by the platform it runs on, because it uses the platform's TLS
 * library). They are the diagnostics the pinned builds carry and the ones Playwright's own suite expects for a certificate the
 * browser does not trust; the pinned builds on this machine were searched for them (`SEC_ERROR_UNKNOWN_ISSUER`,
 * `SSL_ERROR_UNKNOWN_CA_ALERT`, the Windows WebKit's libcurl message and Chromium's `CERT_AUTHORITY_INVALID`). **They are the first
 * run's to confirm on Linux**, and a failure with another signature is not guessed at: it is `NOT_A_CERTIFICATE_FAILURE`, the test
 * fails, and the message goes to whoever diagnoses it. Widening this list is a reviewed change made on seeing a real diagnostic, never
 * to turn a red run green.
 */
export type NavigationFailureKind = 'CERTIFICATE_REJECTED' | 'NOT_A_CERTIFICATE_FAILURE';

/** What an untrusted issuer looks like to each engine. */
const CERTIFICATE_SIGNATURES: Readonly<
  Record<Engine, (platform: NodeJS.Platform) => readonly RegExp[]>
> = {
  chromium: () => [/\bnet::ERR_CERT_AUTHORITY_INVALID\b/],
  firefox: () => [/\bSEC_ERROR_UNKNOWN_ISSUER\b/, /\bSSL_ERROR_UNKNOWN_CA_ALERT\b/],
  webkit: (platform) => {
    switch (platform) {
      case 'linux':
        return [/\bUnacceptable TLS certificate\b/];
      case 'darwin':
        return [/\bThe certificate for this server is invalid\b/];
      case 'win32':
        return [/\bSSL peer certificate or SSH remote key was not OK\b/];
      default:
        return [];
    }
  },
};

/**
 * Failures that are not a verdict on a certificate, whatever else the message says: a deadline, a name or a connection that did not
 * work, a request the harness blocked, a crash, a target closed under the test. A message that carries one of these is never read
 * as a certificate rejection, even if it also names a certificate error.
 */
const NOT_A_VERDICT: readonly RegExp[] = [
  /\bTimeout \d+ms exceeded\b/i,
  /\btimed out\b/i,
  /\bhas been closed\b/i,
  /\bTarget (?:page|closed|crashed)\b/i,
  /\b(?:page|browser|renderer) crashed\b/i,
  /\bERR_NAME_NOT_RESOLVED\b/,
  /\bERR_CONNECTION_\w+/,
  /\bERR_INTERNET_DISCONNECTED\b/,
  /\bERR_BLOCKED_BY_CLIENT\b/,
  /\bERR_ABORTED\b/,
  /\bNS_ERROR_(?:CONNECTION_REFUSED|UNKNOWN_HOST|NET_TIMEOUT|NET_RESET|NET_INTERRUPT)\b/,
  /\bNS_BINDING_ABORTED\b/,
  /\bCould not connect to server\b/i,
  /\bCouldn.t connect\b/i,
  /\bblocked by the harness\b/i,
];

export function classifyNavigationFailure(
  engine: Engine,
  message: string,
  platform: NodeJS.Platform = process.platform,
): NavigationFailureKind {
  if (NOT_A_VERDICT.some((pattern) => pattern.test(message))) return 'NOT_A_CERTIFICATE_FAILURE';
  return CERTIFICATE_SIGNATURES[engine](platform).some((pattern) => pattern.test(message))
    ? 'CERTIFICATE_REJECTED'
    : 'NOT_A_CERTIFICATE_FAILURE';
}
