import type { ContentScanner, ScanVerdict } from '../auth/ports/content-scanner.port.js';
import { ContentScannerError } from './content-scanner-error.js';

/**
 * The content scanner of an environment that has been given none (Run A2; D-A6): **production started without `EVIDENCE_SCANNER`**. The application still starts (a deployment that has not yet
 * got its scanner is not a deployment that cannot run), and every completion of evidence is refused with `SCANNER_NOT_CONFIGURED` until one is configured: a record is never stored
 * unscanned, so nothing is stored. Going live then needs only the scanner's address in configuration.
 *
 * It is not a stand-in: it looks at nothing and answers nothing, so there is nothing for production to refuse in it.
 */
export class UnconfiguredContentScanner implements ContentScanner {
  scan(): Promise<ScanVerdict> {
    return Promise.reject(
      new ContentScannerError(
        'SCANNER_NOT_CONFIGURED',
        'No content scanner is configured, so no evidence can be stored',
      ),
    );
  }
}
