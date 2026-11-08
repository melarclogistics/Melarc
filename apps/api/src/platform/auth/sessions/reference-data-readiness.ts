import { sql } from 'drizzle-orm';

import { transactionOf } from '../../database/transaction-handle.js';
import { NotReadyError, type ReadinessCheck } from '../../health/readiness.registry.js';
import type { TransactionHandle, UnitOfWork } from '../ports/unit-of-work.port.js';
import { AUTHENTICATION_PRINCIPAL_ID } from './session-parameters.js';

/**
 * Whether the reference seed has filled the database (MIGRATION_AND_SEEDING.md section 4): the role bundles and the settings. The seed
 * writes all seven reference tables in one statement or none (`melarc.initialize_reference_data` refuses unless all are empty), so the
 * presence of the bundles and of the settings stands for it. A database that has been migrated and not seeded has neither, and
 * nothing can be served over it: a sign-in needs the setting of its own rate limit, and a session needs a bundle.
 */
export async function referenceDataIsSeeded(handle: TransactionHandle): Promise<boolean> {
  const result = await transactionOf(handle).execute(
    sql`select (exists (select 1 from role_bundle) and exists (select 1 from setting)) as seeded`,
  );
  return (result.rows[0] as { seeded: boolean } | undefined)?.seeded === true;
}

/**
 * The readiness of an instance over its reference data (the Product Owner's decision of 25 October 2026): an instance whose database
 * has been migrated and not seeded is *not ready* with the reason `reference_data_missing`, and ready the moment the seed has run.
 * Before this, `/readyz` checked the connection alone, said *ready*, and every sign-in answered `503` for want of a setting, with
 * nothing to say why.
 *
 * - **Unable to find out is not unseeded.** A database that does not answer fails the check as any dependency does
 *   (`dependency_unavailable`, whose remedy is to wait); only an answer that finds the data absent is `reference_data_missing`, whose
 *   remedy is `db:seed`.
 * - It writes nothing: it is a read, under the `authentication` capability (the context that may read the reference tables for the
 *   sign-in and the session issue), in a short transaction of its own, and the registry shares one run among concurrent probes.
 */
export class ReferenceDataReadiness implements ReadinessCheck {
  readonly name = 'reference-data';
  readonly #unitOfWork: Pick<UnitOfWork, 'run'>;

  constructor(options: { readonly unitOfWork: Pick<UnitOfWork, 'run'> }) {
    this.#unitOfWork = options.unitOfWork;
  }

  async check(): Promise<void> {
    const seeded = await this.#unitOfWork.run(
      {
        principalType: 'SYSTEM',
        principalId: AUTHENTICATION_PRINCIPAL_ID,
        surface: 'SYSTEM',
        taskCapability: 'authentication',
        correlationId: 'readiness',
      },
      referenceDataIsSeeded,
    );
    if (!seeded) throw new NotReadyError('reference_data_missing');
  }
}
