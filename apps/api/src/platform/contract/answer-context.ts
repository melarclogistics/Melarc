/**
 * Whose answer a handler gave, for a response whose cookies depend on it (`x-set-cookies-when`). One operation can
 * answer for more than one type of principal with the same status, and the contract says that the cookies it sets
 * are owed to one of them: `completeCredentialRecovery` gives a vendor's browser its device credential and gives a
 * staff member none. Neither the request (it carries a token, not a principal) nor the response says which it was,
 * so the handler does, and the interceptor hands it to the validator.
 *
 * It is kept beside the request and never on it: nothing a client sends can name it, and it lives exactly as long as
 * the request does.
 */
const principals = new WeakMap<object, string>();

/**
 * Says what type of principal this request's answer is for (`STAFF`, `VENDOR`). Call it once, from the handler that
 * acted for the principal, before it returns. A later call replaces the earlier one.
 */
export function declareAnswerPrincipal(request: object, principalType: string): void {
  principals.set(request, principalType);
}

/** The type of principal the handler said it answered for, or undefined if it said nothing. */
export function answerPrincipalOf(request: object): string | undefined {
  return principals.get(request);
}
