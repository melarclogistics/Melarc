/**
 * The ports `platform/auth` reaches domain data and I/O through (SOLUTION_ARCHITECTURE.md §5). Platform owns the ports, domains
 * own their persistence adapters, and the composition root (`src/app.module.ts`) binds one to the other. Adapters live in
 * `*.adapter.ts` files that only the composition-root files listed in `src/architecture.test.ts` import; that test enforces it,
 * and enforces that every port has an interface, an injection token and a complete descriptor.
 */
export * from './attestation-verifier.port.js';
export * from './audit-writer.port.js';
export * from './clock.port.js';
export * from './delivery-provider.port.js';
export * from './delivery-queue.port.js';
export * from './hash-admission.port.js';
export * from './hasher.port.js';
export * from './idempotency-store.port.js';
export * from './identity-directory.port.js';
export * from './metrics.port.js';
export * from './port-bindings.js';
export * from './port-descriptor.js';
export * from './port-registry.js';
export * from './rate-limiter.port.js';
export * from './secret-cipher.port.js';
export * from './session-store.port.js';
export * from './token-service.port.js';
export * from './totp-verifier.port.js';
export * from './unit-of-work.port.js';
