/**
 * The operations of contracts/openapi.yaml that this implementation claims, by `operationId`. The contract
 * describes the whole product and the code implements it one slice at a time, so until the whole API exists
 * only this intentional scope is compared with the contract (engineering-standards.md section 4).
 *
 * It is empty today: no product slice has added a route, and the only routes the application answers are the
 * two technical probes. Add an id here in the same change that implements the operation, and remove it only
 * when the operation is removed. The conformance check fails when this list and the router disagree in
 * either direction, so it cannot quietly drift from what is true.
 */
export const IMPLEMENTED_OPERATIONS: readonly string[] = [];
