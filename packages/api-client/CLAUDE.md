# Generated API client (`packages/api-client`)

Wire types generated from [contracts/openapi.yaml](../../contracts/openapi.yaml), and the browser transport that carries them. The Ops Portal is its only consumer. What B0.5 left undone is in the runbook ([B0.5](../../delivery/planning/BOOTSTRAP_B0_RUNBOOK.md#carried-forward-from-b05)).

## Rules

- `src/generated/` is machine output: never edit it. After any contract change run `pnpm run api-client:generate`. CI runs `pnpm run api-client:check` and fails when the output is stale; its header records the contract's hash.
- The contract is the only source. Never copy types from the API code or write wire types by hand.
- `src/browser/` is the browser transport (cookies, CSRF, same origin). A call may use only `params`, `body`, `parseAs`, `signal` and `headers` (`CALL_OPTIONS` in `src/browser/call-options.ts`); any other option is a type error and is refused at run time. Add one to `CALL_OPTIONS` deliberately, with a test.
- The Rider bearer transport and the evidence-upload transport are not built, and the browser transport refuses to reach them. Do not add another origin to it.
- The types require `Idempotency-Key` and `If-Match` where the contract does, but nothing generates or retains them yet: the slice that sends the command does.
- The generator (`openapi-typescript`) is pinned and runs under TypeScript 6, past its declared range ([pnpm-workspace.yaml](../../pnpm-workspace.yaml)). Review the regenerated diff after changing either.

## Tests

`pnpm --filter @melarc/api-client test`. The generator tests and the conformance test read the real contract.
