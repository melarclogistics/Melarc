import type { OpenAPIObject } from '@nestjs/swagger';

/** A schema as the description of an operation holds it (not a reference to one). */
export type DescribedSchema = Exclude<
  NonNullable<NonNullable<OpenAPIObject['components']>['schemas']>[string],
  { $ref: string }
>;

/**
 * A schema written in code, typed as an operation's description takes it. The decorators of the description want mutable members and a
 * single `type` where OpenAPI 3.1 allows a list (`['string', 'null']`) and `unevaluatedProperties`, which the package's types predate:
 * this is the one place that says the written shape is what is meant. The conformance check compares what it describes with the
 * contract's own, so a shape that is wrong is a finding, whatever its type says.
 */
export const described = (schema: object): DescribedSchema => schema;
