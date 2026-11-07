// The contract's account of whether an operation takes a session now lives in production code, where `contract:check` reads it
// (`platform/contract/takes-session.ts`); the tests keep importing it from here.
export { takesSession } from '../platform/contract/takes-session.js';
