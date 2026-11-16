import { ApiError } from '@melarc/api-client/browser';
import { describe, expect, it, vi } from 'vitest';

import {
  CHECKSUM_UNAVAILABLE,
  FILE_EMPTY,
  FILE_TYPE_NOT_TAKEN,
  STORE_BLOCKED,
  STORE_DECLINED,
  STORE_UNREACHABLE,
  UPLOAD_ADDRESS_RAN_OUT,
  UPLOAD_TIMED_OUT,
  fileTooLarge,
} from '../problem/hub-intake-copy';
import { cannotText } from '../problem/capability-words';
import { ChecksumUnavailableError } from './file-checksum';
import { ObjectStoreError } from './object-store-upload';
import {
  EvidenceRefusedError,
  UploadAddressExpiredError,
  UploadTimeoutError,
  type EvidenceUploader,
} from './upload-evidence';
import {
  UPLOAD_STEP_WORDS,
  UploadFailure,
  evidenceFailureWords,
  uploadWithSteps,
} from './evidence-failure-words';

/**
 * What a file that could not be stored says, in the one table's words: a store that declined it, one that could not be reached and **one the browser's own policy blocked** (told apart on purpose: a policy
 * does not allow the bucket, and "check the connection" would send the officer back to a button that can never work), a step that ran out of time, an upload address that had run out twice, a file the
 * platform's limits refuse, and a refusal of the platform worded **by the use that was made of the photo** (the receiver's, or the senior's decision: the capability a refusal names is the act's own).
 * Never an address, a key, a status or the platform's own text.
 */
const refused = (code: string, status: number): ApiError =>
  new ApiError({ kind: 'http', status, code });
const failed = (step: ConstructorParameters<typeof UploadFailure>[0], reason: unknown) =>
  new UploadFailure(step, reason);

describe('the words of a file that could not be stored', () => {
  it.each([
    [
      'a store that declined the file',
      failed('sending', new ObjectStoreError('refused', 403)),
      STORE_DECLINED,
    ],
    [
      'a store that could not be reached',
      failed('sending', new ObjectStoreError('unreachable')),
      STORE_UNREACHABLE,
    ],
    [
      'a store the browser blocked',
      failed('sending', new ObjectStoreError('blocked')),
      STORE_BLOCKED,
    ],
    [
      'a browser that cannot check a file',
      failed('hashing', new ChecksumUnavailableError()),
      CHECKSUM_UNAVAILABLE,
    ],
    ['an empty file', failed('empty', undefined), FILE_EMPTY],
    [
      'a step that ran out of time',
      failed('sending', new UploadTimeoutError('sending')),
      UPLOAD_TIMED_OUT,
    ],
    [
      'an upload address that ran out twice',
      failed('declaring', new UploadAddressExpiredError()),
      UPLOAD_ADDRESS_RAN_OUT,
    ],
    [
      'a file of a type the platform does not take',
      failed('hashing', new EvidenceRefusedError({ kind: 'type_not_allowed', type: 'text/plain' })),
      FILE_TYPE_NOT_TAKEN,
    ],
    ['a failure that is not one of these', new Error('boom'), STORE_UNREACHABLE],
  ])('are the table’s for %s', (_name, error, words) => {
    expect(evidenceFailureWords(error)).toBe(words);
  });

  // Break caught: a policy that does not allow the bucket told as a lost connection (or the other way round), which sends an officer to retry a button that cannot help, or to tell the portal's keeper about a tablet's signal.
  it('tells a store the browser blocked apart from one that could not be reached, and neither as the other', () => {
    const blocked = evidenceFailureWords(failed('sending', new ObjectStoreError('blocked')));
    const lost = evidenceFailureWords(failed('sending', new ObjectStoreError('unreachable')));

    expect(blocked).not.toBe(lost);
    expect(blocked).toMatch(/blocked/i);
    expect(blocked).not.toMatch(/connection/i);
    expect(lost).toMatch(/connection/i);
    expect(lost).not.toMatch(/blocked/i);
  });

  // Break caught: a limit told without the number (the officer cannot know what "too large" means), or in bytes.
  it('words a file above the limit by the limit, in megabytes', () => {
    const words = evidenceFailureWords(
      failed(
        'hashing',
        new EvidenceRefusedError({ kind: 'too_large', size: 12_000_000, limit: 10_485_760 }),
      ),
    );

    expect(words).toBe(fileTooLarge(10_485_760));
    expect(words).toContain('10 MB');
    expect(words).not.toMatch(/10485760|12000000/);
  });

  it('words a limit that is not whole megabytes with one decimal and no more', () => {
    expect(fileTooLarge(1_572_864)).toContain('1.5 MB');
    expect(fileTooLarge(5_242_880)).toContain('5 MB');
  });

  // Break caught: a refusal that names the receiver's capability when the photo was made for the senior's decision (an officer asked to ask for the wrong access), or one that names a key.
  it('words a refusal of the platform by the use that was made of the photo', () => {
    const denied = failed('declaring', refused('PERMISSION_DENIED', 403));

    expect(evidenceFailureWords(denied, 'count')).toBe(cannotText('hub.intake.count'));
    expect(evidenceFailureWords(denied, 'decision')).toBe(cannotText('hub.osd.adjudicate'));
    // The use is the receiver's unless it is said to be the decision's.
    expect(evidenceFailureWords(denied)).toBe(cannotText('hub.intake.count'));
    for (const use of ['count', 'decision'] as const) {
      expect(evidenceFailureWords(denied, use)).not.toMatch(/\bhub\.[a-z.]+/);
    }
  });

  it('words the other refusals of the platform the same for both uses', () => {
    const invalid = failed('declaring', refused('VALIDATION_FAILED', 400));
    expect(evidenceFailureWords(invalid, 'decision')).toBe(evidenceFailureWords(invalid, 'count'));
    const unconfirmed = failed('confirming', refused('EVIDENCE_UPLOAD_EXPIRED', 422));
    expect(evidenceFailureWords(unconfirmed, 'decision')).toMatch(/ran out/);
  });

  // Break caught: the platform's own text, an address, a key or a status reaching the screen.
  it('never carries an address, a key, a status or the platform’s text', () => {
    const outcomes = [
      failed('sending', new ObjectStoreError('refused', 403)),
      failed('sending', new ObjectStoreError('blocked')),
      failed('sending', new UploadTimeoutError('sending')),
      failed('declaring', new UploadAddressExpiredError()),
      failed('declaring', refused('PERMISSION_DENIED', 403)),
      failed('confirming', refused('VALIDATION_FAILED', 400)),
    ];
    for (const outcome of outcomes) {
      for (const use of ['count', 'decision'] as const) {
        expect(evidenceFailureWords(outcome, use)).not.toMatch(
          /https?:|sig=|\bev\/|\b[45]\d\d\b|Diagnostic/,
        );
      }
    }
  });
});

describe('the steps of a file’s trip, in words', () => {
  it('has words for every step, and each says what is being done', () => {
    expect(Object.keys(UPLOAD_STEP_WORDS).toSorted()).toEqual(
      ['confirming', 'declaring', 'hashing', 'sending'].toSorted(),
    );
    for (const words of Object.values(UPLOAD_STEP_WORDS)) expect(words).toMatch(/…$/);
  });
});

describe('uploadWithSteps', () => {
  const file = (bytes = 3) => new File([new Uint8Array(bytes)], 'door.jpg', { type: 'image/jpeg' });

  // Break caught: an empty file sent to the platform (it is refused there, a round trip later, in the platform's words).
  it('refuses an empty file before anything is done, as the file’s own failure', async () => {
    const store = vi.fn<EvidenceUploader>();
    const report = vi.fn();

    const failure: unknown = await uploadWithSteps(
      store,
      file(0),
      report,
      new AbortController().signal,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(UploadFailure);
    expect(failure).toMatchObject({ step: 'empty' });
    expect(store).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
  });

  it('tells each step in words as the file moves, and answers with the stored record', async () => {
    const told: string[] = [];
    const store: EvidenceUploader = (_file, steps) => {
      for (const step of ['hashing', 'declaring', 'sending', 'confirming'] as const) steps?.(step);
      return Promise.resolve('record-1');
    };

    const stored = await uploadWithSteps(
      store,
      file(),
      (words) => told.push(words),
      new AbortController().signal,
    );

    expect(stored).toBe('record-1');
    expect(told).toEqual([
      UPLOAD_STEP_WORDS.hashing,
      UPLOAD_STEP_WORDS.declaring,
      UPLOAD_STEP_WORDS.sending,
      UPLOAD_STEP_WORDS.confirming,
    ]);
  });

  // Break caught: a failure worded by the first step when it happened at the last (a refusal of the completion told as a refusal of the declaration), or the original reason lost.
  it('names the step a failure was at, and keeps the reason it had', async () => {
    const reason = refused('VALIDATION_FAILED', 400);
    const store: EvidenceUploader = (_file, steps) => {
      steps?.('hashing');
      steps?.('declaring');
      steps?.('sending');
      steps?.('confirming');
      return Promise.reject(reason);
    };

    const failure: unknown = await uploadWithSteps(
      store,
      file(),
      () => undefined,
      new AbortController().signal,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(UploadFailure);
    expect(failure).toMatchObject({ step: 'confirming', reason });
  });

  it('treats a refusal made before the first step as a failure of the first', async () => {
    const reason = new EvidenceRefusedError({ kind: 'too_large', size: 9, limit: 4 });
    const store: EvidenceUploader = () => Promise.reject(reason);

    const failure: unknown = await uploadWithSteps(
      store,
      file(),
      () => undefined,
      new AbortController().signal,
    ).catch((error: unknown) => error);

    expect(failure).toMatchObject({ step: 'hashing', reason });
    expect(evidenceFailureWords(failure)).toBe(fileTooLarge(4));
  });
});
