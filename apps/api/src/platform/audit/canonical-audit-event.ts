import { AUDIT_SERIALISATION_VERSION } from './audit-vocabulary.js';

/**
 * The canonical serialisation of a stored audit event, version 1 (audit.md §2.1: "the writer keeps what the chain will need ...
 * a canonical serialisation version"). The signed checkpoint chain is release gate G1 and is not built here; what is built is the
 * byte-stable form it will hash, so that an event written today can be verified by a checkpoint cut later.
 *
 * **The form.** One JSON object with exactly the fields of `CANONICAL_FIELDS`, every key sorted in code-unit order at every
 * depth, arrays in their order, no whitespace, strings escaped as `JSON.stringify` escapes them (well-formed: a lone surrogate
 * is written as `\udXXX`, as ECMAScript requires since 2019), numbers as `JSON.stringify` writes them, a null field as `null`.
 * The text is UTF-8. Nothing in it depends on the machine, the locale or the Node version: the escaping and the number format are
 * fixed by the language specification, and a test pins the exact bytes of an example.
 *
 * **The input** is the event as the database holds it, with each timestamp read as the fixed UTC text with microseconds
 * (`YYYY-MM-DDTHH:MM:SS.ffffffZ`, what `to_char` gives), because a JavaScript `Date` keeps milliseconds and PostgreSQL keeps
 * microseconds, and a form that rounded would hash differently from the row. The `jsonb` columns arrive as parsed values.
 *
 * **A change to this form is a new version,** with its own function and its own known answer, and an event is read under the
 * version it carries (`serialisation_version`). Version 1 is never edited once an event has been written under it.
 */
export const CANONICAL_FIELDS = [
  'id',
  'event_code',
  'occurred_at',
  'recorded_at',
  'actor_type',
  'actor_id',
  'actor_bundle',
  'surface_context',
  'device_context',
  'vendor_organization_id',
  'responsible_hub_id',
  'object_type',
  'object_id',
  'correlation_id',
  'previous_state',
  'resulting_state',
  'reason_code',
  'reason_label',
  'note',
  'approval_id',
  'before_after',
  'related_ids',
  'detail',
  'outcome',
  'enhanced',
  'serialisation_version',
] as const;

type CanonicalField = (typeof CANONICAL_FIELDS)[number];

export type StoredAuditEvent = Readonly<Record<CanonicalField, unknown>>;

const MICROSECOND_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const TIMESTAMP_FIELDS: readonly CanonicalField[] = ['occurred_at', 'recorded_at'];

/** The value as sorted-key JSON text. A value JSON cannot hold is refused, not rendered as `null`. */
function render(value: unknown, field: string): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value))
        throw new TypeError(`The audit field ${field} holds a number JSON cannot write`);
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((item: unknown) => render(item, field)).join(',')}]`;
      }
      const entries = Object.keys(value)
        .sort()
        .map(
          (key) =>
            `${JSON.stringify(key)}:${render((value as Record<string, unknown>)[key], field)}`,
        );
      return `{${entries.join(',')}}`;
    }
    default:
      throw new TypeError(`The audit field ${field} holds a value JSON cannot write`);
  }
}

/** The canonical form of an event (version 1), as the text a checkpoint hashes. */
export function canonicalAuditEvent(event: StoredAuditEvent): string {
  if (event.serialisation_version !== AUDIT_SERIALISATION_VERSION) {
    throw new RangeError('This is the form of serialisation version 1 only');
  }
  for (const field of TIMESTAMP_FIELDS) {
    const value = event[field];
    if (typeof value !== 'string' || !MICROSECOND_UTC.test(value)) {
      throw new TypeError(`The audit field ${field} is not a UTC timestamp with microseconds`);
    }
  }
  const members = [...CANONICAL_FIELDS]
    .sort()
    .map((field) => `${JSON.stringify(field)}:${render(event[field], field)}`);
  return `{${members.join(',')}}`;
}
