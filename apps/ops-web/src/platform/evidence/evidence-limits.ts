import { isRecord } from '../staff/staff-shape';

/**
 * The platform's limits on a file of evidence (`getEvidenceLimits`; OB-S1-110): the types it takes and the largest file, **read** by the portal so that a file above the size limit is refused before the
 * file is read whole (the checksum reads every byte of it) and a type the platform will not take is refused before anything is declared. **They are the platform's and never the portal's**: a read that
 * fails gives no limit, the portal judges nothing in the browser, and the platform still refuses what it will not take. A limit is never guessed.
 */
export interface EvidenceLimitsView {
  /** Media types, lower case and without parameters, as the platform's setting lists them. */
  readonly allowedTypes: readonly string[];
  readonly maxBytes: number;
}

/** What a file is refused for, before it is read: the platform's limits and the file's own type and size, and nothing else. */
export type LimitRefusal =
  | { readonly kind: 'type_not_allowed'; readonly type: string }
  | { readonly kind: 'too_large'; readonly size: number; readonly limit: number };

const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;

/** The contract's `EvidenceLimits`, judged: both members, a list of media types and a whole size of at least one byte, and no member of its own (`additionalProperties: false`). */
export function parseEvidenceLimits(body: unknown): EvidenceLimitsView | undefined {
  if (!isRecord(body)) return undefined;
  if (Object.keys(body).some((key) => key !== 'allowed_content_types' && key !== 'max_byte_size')) {
    return undefined;
  }
  const types = body.allowed_content_types;
  const size = body.max_byte_size;
  if (
    !Array.isArray(types) ||
    types.length === 0 ||
    !types.every((type) => typeof type === 'string' && MEDIA_TYPE.test(type)) ||
    typeof size !== 'number' ||
    !Number.isSafeInteger(size) ||
    size < 1
  ) {
    return undefined;
  }
  return { allowedTypes: types.map((type: string) => type.toLowerCase()), maxBytes: size };
}

/** A media type as a comparison sees it: its case and its parameters are not part of the type. */
function mediaTypeOf(type: string): string {
  return (type.split(';')[0] ?? '').trim().toLowerCase();
}

/**
 * Whether the platform would refuse this file, judged from what is known **without reading its bytes**: the browser's name for its type and its size. The type is judged first (a file of a type the platform
 * does not take is refused whatever its size), then the size, and a file exactly at the size is taken. A file the browser could not type has no type the platform takes.
 */
export function refusalOfFile(
  file: Pick<File, 'size' | 'type'>,
  limits: EvidenceLimitsView,
): LimitRefusal | undefined {
  if (!limits.allowedTypes.includes(mediaTypeOf(file.type))) {
    return { kind: 'type_not_allowed', type: file.type };
  }
  if (file.size > limits.maxBytes) {
    return { kind: 'too_large', size: file.size, limit: limits.maxBytes };
  }
  return undefined;
}
