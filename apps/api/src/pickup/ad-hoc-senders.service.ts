import { sql } from 'drizzle-orm';

import type { AuthorizedRequest } from '../platform/authorization/authorized-request.js';
import type { OperationRunner } from '../platform/authorization/operation-runner.js';
import { transactionOf } from '../platform/database/transaction-handle.js';
import { ApiException } from '../platform/http/api-exception.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import { normalisePhone } from './phone.js';

export interface AdHocSenderView {
  readonly id: string;
  readonly display_name: string;
  readonly phone: string;
  readonly state: 'PROVISIONAL' | 'REUSABLE';
}

export interface AdHocSendersServiceOptions {
  readonly runner: Pick<OperationRunner, 'read'>;
}

interface SenderRow {
  readonly id: string;
  readonly name: string;
  readonly phone: string;
  readonly state: 'PROVISIONAL' | 'REUSABLE';
}

/**
 * `findAdHocSender` (S1.14; `vendor.read`; `AC-SLICE-001-72`; domain-model.md section 6.9; `MSC-DEC-172`): the walk-in who has used
 * Melarc before, found by phone, so that a booking reuses the identity, the contact and the place instead of capturing them again.
 *
 * - **Zero or one.** The phone is the identity (unique across the platform), and an unknown phone is an empty list and not an error: a
 *   lookup that answered `NOT_FOUND` would tell whoever asks which numbers belong to senders.
 * - **Only a reusable sender is found.** One whose first pickup has not completed is provisional and "not searchable for reuse" (sections
 *   35.2.7 and 35.12.10); a booking that comes back before then names its phone as a first-time sender, which reuses the row.
 * - **Staff alone.** The registry gives a vendor and a rider no read of a sender; the key is the office's.
 * - **A number that cannot be a phone is a validation failure**, not an empty answer: it names a field the caller got wrong.
 */
export class AdHocSendersService {
  readonly #options: AdHocSendersServiceOptions;

  constructor(options: AdHocSendersServiceOptions) {
    this.#options = options;
  }

  async find(
    authorized: AuthorizedRequest,
    correlationId: string,
    entered: string,
  ): Promise<{ readonly items: readonly AdHocSenderView[] }> {
    const phone = normalisePhone(entered);
    if (phone === undefined) {
      throw new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
        violations: [{ in: 'query', pointer: '/phone', rule: 'format' }],
      });
    }
    return this.#options.runner.read(authorized, correlationId, async (handle) => {
      const found = await transactionOf(handle).execute(
        sql`select id, name, phone, state from ad_hoc_sender where phone = ${phone} and state = 'REUSABLE'`,
      );
      const rows = found.rows as unknown as SenderRow[];
      return {
        items: rows.map((row) => ({
          id: row.id,
          display_name: row.name,
          phone: row.phone,
          state: row.state,
        })),
      };
    });
  }
}
