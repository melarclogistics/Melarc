import { randomUUID } from 'node:crypto';

import {
  Inject,
  Injectable,
  Optional,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { holdAuthorization, type AuthorizedRequest } from '../authorization/authorized-request.js';
import { effectiveScope } from '../authorization/effective-scope.js';
import { OPERATION_CONTEXTS } from '../authorization/authorization-providers.js';
import type { OperationContexts } from '../authorization/operation-contexts.js';
import { RECORD_SCOPE_RESOLVER } from '../authorization/authorization-providers.js';
import type { RecordScopeResolver } from '../authorization/record-scope.js';
import { requireTier } from '../authorization/tier-policy.js';
import { SURFACE_OF_PRINCIPAL } from '../database/transaction-context.js';
import { authenticatedSessionOf } from '../auth/sessions/request-session.js';
import { ApiException } from '../http/api-exception.js';
import { ErrorCode } from '../http/error-codes.js';
import { currentRequestContext } from '../logging/request-context.js';
import { accessDetailOf, accessKindOf } from './access-kind.js';

/** The methods that change nothing: the same list the CSRF slot reads (a read, a probe and a preflight). */
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Steps 4 to 7 of the refusal order, as far as the platform can decide them before the request is validated (S0.26;
 * permission-enforcement.md section 5.1; SECURITY_DESIGN.md section 4; `AC-SLICE-000-26`, `-29`, `-30`, `-44`, `-114`, `-130`):
 *
 * 4. **The surface gate.** Is this application permitted to expose this category of work? The route names the surfaces it serves
 *    and the session's principal has one surface; a Vendor session on an Ops-only operation fails here, before ownership is
 *    considered. `403 PERMISSION_DENIED`.
 * 5. **The permission.** Does the session's **snapshot** of its bundle hold the key the route requires? No key, no exception: not
 *    a role name, not a bundle name, not a flag. The grant is read from the snapshot taken at issue and never from the live
 *    bundle (a reduction ends the session; an addition applies to later ones). `403 PERMISSION_DENIED`, the same answer as the
 *    surface gate: passing either never implies the other, and neither says which failed.
 * 6. **The tier** (`tier-policy.ts`), which the route declares (`tier`) and this guard decides, so that it comes before the scope and the
 *    validation: the least tier the grant must carry whatever the target is, before anything is looked up; and a requirement derived
 *    from the target's authoritative record, asked of the route's rule once the record is found visible (never from the request, and
 *    never for a record the caller may not see, who is answered by step 7 and learns nothing of what the record needs). The
 *    operation's transaction judges the rule again on the record it holds (`OperationRunner.requireTargetTier`).
 * 7. **Hub scope and ownership.** The scope the operation runs under is the scope of **the grant that authorizes it**, intersected
 *    with what the session reaches (`effective-scope.ts`). For a route that names a record by a path parameter, whether the caller
 *    can see that record is decided here, before the body is validated: `404 NOT_FOUND`, or for staff `403 HUB_SCOPE_VIOLATION` by
 *    the scope probe (`record-scope.ts`).
 *
 * What it keeps is a decision (`AuthorizedRequest`), beside the request, from which the use case's context is built. A route that
 * needs a principal and states nothing of the surfaces it serves is refused: deny by default. It fails closed on what it cannot
 * place, as the other slots do: a route reached with no session held is refused, because this guard must never be the one that
 * lets such a request on. It answers authorization codes only, never an authentication one (`AC-SLICE-000-29`).
 */
@Injectable()
export class AuthorizationGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Optional()
    @Inject(RECORD_SCOPE_RESOLVER)
    private readonly records: RecordScopeResolver | undefined,
    @Optional()
    @Inject(OPERATION_CONTEXTS)
    private readonly contexts: OperationContexts | undefined,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const kind = accessKindOf(this.reflector, context);
    if (kind !== 'self' && kind !== 'permission') return true;

    const request = context.switchToHttp().getRequest<Request>();
    const authenticated = authenticatedSessionOf(request);
    const detail = accessDetailOf(this.reflector, context);
    const options = detail?.authenticated;
    if (authenticated === undefined || options === undefined) {
      throw ApiException.of(ErrorCode.PermissionDenied, 'Permission denied');
    }
    const { session } = authenticated;

    // 4. The surface gate.
    const surface = SURFACE_OF_PRINCIPAL[session.principalType];
    if (!(options.surfaces as readonly string[]).includes(surface)) {
      throw ApiException.of(ErrorCode.PermissionDenied, 'Permission denied');
    }

    // 5. The permission, from the snapshot the session was issued with.
    let grant;
    if (kind === 'permission') {
      grant = session.authority.snapshot.grants.find(
        (candidate) => candidate.permission === detail?.permission,
      );
      if (grant === undefined)
        throw ApiException.of(ErrorCode.PermissionDenied, 'Permission denied');
    }

    // 6. The least tier the operation needs of the grant, whatever the target: before anything is looked up.
    const tier = options.tier;
    if (grant !== undefined && tier?.minimum !== undefined) requireTier(grant.tier, tier.minimum);

    // 7. The scope of this grant, and the record the route names if it names one (and, once it is found, the tier it needs).
    const scope = effectiveScope(grant, session.authority.authorizedHubIds);
    const recordId: unknown =
      options.record === undefined ? undefined : request.params[options.record.param];
    const authorized: AuthorizedRequest = {
      session,
      credential: authenticated.credential,
      idleMinutes: authenticated.idleMinutes,
      judgedAt: authenticated.judgedAt,
      permission: kind === 'permission' ? detail?.permission : undefined,
      grant,
      scope,
      activity: options.activity,
      stateChanging: !SAFE_METHODS.has(request.method),
      ...(options.record === undefined || typeof recordId !== 'string'
        ? {}
        : {
            target: {
              entity: options.record.entity,
              id: recordId,
              ...(tier?.rule === undefined ? {} : { tierRule: tier.rule }),
            },
          }),
    };

    if (options.record !== undefined && typeof recordId === 'string') {
      if (this.records === undefined || this.contexts === undefined) {
        // A route names a record and nothing is composed to look for it: the platform does not guess.
        throw new RecordScopeUnavailableError();
      }
      const correlationId = currentRequestContext()?.requestId ?? randomUUID();
      await this.records.require(
        options.record,
        recordId,
        await this.contexts.of(authorized, correlationId),
        tier?.rule === undefined ? undefined : { rule: tier.rule, grantTier: grant?.tier ?? null },
      );
    }

    holdAuthorization(request, authorized);
    return true;
  }
}

/** A route names a record and the application is composed without what looks for it: the operational failure (`503`). */
export class RecordScopeUnavailableError extends Error {
  constructor() {
    super('A route names a record and no record scope resolver is composed');
    this.name = 'RecordScopeUnavailableError';
  }
}
