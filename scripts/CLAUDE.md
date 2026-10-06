# Root tooling (`scripts/`)

Node scripts, and the tests that hold the repository itself to its rules. Node runs them directly with type stripping (`node scripts/<name>.ts`): plain erasable TypeScript and imports written with `.ts`. They may use the root `devDependencies`, except the scripts CI runs before or without an install (`ci-aggregate.ts`, `ci-revision.ts` and `workflow-shapes.ts`, which they import): those import only Node built-ins.

## Rules

- Root tests run with `pnpm run test:root`, which names every test file (a glob would pass on zero tests). Add a new `*.test.ts` to that list or it never runs.
- CI is [.github/workflows/ci.yml](../.github/workflows/ci.yml): five jobs and the `CI result` verdict. `ci-workflow.test.ts` fails when a mandatory command or the aggregate wiring is dropped, or a failure can be absorbed or skipped; `workspace-pins.test.ts` holds the Node.js, pnpm and action pins. A new check goes into the workflow and `REQUIRED_COMMANDS`; a new job also goes into the aggregate's `needs` and command line. Never add `continue-on-error`, `|| true` or a condition that can skip a check. The runbook's [B0.8 notes](../delivery/planning/BOOTSTRAP_B0_RUNBOOK.md#carried-forward-from-b08) say what CI does not cover.
- Documentation is held to the repository. `local-setup.test.ts` checks [DEVELOPMENT.md](../DEVELOPMENT.md). `agent-docs.test.ts` checks every `CLAUDE.md`: at most 90 lines for the root file and 40 for an area file, the required root sections, links and commands, every top-level folder mapped, and every Markdown file reachable from a `CLAUDE.md`. A new Markdown file or folder must be linked from the root map or from a document it reaches.
- `setup-env.ts` (`pnpm run setup:env`) creates the git-ignored settings files. It never overwrites and prints no secret.
- `package-source.ts` (`pnpm run package:source`) makes the ZIP for source review from what Git knows, refuses settings files, keys, dependencies and output by name, and fails if a local credential appears inside a file it would pack. It never changes the working tree and prints no value. Its ZIP writer is plain (65535 files, 4 GiB): do not add ZIP64 without a need.
- `design-contrast.ts` recomputes every ratio in the colour tables of [DESIGN_SYSTEM.md](../design/DESIGN_SYSTEM.md) §4.5 and §4.6 from the hex values the document names, and `design-contrast.test.ts` fails when a figure, a ✗ or a "thin" flag does not follow. Change a colour and its table together.
- `infra-check.ts` (`pnpm run infra:check`) says whether PostgreSQL answers where the database tools look. It probes this machine only, sends no credential and changes nothing; its loopback rule is held to the API's by a test.
- Never write a check that passes when it has nothing to check.

## Tests

`pnpm run test:root` runs them all and needs no service.
