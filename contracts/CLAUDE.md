# Contracts (`contracts/`)

The approved, version-controlled definitions the code must conform to. Each file owns one subject, stated in its "Owns" line; the files are listed in the [root map](../CLAUDE.md#where-things-are). [openapi.yaml](openapi.yaml) is the HTTP contract.

## Rules

- Code never overrides a contract. A change to an operation, payload, enum, error or contract-visible behavior is a reviewed, intentional contract change, made together with its code and with every owning document it touches (errors, permissions, state machines, feature criteria, surfaces: [standards §6](../standards/engineering-standards.md#6-refining-specifications-with-implementation)). Without that it is a defect, whatever the tests say.
- Keep stable: `operationId`s, error codes, permission keys, setting keys, audit event codes, state values and acceptance-criterion IDs. A withdrawn code is never reused, and renaming an error code is a breaking change.
- After editing `openapi.yaml`, run `pnpm run api-client:generate`, then `pnpm run contract:check` (build first if `dist` is stale) and the tests.
- `.prettierignore` keeps all of `contracts/` out of formatting, and a Windows working copy may hold CRLF where Git stores LF (`git ls-files --eol`). Edit with a tool that preserves each file's line endings.
- Counts in prose are derived or omitted. Each fact has one owning document: cross-reference it, do not copy it.
