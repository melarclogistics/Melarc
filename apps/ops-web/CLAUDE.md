# Ops Portal (`apps/ops-web`)

React, Vite, TanStack Query and React Router. It is the application shell and the UI foundation until the slices add screens. Requirements are in [surfaces/ops-portal.md](../../surfaces/ops-portal.md) and [surfaces/overview.md](../../surfaces/overview.md). Run it as [DEVELOPMENT.md](../../DEVELOPMENT.md) says; what B0.3 and B0.5 left undone is in the runbook ([B0.2 and B0.3](../../delivery/planning/BOOTSTRAP_B0_RUNBOOK.md#carried-forward-from-b02-and-b03), [B0.5](../../delivery/planning/BOOTSTRAP_B0_RUNBOOK.md#carried-forward-from-b05)).

## Layout

- `src/app/`: routes (`createAppRoutes` in `routes.tsx`), pages and providers. `src/components/`: structural components and `PageHeader`; `src/components/ui/<name>/`: the UI primitives (Button, Link, Alert, Field, Input, loading), each with its CSS and tests.
- `src/styles/`: `tokens.css` is the one token source, `base.css` the frame and element defaults, and `fonts.css` the self-hosted Inter (files and licence record in `src/assets/fonts/`, licence text in `public/licenses/`; never a CDN, never inlined). `src/showcase/`: the development-only component showcase; nothing may import it, and the production build holds no trace of it.
- `src/platform/api/`: the API client provider; take the client with `useApiClient()`. `src/platform/query/`: query setup.
- `config/`: the development proxy and the client-environment guard, both used by Vite. `test/`: guard tests and the browser tests.

## Rules

- API types come only from `@melarc/api-client` (its schema types and operations; the transport from `@melarc/api-client/browser`). Never hand-write a request or response type. `test/no-duplicate-wire-types.test.ts` catches only a type named like a contract schema and an import from any other path: a copy under another name passes it, so this rule rests on review. UI-only form and presentation models are fine.
- The browser talks only to its own origin, `/api/v1`, which the dev server proxies to the API (`config/dev-proxy.ts`). The API's probes are not reachable from it.
- Only `VITE_` variables reach the bundle, and the build refuses names that look like secrets. Never put a secret in the browser; [.env.example](.env.example) lists the settings.
- UI follows the [design system](../../design/DESIGN_SYSTEM.md) and [component patterns](../../design/COMPONENT_PATTERNS.md). Use the components in `components/ui/` before writing markup, and take every colour, size and space from `tokens.css`: `scripts/design-tokens.test.ts` fails on a colour written anywhere else and on a focus rule without an outline. Add a component only when a pattern names it or the task needs it, and record it in the patterns. A missing or contested value is surfaced, never invented.
- The neutral frame shows no navigation, user menu, sign-out or session data. Navigation entries come from the `permissions` list of the `Session` resource (permission keys, [design system](../../design/DESIGN_SYSTEM.md) §22), never from a role name, and the server stays authoritative. The identity slice supplies the list: until then `PrimaryNavigation` takes a plain list that shows none, and no menu is built from placeholders.
- A screen implements the [nine interface states](../../surfaces/ops-portal.md#8-the-nine-interface-states): the error state maps the machine `code` to copy and never shows `message`. Read every call with `unwrap(result)` from `@melarc/api-client/browser`, never `if (error)`: a 403 with an empty body has no `error`. A failure is an `ApiError` (kind, status, code, requestId); its message never holds server text. Pass `onSessionEnded` to `createQueryClient` once sign-in exists: the identity slice owes it, and `endSession(queryClient)` on sign-out. A route loader cannot reach the client (the router is built before the providers): fetch in the page with a query until that is decided. ESLint refuses `fetch`, XHR, web storage, `window.open`, `dangerouslySetInnerHTML` and `eval` in application code.
- A generic component never decides business policy, and the server stays authoritative (patterns sections 24 and 25). A new interactive component is tested by keyboard in jsdom and driven in the showcase in a real browser (keyboard, 320 px, enlarged text, forced colours, reduced motion, axe with WCAG 2.2).

## Tests

`pnpm --filter @melarc/ops-web test` runs Vitest with Testing Library. `pnpm run test:browser` runs Playwright and needs Chromium: the shell against a fresh production build, the components against the development server. CI sets `MELARC_BROWSERS=chromium,firefox,webkit`; install Firefox and WebKit ([DEVELOPMENT.md](../../DEVELOPMENT.md)) to do the same locally.
