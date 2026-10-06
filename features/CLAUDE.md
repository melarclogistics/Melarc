# Feature specifications (`features/`)

One feature is documented once, by business domain, in `<domain>/<feature>.md`; the [index](README.md) lists them all. The [contracts](../contracts/CLAUDE.md) own entities, states, permissions, settings, errors and operations; a feature owns the workflow behavior.

## Rules

- Read only the feature you are implementing and what it names as governing requirements and dependencies.
- The acceptance criteria are the unit of "done": implement against their IDs and keep the IDs stable. A feature is not implemented until its criteria are met by real integrated behavior ([definition of done](../standards/definition-of-done.md)); a slice selects the criteria in scope ([definition of ready](../standards/definition-of-ready.md)).
- To add or change a feature, copy [_TEMPLATE.md](_TEMPLATE.md) into the domain folder, adjust the relative links, add the feature to the index, and update the affected contracts in the same change. Cover normal, alternative, failure, cancellation, retry and terminal behavior, or say why a path does not apply.
