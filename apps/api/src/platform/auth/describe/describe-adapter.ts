/**
 * What every inert describe adapter is. The describe composition binds one of them to each port so that the application can be
 * built and described with no database, provider or key (`describe-ports.adapter.ts`). The base holds nothing and does
 * nothing: it exists so that the composition root can recognise a describe adapter by what it is, a class that extends it, and
 * not by a list of names that a renamed or wrapped class would escape.
 *
 * It lives apart from the adapters so that the composition root can ask the question without importing an adapter.
 */
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- a marker: its only use is `instanceof`, and a member would put a property on every adapter, which must hold nothing
export abstract class DescribeAdapter {}

/** An instance of a describe adapter, or of any class that extends one. */
export function isDescribeAdapter(value: unknown): boolean {
  return value instanceof DescribeAdapter;
}

/** A describe adapter class, or a class that extends one. */
export function isDescribeAdapterClass(value: unknown): boolean {
  if (typeof value !== 'function') return false;
  const prototype: unknown = Reflect.get(value, 'prototype');
  return value === DescribeAdapter || prototype instanceof DescribeAdapter;
}

/**
 * A runtime composition that was given an inert adapter. The describe composition is for a local run and for the tools that
 * describe the application, and an adapter in it fails every operation by design; in the runtime composition one would answer
 * a real request with that failure, or, worse, be taken for the real adapter. The message names ports, never a value.
 */
export class DescribeAdapterBoundError extends Error {
  constructor(readonly ports: readonly string[]) {
    super(
      `The runtime composition binds an inert describe adapter to: ${ports.join(', ')}. A describe adapter exists only so that the application can describe itself; bind the adapter that does the work, or select the describe composition in a local run.`,
    );
    this.name = 'DescribeAdapterBoundError';
  }
}
