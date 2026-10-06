# Ops Portal (`apps/ops-web`)

React, Vite, TanStack Query and React Router. It is the application shell until the slices add screens. Requirements are in [surfaces/ops-portal.md](../../surfaces/ops-portal.md) and [surfaces/overview.md](../../surfaces/overview.md). Run it as [DEVELOPMENT.md](../../DEVELOPMENT.md) says; what B0.3 and B0.5 left undone is in the runbook ([B0.2 and B0.3](../../delivery/planning/BOOTSTRAP_B0_RUNBOOK.md#carried-forward-from-b02-and-b03), [B0.5](../../delivery/planning/BOOTSTRAP_B0_RUNBOOK.md#carried-forward-from-b05)).

## Layout

- `src/app/`: routes (`createAppRoutes` in `routes.tsx`), pages and providers. `src/components/`: shared structural components.
- `src/platform/api/`: the API client provider; take the client with `useApiClient()`. `src/platform/query/`: query setup.
- `config/`: the development proxy and the client-environment guard, both used by Vite. `test/`: guard tests and the browser smoke test.

## Rules

- API types come only from `@melarc/api-client` (its schema types and operations; the transport from `@melarc/api-client/browser`). Never hand-write a request or response type. `test/no-duplicate-wire-types.test.ts` catches only a type named like a contract schema and an import from any other path: a copy under another name passes it, so this rule rests on review. UI-only form and presentation models are fine.
- The browser talks only to its own origin, `/api/v1`, which the dev server proxies to the API (`config/dev-proxy.ts`). The API's probes are not reachable from it.
- Only `VITE_` variables reach the bundle, and the build refuses names that look like secrets. Never put a secret in the browser; [.env.example](.env.example) lists the settings.
- UI follows the [design system](../../design/DESIGN_SYSTEM.md) and [component patterns](../../design/COMPONENT_PATTERNS.md): semantic tokens, never scattered raw values. Add a component only when a pattern names it or the task needs it, and record it there. Both documents are drafts until Product Owner review: surface a missing or contested value, do not invent one.
- A screen implements the [nine interface states](../../surfaces/ops-portal.md#8-the-nine-interface-states): the error state maps the machine `code` to copy and never shows `message`. The first screen to use the client also owes the result-to-error conversion in the B0.5 notes above.
- A generic component never decides business policy, and the server stays authoritative (patterns sections 24 and 25). Structural components must work by keyboard, with visible focus and landmarks; the browser smoke test runs axe against them.

## Tests

`pnpm --filter @melarc/ops-web test` runs Vitest with Testing Library. `pnpm run test:browser` runs Playwright against a fresh production build and needs Chromium.
