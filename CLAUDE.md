# Melarc development guide

Read `delivery/DEVELOPMENT_EXECUTION_PLAN.md` first for the active manual incremental workflow. Use `delivery/planning/BOOTSTRAP_B0_RUNBOOK.md` for the selected bootstrap task.

- Execute only the bounded task the user requests. State affected files and the smallest meaningful validation; report actual commands, results and blockers. Fix failures before dependent work continues.
- Read only relevant master sections, owning contracts, feature criteria, surfaces and architecture. `features/README.md` provides navigation.
- Current retained specifications define the requirements. Historical decision/question identifiers are provenance only; their current rules or unresolved inputs are stated locally. Do not retrieve or rebuild old governance machinery.
- If retained sources conflict or a necessary product value is unset, surface the specific issue before implementing that affected behavior. Continue independent work where possible; do not invent defaults or product approval.
- Preserve existing user changes. No reset, broad cleanup, dependency upgrade, commit, push or deployment unless the task authorizes it.
- Keep OpenAPI, permissions, errors, settings, state transitions and acceptance IDs stable unless an intentional contract change is requested. Generate API descriptions from the real application; do not copy the canonical contract as generated proof.
- Apply `standards/engineering-standards.md`, `definition-of-ready.md` and `definition-of-done.md` to the delivered scope. Specification prose, mocks and skipped tests do not prove an integrated feature.
- Keep active documents current and concise. Git records history; no separate audit/approval register is required.
