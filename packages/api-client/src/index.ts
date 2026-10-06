/**
 * The wire types of the Melarc API, generated from contracts/openapi.yaml. Types only: importing this
 * module adds nothing to a bundle. A transport that carries them is a separate entry point, because each
 * kind of client authenticates differently (the browser transport is `@melarc/api-client/browser`).
 */
import type { components, operations, paths } from './generated/schema.ts';

export type { components, operations, paths };

/** The body of every error response (the contract's `Error` schema). */
export type ApiErrorBody = components['schemas']['Error'];

/** The stable machine code in an error body: the only field a client may branch on. */
export type ApiErrorCode = ApiErrorBody['code'];
