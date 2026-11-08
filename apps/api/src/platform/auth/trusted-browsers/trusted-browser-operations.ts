import type { AuthorizedRequest } from '../../authorization/authorized-request.js';
import type { OperationRunner } from '../../authorization/operation-runner.js';
import { isUuid } from '../../database/transaction-context.js';
import { ApiException } from '../../http/api-exception.js';
import { ErrorCode } from '../../http/error-codes.js';
import type { AuditWriter } from '../ports/audit-writer.port.js';
import type { TokenService } from '../ports/token-service.port.js';
import type { TransactionHandle } from '../ports/unit-of-work.port.js';
import { TrustedBrowserStore } from './trusted-browser-store.js';
import { trustedBrowserView, type TrustedBrowserView } from './trusted-browser-view.js';

export interface TrustedBrowserOperationsOptions {
  /** Opens the transaction of a request under the context its authorization decided: a read for the list, a mutation for the removal. */
  readonly runner: Pick<OperationRunner, 'read' | 'mutate'>;
  readonly store: TrustedBrowserStore;
  readonly audit: AuditWriter;
  readonly tokens: Pick<TokenService, 'hash'>;
}

/**
 * `listTrustedBrowsers` and `revokeTrustedBrowser` (staff-authentication.md §5.8): a person's own trusted browsers, listed and removed.
 * Both are `self` operations of the Ops Portal: the person is the session's, never one a client names, and no permission is held, so
 * neither can answer `403 PERMISSION_DENIED`. Both run in the person's own staff context, and the policy of the table admits that context
 * to its own rows and to no one else's.
 *
 * - **The list** is the person's trusted browsers that are not removed and not past their end, newest first, each with its label and
 *   dates. It marks the one that presented its credential with this request (`current`), found by the hash of the cookie through a
 *   function that answers a person about their own identity alone. A person whose role signs in without an authenticator has none and
 *   the list is empty.
 * - **The removal** ends one (`SELF`), in the same transaction as its audit event. One that is another person's, one already removed or
 *   past its end, and one that does not exist are the same `NOT_FOUND`: the answer says nothing of other people's browsers. When the
 *   browser removed is the one asking, the caller clears its cookie.
 */
export class TrustedBrowserOperations {
  readonly #options: TrustedBrowserOperationsOptions;

  constructor(options: TrustedBrowserOperationsOptions) {
    this.#options = options;
  }

  async list(
    authorized: AuthorizedRequest,
    correlationId: string,
    presented: string | undefined,
  ): Promise<{ readonly items: readonly TrustedBrowserView[] }> {
    const { runner, store } = this.#options;
    const principalId = authorized.session.principalId;
    return runner.read(authorized, correlationId, async (handle) => {
      const currentId = await this.#currentOf(handle, presented, principalId);
      const browsers = await store.list(handle, principalId);
      return { items: browsers.map((browser) => trustedBrowserView(browser, currentId)) };
    });
  }

  /** Removes one of the person's own; the result says whether the browser removed is the one that asked, so its cookie is cleared. */
  async revoke(
    authorized: AuthorizedRequest,
    correlationId: string,
    id: string,
    presented: string | undefined,
  ): Promise<{ readonly clearsCookie: boolean }> {
    const { runner, store, audit } = this.#options;
    const principalId = authorized.session.principalId;
    if (!isUuid(id)) throw ApiException.of(ErrorCode.NotFound, 'Resource not found');
    return runner.mutate(authorized, correlationId, async (handle) => {
      const currentId = await this.#currentOf(handle, presented, principalId);
      if (!(await store.revokeOne(handle, id, principalId))) {
        throw ApiException.of(ErrorCode.NotFound, 'Resource not found');
      }
      await audit.write(handle, {
        code: 'auth.trusted_browser.revoked',
        enhanced: false,
        outcome: 'SUCCEEDED',
        object: { type: 'StaffIdentity', id: principalId },
        relatedIds: { trusted_browser_id: id },
        detail: { cause: 'SELF' },
      });
      return { clearsCookie: currentId === id };
    });
  }

  /** Which of the person's trusted browsers the request's cookie is, whatever its state; none for a credential that is none of theirs. */
  async #currentOf(
    handle: TransactionHandle,
    presented: string | undefined,
    principalId: string,
  ): Promise<string | null> {
    if (presented === undefined) return null;
    const hash = this.#options.tokens.hash(presented);
    return hash === null ? null : this.#options.store.idFor(handle, hash, principalId);
  }
}
