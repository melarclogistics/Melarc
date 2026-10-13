import { describe, expect, it } from 'vitest';

import { classifyNavigationFailure } from './trust-failure.ts';

/**
 * The classifier of the negative half of the trust spike (the review of 12 October 2026, F03), with its controls: only an engine's own
 * certificate diagnostic is a certificate rejection, and every other way a navigation fails, which says nothing about trust, is not.
 */
describe('classifyNavigationFailure: what counts as an engine refusing the certificate', () => {
  // Break caught: a diagnostic the engine gives for an untrusted issuer not recognised, which would fail the negative test on a run
  // that proved exactly what it should.
  it.each([
    ['chromium', 'linux', 'page.goto: net::ERR_CERT_AUTHORITY_INVALID at https://localhost:8443/'],
    ['firefox', 'linux', 'page.goto: SEC_ERROR_UNKNOWN_ISSUER'],
    ['firefox', 'linux', 'page.goto: SSL_ERROR_UNKNOWN_CA_ALERT'],
    ['webkit', 'linux', 'page.goto: Unacceptable TLS certificate'],
    ['webkit', 'darwin', 'page.goto: The certificate for this server is invalid. You might be'],
    ['webkit', 'win32', 'page.goto: SSL peer certificate or SSH remote key was not OK'],
  ] as const)('%s on %s: %s is a certificate rejection', (engine, platform, message) => {
    expect(classifyNavigationFailure(engine, message, platform)).toBe('CERTIFICATE_REJECTED');
  });

  // Break caught (F03): any navigation failure accepted as trust evidence. A timeout, a name that did not resolve, a refused
  // connection, a request the harness blocked, a crash and a closed page, context or browser are each a failed navigation and none is
  // the certificate being rejected.
  it.each([
    ['a timeout', 'page.goto: Timeout 30000ms exceeded.'],
    [
      'a name that did not resolve',
      'page.goto: net::ERR_NAME_NOT_RESOLVED at https://localhost:8443/',
    ],
    ['a refused connection', 'page.goto: net::ERR_CONNECTION_REFUSED at https://localhost:8443/'],
    ['a reset connection', 'page.goto: net::ERR_CONNECTION_RESET at https://localhost:8443/'],
    ['no network', 'page.goto: net::ERR_INTERNET_DISCONNECTED'],
    [
      'a request the harness blocked',
      'page.goto: net::ERR_BLOCKED_BY_CLIENT at https://localhost:8443/',
    ],
    ['an aborted navigation', 'page.goto: net::ERR_ABORTED at https://localhost:8443/'],
    ['a page closed under the test', 'page.goto: Target page, context or browser has been closed'],
    ['a browser closed under the test', 'browser has been closed'],
    ['a crash', 'page.goto: Page crashed'],
    ['Firefox refusing the connection', 'page.goto: NS_ERROR_CONNECTION_REFUSED'],
    ['Firefox failing to resolve the name', 'page.goto: NS_ERROR_UNKNOWN_HOST'],
    ['WebKit unable to connect', 'page.goto: Could not connect to server'],
    ['nothing at all', ''],
    ['text that names no diagnostic', 'something went wrong'],
  ])('%s is not a certificate rejection', (_label, message) => {
    for (const engine of ['chromium', 'firefox', 'webkit'] as const) {
      expect(classifyNavigationFailure(engine, message, 'linux')).toBe('NOT_A_CERTIFICATE_FAILURE');
    }
  });

  // Break caught: a message that carries a certificate diagnostic and also says the deadline passed or the target closed, read as the
  // certificate being rejected: the failure is not a verdict then, whatever else it names.
  it.each([
    ['chromium', 'page.goto: Timeout 30000ms exceeded. net::ERR_CERT_AUTHORITY_INVALID'],
    ['firefox', 'Target page, context or browser has been closed SEC_ERROR_UNKNOWN_ISSUER'],
    ['webkit', 'Page crashed: Unacceptable TLS certificate'],
  ] as const)(
    '%s: a certificate diagnostic beside a deadline or a closed target is not a verdict',
    (engine, message) => {
      expect(classifyNavigationFailure(engine, message, 'linux')).toBe('NOT_A_CERTIFICATE_FAILURE');
    },
  );

  // Break caught: one engine's diagnostic accepted for another, which would let a mislabelled run, or a project that launched a
  // different browser than it says, pass.
  it('takes an engine’s own diagnostic only, and WebKit’s by the platform it runs on', () => {
    expect(classifyNavigationFailure('firefox', 'net::ERR_CERT_AUTHORITY_INVALID', 'linux')).toBe(
      'NOT_A_CERTIFICATE_FAILURE',
    );
    expect(classifyNavigationFailure('chromium', 'SEC_ERROR_UNKNOWN_ISSUER', 'linux')).toBe(
      'NOT_A_CERTIFICATE_FAILURE',
    );
    expect(classifyNavigationFailure('webkit', 'net::ERR_CERT_AUTHORITY_INVALID', 'linux')).toBe(
      'NOT_A_CERTIFICATE_FAILURE',
    );
    // The Linux message is not WebKit's on Windows, and the Windows one is not Linux's.
    expect(classifyNavigationFailure('webkit', 'Unacceptable TLS certificate', 'win32')).toBe(
      'NOT_A_CERTIFICATE_FAILURE',
    );
    expect(
      classifyNavigationFailure(
        'webkit',
        'SSL peer certificate or SSH remote key was not OK',
        'linux',
      ),
    ).toBe('NOT_A_CERTIFICATE_FAILURE');
    // A platform with no known diagnostic accepts none.
    expect(classifyNavigationFailure('webkit', 'Unacceptable TLS certificate', 'freebsd')).toBe(
      'NOT_A_CERTIFICATE_FAILURE',
    );
  });
});
