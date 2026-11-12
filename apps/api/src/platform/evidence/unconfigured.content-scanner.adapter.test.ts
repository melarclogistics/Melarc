import { describe, expect, it } from 'vitest';

import { ContentScannerError } from './content-scanner-error.js';
import { UnconfiguredContentScanner } from './unconfigured.content-scanner.adapter.js';

/**
 * The scanner of a production that has been given none (Run A2; D-A6): the application starts, and every scan is refused with the declared condition. It is the reason a record is
 * never stored unscanned: this adapter cannot answer "clean", whatever it is handed.
 */
async function* object(): AsyncGenerator<Uint8Array> {
  await Promise.resolve();
  yield Buffer.from('a perfectly good photograph');
}

describe('the scanner of an environment that has none', () => {
  // Break caught: an unconfigured scanner that answers (clean or otherwise), or that raises something the platform reads as a defect instead of the declared condition.
  it('refuses every scan with SCANNER_NOT_CONFIGURED, whatever it is handed', async () => {
    const scanner = new UnconfiguredContentScanner();
    const error = await scanner.scan().then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ContentScannerError);
    expect(error).toMatchObject({ code: 'SCANNER_NOT_CONFIGURED' });
    // Handed an object, it still does not read it: nothing is consumed from a stream it will not judge.
    let pulled = false;
    async function* watched(): AsyncGenerator<Uint8Array> {
      pulled = true;
      await Promise.resolve();
      yield Buffer.from('x');
    }
    await expect(
      (scanner.scan as unknown as (o: AsyncIterable<Uint8Array>) => Promise<unknown>)(watched()),
    ).rejects.toMatchObject({ code: 'SCANNER_NOT_CONFIGURED' });
    expect(pulled).toBe(false);
    await expect(
      (scanner.scan as unknown as (o: AsyncIterable<Uint8Array>) => Promise<unknown>)(object()),
    ).rejects.toBeInstanceOf(ContentScannerError);
  });

  it('says what is missing and nothing else', async () => {
    const error = await new UnconfiguredContentScanner().scan().then(
      () => undefined,
      (caught: unknown) => caught as Error,
    );
    expect(error?.message).toBe('No content scanner is configured, so no evidence can be stored');
  });
});
