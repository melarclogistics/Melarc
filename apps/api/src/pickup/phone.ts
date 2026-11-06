/**
 * The phone number of a pickup request and of an ad-hoc sender (S1.14; domain-model.md section 3.4: "E.164 plus as-entered"). The function is
 * the platform's since task C2 (`platform/lookup/normalise-phone.ts`, where its rules are written), because the global lookup reads a number the
 * way the sender lookup does; the pickup domain names it here for its own files and its own tests.
 */
export { normalisePhone } from '../platform/lookup/normalise-phone.js';
