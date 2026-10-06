import { expect, test } from '../harness/playwright.ts';

test.describe('the sandbox, in the real API process', () => {
  // Break caught: code in the API reaching an external provider during a test. The API runs under the outbound
  // guard: the attempt fails inside the API, the caller is told it was refused, and the attempt is captured,
  // so a test can assert on an external effect the code tried to have.
  test('refuses an outbound call made by the API, and captures the attempt', async ({
    request,
    stack,
    sandbox,
  }) => {
    const response = await request.post(`${stack.origin}/api/v1/e2e/outbound`);

    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ reached: false, code: 'EHARNESSBLOCKED' });
    expect(sandbox.outboundAttempts()).toEqual([
      expect.objectContaining({
        kind: 'blocked-connection',
        host: 'payments.provider.example',
        port: 443,
      }),
    ]);
  });
});
