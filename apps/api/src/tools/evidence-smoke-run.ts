import { createHash, randomBytes } from 'node:crypto';

import type { ContentScanner } from '../platform/auth/ports/content-scanner.port.js';
import type {
  EvidenceStore,
  ObjectCapability,
} from '../platform/auth/ports/evidence-store.port.js';
import { ContentScannerError } from '../platform/evidence/content-scanner-error.js';
import { EICAR_TEST_FILE } from '../platform/evidence/eicar-test-file.js';
import { ENCRYPTED_PDF_TEST_FILE } from '../platform/evidence/encrypted-pdf-test-file.js';
import { judgeStoredObject } from '../platform/evidence/evidence-judgement.js';
import { EvidenceStoreError } from '../platform/evidence/evidence-store-error.js';

/**
 * The logic of `pnpm --filter @melarc/api run evidence:smoke` (Run A2; the Product Owner's decision D-A6, the plan's section 7.5): the owner's first contact with a bucket and a scanner,
 * as a command they run and read. It composes the **same store and the same scanner the API is composed with** (`EVIDENCE_STORE`, `EVIDENCE_SCANNER`, read from `apps/api/.env` as the API
 * reads them), and puts through the platform's own judgement of a stored object (`judgeStoredObject`, the one function `completeEvidenceUpload` calls to decide whether a record may be
 * stored) four things:
 *
 * 1. **A clean JPEG** (a JFIF header of a few bytes): uploaded to the bucket with the capability the platform makes, then judged. Expected: ACCEPTED, with the scanner's name and the
 *    version of its signatures.
 * 2. **The EICAR test file** (68 harmless characters every scanner treats as a virus): uploaded the same way. Expected: REFUSED as malicious content, and its object gone from the bucket.
 * 3. **An encrypted PDF** (a small document with a security handler nobody can open; Run B, item 3 of the review of Run A2): uploaded the same way. Expected: REFUSED as malicious content.
 *    ClamAV does not look into an encrypted document unless `AlertEncrypted yes` is set, and with its default it says `stream: OK` for a file it did not read; the command fails, **naming
 *    the setting**, when the scanner does not flag it.
 * 4. **An upload that is not the one signed**, twice: a body longer than the length signed into the address, and a body of the right length that hashes otherwise. Expected: the store
 *    itself refuses each, and nothing is stored (the plan's section 7.5, item 2).
 *
 * It also says whether the store kept the SHA-256 that was signed (a `HEAD` must return it: the platform reads it back).
 *
 * **It is not run against production** (`APP_ENV=production` is refused, exit 2, and nothing is made): it makes objects in the bucket it is given. **It removes what it made, in a
 * `finally`, whatever happened**, the scanner being out of reach included; what it could not remove is told by one fixed word, `NOT_REMOVED`, with a count and no key.
 *
 * **What it prints.** The mode, which store and which scanner (by kind, never by address), and one line for each check with the status the store gave. **It never prints a credential, a
 * signed address, an object key, a host or the text of an answer**: every object it makes has a random key it does not show. Exit status: 0 when every check came out as expected; 1 when
 * one did not (the line says which) or when the store or the scanner could not decide; 2 when the settings are wrong, or the environment is production, and nothing was done.
 */
export interface SmokeWorld {
  /** `REAL` only when the store is R2 and the scanner is ClamAV; anything with a stand-in in it is a dry run, and says so. */
  readonly mode: 'REAL' | 'DRY RUN';
  readonly storeKind: string;
  readonly scannerKind: string;
  readonly store: EvidenceStore;
  readonly scanner: ContentScanner;
  /** The call a handset makes with the capability it was given, answered with the status the store gave. */
  readonly upload: (capability: ObjectCapability, body: Uint8Array) => Promise<number>;
}

export interface EvidenceSmokeIo {
  readonly out: (line: string) => void;
  readonly now: () => Date;
  /** The world the environment describes, or what is wrong with the settings (key names only). */
  readonly compose: (env: Readonly<Record<string, string | undefined>>) => SmokeWorld | string[];
}

/** A JFIF header and an end marker: a few bytes that are a JPEG by their signature and carry nothing a scanner could mind. */
const CLEAN_JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');
const EICAR = Buffer.from(EICAR_TEST_FILE, 'latin1');
const ENCRYPTED_PDF = Buffer.from(ENCRYPTED_PDF_TEST_FILE, 'latin1');

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const accepted = (status: number): boolean => status >= 200 && status < 300;

export async function runEvidenceSmoke(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  io: EvidenceSmokeIo,
): Promise<number> {
  if (argv.some((word) => word !== '--')) {
    io.out('usage: evidence:smoke (no options; the settings are those of apps/api/.env)');
    return 2;
  }
  // It makes objects in the bucket it is given and removes them: that is for a bucket and a scanner that are not production's.
  if (env.APP_ENV === 'production') {
    io.out(
      'APP_ENV is production, and nothing was done: the smoke command makes objects in the bucket it is given and removes them. Run it with the settings of a non-production bucket and scanner.',
    );
    return 2;
  }
  const world = io.compose(env);
  if (Array.isArray(world)) {
    io.out(
      'The settings are refused, and nothing was done. Fix these (the keys are in apps/api/.env):',
    );
    for (const problem of world) io.out(`  ${problem}`);
    return 2;
  }
  io.out(
    world.mode === 'REAL'
      ? 'Mode: REAL. The bucket and the scanner below are the ones the API is configured with.'
      : 'Mode: DRY RUN. The store or the scanner is the in-process stand-in: nothing here proves a bucket or a daemon.',
  );
  io.out(`Store: ${world.storeKind}. Scanner: ${world.scannerKind}.`);

  let failed = false;
  const check = (ok: boolean, line: string): void => {
    io.out(`${ok ? 'OK  ' : 'FAIL'} ${line}`);
    if (!ok) failed = true;
  };
  // Every object the command makes, so that it can be removed in the end whatever happened on the way.
  const made = new Set<string>();
  const key = (): string => {
    const storageRef = `ev/${randomBytes(16).toString('hex')}`;
    made.add(storageRef);
    return storageRef;
  };

  try {
    // 1, 2 and 3: a clean file, the test virus and an encrypted document, through the platform's own judgement.
    for (const file of [
      {
        label: 'A clean JPEG',
        bytes: CLEAN_JPEG,
        contentType: 'image/jpeg',
        expected: 'accepted' as const,
        setting: undefined,
      },
      {
        label: 'The EICAR test file',
        bytes: EICAR,
        contentType: 'image/jpeg',
        expected: 'refused' as const,
        setting: undefined,
      },
      {
        label: 'An encrypted PDF',
        bytes: ENCRYPTED_PDF,
        contentType: 'application/pdf',
        expected: 'refused' as const,
        // ClamAV looks into no encrypted document unless it is told to alert on one, and then answers `stream: OK` for a file it did not read.
        setting:
          'The daemon does not look into an encrypted document unless AlertEncrypted is yes in clamd.conf (restart it after the change).',
      },
    ]) {
      const storageRef = key();
      const checksumSha256 = sha(file.bytes);
      const capability = world.store.presignUpload({
        key: storageRef,
        contentType: file.contentType,
        byteSize: file.bytes.length,
        checksumSha256,
        issuedAt: io.now(),
        ttlSeconds: 300,
      });
      const status = await world.upload(capability, file.bytes);
      check(
        accepted(status),
        `${file.label} (${String(file.bytes.length)} bytes): the upload was ${accepted(status) ? 'accepted' : 'REFUSED'} by the store (status ${String(status)}).`,
      );
      if (!accepted(status)) continue;
      const facts = await world.store.inspect(storageRef, 8);
      check(
        facts?.checksumSha256 === checksumSha256,
        `${file.label}: HEAD ${facts?.checksumSha256 === checksumSha256 ? 'returned' : 'did NOT return'} the SHA-256 that was signed (x-amz-checksum-sha256).`,
      );
      const judged = await judgeStoredObject(
        {
          store: world.store,
          scanner: world.scanner,
          // The smoke command counts nothing: the judgement is given a meter that keeps no reading, so the owner's run leaves no trace in a metric.
          metrics: { increment: () => undefined, observe: () => undefined },
        },
        {
          storageRef,
          contentType: file.contentType,
          byteSize: file.bytes.length,
          checksumSha256,
        },
      );
      if (file.expected === 'accepted') {
        check(
          judged.accepted,
          judged.accepted
            ? `${file.label}: the platform's check ACCEPTED it, scanned clean by ${judged.verdict.scanner} (${judged.verdict.signatureVersion}).`
            : `${file.label}: the platform's check REFUSED it (${judged.rule}); it should have been accepted.`,
        );
      } else {
        const refusedAsMalicious = !judged.accepted && judged.rule === 'malicious_content';
        const hint = file.setting === undefined ? '' : ` ${file.setting}`;
        check(
          refusedAsMalicious,
          refusedAsMalicious
            ? `${file.label}: the platform's check REFUSED it as malicious content.`
            : judged.accepted
              ? `${file.label}: the platform's check ACCEPTED it; the scanner did not flag it.${hint}`
              : // The scan comes after what the store says of the object and before the file signature: a rule other than malicious content means the scanner either was not asked
                // (the store's facts failed first) or did not flag the file (the signature then refused it, as it would a text file declared as a JPEG).
                `${file.label}: the platform's check refused it for another reason (${judged.rule}), not as malicious content: the scanner did not flag it, or was not asked.${hint}`,
        );
        const gone = (await world.store.inspect(storageRef, 8)) === undefined;
        check(
          gone,
          `${file.label}: its object ${gone ? 'was removed from the store' : 'is STILL in the store'}.`,
        );
      }
    }

    // 4: the store must refuse an upload that is not the one signed.
    const signed = key();
    const capability = world.store.presignUpload({
      key: signed,
      contentType: 'image/jpeg',
      byteSize: CLEAN_JPEG.length,
      checksumSha256: sha(CLEAN_JPEG),
      issuedAt: io.now(),
      ttlSeconds: 300,
    });
    const longer = Buffer.concat([CLEAN_JPEG, Buffer.from([0])]);
    const otherHash = Buffer.from(CLEAN_JPEG);
    otherHash[otherHash.length - 3] = (otherHash[otherHash.length - 3] ?? 0) ^ 0xff;
    for (const attempt of [
      { label: 'An upload longer than the length signed', body: longer },
      { label: 'An upload of the signed length that hashes otherwise', body: otherHash },
    ]) {
      const status = await world.upload(capability, attempt.body);
      check(
        !accepted(status),
        `${attempt.label}: the store ${accepted(status) ? 'ACCEPTED it (status ' + String(status) + '), and the platform then rests on its own hashing of the stream' : 'refused it (status ' + String(status) + ')'}.`,
      );
    }
    const left = await world.store.inspect(signed, 8);
    check(
      left === undefined,
      `Nothing was stored by the uploads that were not the one signed${left === undefined ? '' : ' (an object IS there)'}.`,
    );
  } catch (error) {
    failed = true;
    if (error instanceof ContentScannerError) {
      io.out(
        `FAIL The scanner could not decide (${error.code}); nothing was judged. Is the daemon running and reachable from here?`,
      );
    } else if (error instanceof EvidenceStoreError) {
      io.out(
        `FAIL The store could not answer (${error.code}); nothing was judged. Are the account, the bucket and the key right?`,
      );
    } else {
      io.out(
        'FAIL The command stopped on an error it did not expect; no detail is printed because it may name an address.',
      );
    }
  } finally {
    // Everything the command made is removed, whatever happened above (the scanner out of reach included). An object that is already gone is no failure; one that cannot be removed is
    // told by a fixed word and a count, never by its key.
    let notRemoved = 0;
    for (const storageRef of made) {
      try {
        await world.store.remove(storageRef);
      } catch {
        notRemoved += 1;
      }
    }
    if (notRemoved > 0) {
      failed = true;
      io.out(
        `FAIL NOT_REMOVED: ${String(notRemoved)} object(s) the command made could not be removed from the bucket. Remove them by hand, or let the bucket's lifecycle rule take them.`,
      );
    }
  }
  io.out(
    failed
      ? 'RESULT: at least one check did not come out as expected.'
      : 'RESULT: every check came out as expected.',
  );
  return failed ? 1 : 0;
}
