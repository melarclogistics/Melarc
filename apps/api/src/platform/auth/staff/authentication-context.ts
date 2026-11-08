import { randomUUID } from 'node:crypto';

import type { SecurityContext } from '../../database/transaction-context.js';
import { currentRequestContext } from '../../logging/request-context.js';
import { AUTHENTICATION_PRINCIPAL_ID } from '../sessions/session-parameters.js';

/**
 * The context of every transaction of the pre-session staff operations (setup, enrolment, sign-in): the platform's own authentication
 * task, as `SYSTEM`, correlated with the request that is being answered. Row-level security admits nothing else to read or write a
 * credential, a grant, a factor or a challenge.
 */
export function authenticationContext(): SecurityContext {
  return {
    principalType: 'SYSTEM',
    principalId: AUTHENTICATION_PRINCIPAL_ID,
    surface: 'SYSTEM',
    taskCapability: 'authentication',
    correlationId: currentRequestContext()?.requestId ?? randomUUID(),
  };
}
