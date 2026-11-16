import { describe, expect, it } from 'vitest';

import { parseEvidenceLimits, refusalOfFile } from './evidence-limits';

/**
 * The platform's limits on a file of evidence (`getEvidenceLimits`; OB-S1-110), so that a screen can refuse a file above the size limit **before it reads the file whole** (the checksum reads every byte). They are
 * the platform's configuration and never the portal's: a limit the read did not give is not guessed, and the platform still refuses what it will not take.
 */
const LIMITS = { allowedTypes: ['image/jpeg', 'image/png'], maxBytes: 10_485_760 } as const;

describe('the limits getEvidenceLimits answers with', () => {
  it('are the types and the size, as the contract names them', () => {
    expect(
      parseEvidenceLimits({
        allowed_content_types: ['image/jpeg', 'image/png'],
        max_byte_size: 10_485_760,
      }),
    ).toEqual(LIMITS);
  });

  // Break caught: a limit made up from a body that is not one (a missing size read as "no limit", a list of nothing read as "everything").
  it.each([
    ['nothing', null],
    ['no size', { allowed_content_types: ['image/jpeg'] }],
    ['no types', { max_byte_size: 10 }],
    ['an empty list of types', { allowed_content_types: [], max_byte_size: 10 }],
    ['a type that is not a text', { allowed_content_types: [7], max_byte_size: 10 }],
    ['a type with parameters', { allowed_content_types: ['image/jpeg; q=1'], max_byte_size: 10 }],
    ['a size of zero', { allowed_content_types: ['image/jpeg'], max_byte_size: 0 }],
    ['a size that is not whole', { allowed_content_types: ['image/jpeg'], max_byte_size: 1.5 }],
    ['a size that is not a number', { allowed_content_types: ['image/jpeg'], max_byte_size: '10' }],
    ['a size no integer holds', { allowed_content_types: ['image/jpeg'], max_byte_size: 2 ** 60 }],
    ['a member of its own', { allowed_content_types: ['image/jpeg'], max_byte_size: 10, extra: 1 }],
  ])('are not limits when the body is %s', (_name, body) => {
    expect(parseEvidenceLimits(body)).toBeUndefined();
  });
});

describe('the judgement of a file against the limits, before it is read', () => {
  it('lets a file through that is the right type and within the size, and one exactly at the size', () => {
    expect(refusalOfFile({ type: 'image/jpeg', size: 1 }, LIMITS)).toBeUndefined();
    expect(refusalOfFile({ type: 'image/png', size: LIMITS.maxBytes }, LIMITS)).toBeUndefined();
  });

  // Break caught: the size limit applied from the wrong side (a file at the limit refused, one a byte above it taken), which a photographer meets as a photo that "is exactly 10 MB".
  it('refuses a file a byte above the size, naming the size and the limit', () => {
    expect(refusalOfFile({ type: 'image/jpeg', size: LIMITS.maxBytes + 1 }, LIMITS)).toEqual({
      kind: 'too_large',
      size: LIMITS.maxBytes + 1,
      limit: LIMITS.maxBytes,
    });
  });

  it('refuses a type the platform does not take, whatever its size', () => {
    expect(refusalOfFile({ type: 'application/pdf', size: 10 }, LIMITS)).toEqual({
      kind: 'type_not_allowed',
      type: 'application/pdf',
    });
    // A file the browser could not type is not a photo the platform takes either.
    expect(refusalOfFile({ type: '', size: 10 }, LIMITS)).toEqual({
      kind: 'type_not_allowed',
      type: '',
    });
  });

  // Break caught: a type compared with its parameters or in another case, so that "image/JPEG" is refused although the platform takes it.
  it('compares the type as a media type: its case and its parameters do not count', () => {
    expect(refusalOfFile({ type: 'IMAGE/JPEG', size: 10 }, LIMITS)).toBeUndefined();
    expect(refusalOfFile({ type: 'image/jpeg; charset=binary', size: 10 }, LIMITS)).toBeUndefined();
  });

  it('judges the type before the size', () => {
    expect(refusalOfFile({ type: 'text/plain', size: LIMITS.maxBytes + 1 }, LIMITS)).toMatchObject({
      kind: 'type_not_allowed',
    });
  });
});
