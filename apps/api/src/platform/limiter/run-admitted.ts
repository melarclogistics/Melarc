import type { HashAdmission } from '../auth/ports/hash-admission.port.js';

export type AdmittedOutcome<T> =
  { readonly admitted: true; readonly value: T } | { readonly admitted: false };

/**
 * Runs `work` in a slot, or does not run it. When no slot is free the work is **not called at all** (nothing is hashed, nothing
 * counted) and the outcome says so; the caller answers `RATE_LIMITED`. The slot is given back when the work finishes or fails.
 *
 * It takes the `HashAdmission` port and no adapter, and it lives apart from the adapter so that a use case can import it: only the
 * composition root imports a file named `*.adapter.ts` (`src/architecture.test.ts`).
 */
export async function runAdmitted<T>(
  admission: HashAdmission,
  work: () => Promise<T>,
): Promise<AdmittedOutcome<T>> {
  const slot = admission.tryAdmit();
  if (slot === null) return { admitted: false };
  try {
    return { admitted: true, value: await work() };
  } finally {
    slot.release();
  }
}
