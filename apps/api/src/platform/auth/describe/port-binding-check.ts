import { Scope, type Provider } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';

import type { PortProvider } from '../ports/port-bindings.js';
import { PORTS } from '../ports/port-registry.js';
import {
  DescribeAdapterBoundError,
  isDescribeAdapter,
  isDescribeAdapterClass,
} from './describe-adapter.js';

const NAMES = new Map<symbol, string>(PORTS.map((entry) => [entry.token, entry.name]));
const nameOf = (token: symbol): string => NAMES.get(token) ?? String(token.description);

/** The token the check is bound under. Private to the composition root: nothing asks for it and the root does not export it. */
export const PORT_BINDING_CHECK = Symbol('PORT_BINDING_CHECK');

export type Composition = 'describe' | 'runtime';

/** The ports whose binding, as written, is an inert describe adapter: a class, a ready instance, or an alias of a class. */
function writtenAsDescribeAdapter(providers: readonly PortProvider[]): string[] {
  return providers
    .filter((provider) => {
      if ('useClass' in provider) return isDescribeAdapterClass(provider.useClass);
      if ('useValue' in provider) return isDescribeAdapter(provider.useValue);
      if ('useExisting' in provider) return isDescribeAdapterClass(provider.useExisting);
      return false;
    })
    .map((provider) => nameOf(provider.provide));
}

/**
 * Refuses, before the container is built, a binding that is written as an inert describe adapter: `useClass` of one or of a
 * class that extends one, `useValue` of an instance, `useExisting` of such a class. This is the cheap half, for the runtime
 * composition; a factory, or an alias of a token another module provides, says nothing until it has run, and
 * `portBindingCheck` is the other half.
 */
export function assertNoDescribeAdapterWritten(providers: readonly PortProvider[]): void {
  const ports = writtenAsDescribeAdapter(providers);
  if (ports.length > 0) throw new DescribeAdapterBoundError(ports);
}

/**
 * What the container found wrong with the port bindings once it had built them. Both lists name ports and nothing else, and
 * either may be empty: a scoped dependency of one port does not hide an inert adapter behind another.
 */
export class PortBindingError extends Error {
  constructor(
    /** Ports that are not application singletons: a request or transient lifetime of their own, or a dependency that has one. */
    readonly notSingletons: readonly string[],
    /** Ports that resolved to an inert describe adapter in the runtime composition. */
    readonly describeAdapters: readonly string[],
  ) {
    super(
      [
        notSingletons.length === 0
          ? undefined
          : `These ports are not bound as application singletons (a request or transient lifetime, or a dependency that has one): ${notSingletons.join(', ')}.`,
        describeAdapters.length === 0
          ? undefined
          : `The runtime composition binds an inert describe adapter to: ${describeAdapters.join(', ')}; bind the adapter that does the work, or select the describe composition in a local run.`,
      ]
        .filter((part) => part !== undefined)
        .join(' '),
    );
    this.name = 'PortBindingError';
  }
}

/**
 * A provider that, when the application initialises and before it listens, asks the container about each bound port and
 * refuses what it should not hold. Two questions, both answered by Nest's own bookkeeping and not by reading the bindings:
 *
 * - **Is the port an application singleton?** Every port binding must be (`portProviders`). The explicit `scope` field is only
 *   one way to get it wrong: a class can carry a request scope in its metadata, an alias or a factory can reach a request-scoped
 *   provider, and a constructor can inject one, which makes a port request-scoped by propagation. The instance wrapper's scope
 *   and `isDependencyTreeStatic()` cover all of them. A port that cannot be found at all fails the same way.
 * - **In the runtime composition, did it resolve to an inert describe adapter?** Whichever way it was bound: a class, a value,
 *   the result of a factory (awaited), or an alias. Only a port that is a singleton has an instance to look at.
 *
 * The check injects the framework's modules container and **no port**, so nothing a port depends on can make the check itself
 * request-scoped and keep it from running. It is a factory provider whose product carries `onModuleInit`, which the container
 * calls for any provider instance; `main.ts` already ends a start that fails to initialise with one log line and exit code 1.
 *
 * A singleton may still depend on a transient provider: it stays one object for the whole application. This is a wiring check
 * against a mis-built composition root, not a defence against code that is already running inside the application.
 */
export function portBindingCheck(
  providers: readonly PortProvider[],
  composition: Composition,
): Provider | undefined {
  if (providers.length === 0) return undefined;
  const tokens = providers.map((provider) => provider.provide);
  return {
    provide: PORT_BINDING_CHECK,
    inject: [ModulesContainer],
    useFactory: (modules: ModulesContainer) => ({
      onModuleInit(): void {
        const notSingletons: string[] = [];
        const describeAdapters: string[] = [];
        for (const token of tokens) {
          const wrapper = [...modules.values()]
            .map((module) => module.providers.get(token))
            .find((found) => found !== undefined);
          // A provider that never named a lifetime has no scope at all, which is the default one.
          if (
            wrapper === undefined ||
            (wrapper.scope !== undefined && wrapper.scope !== Scope.DEFAULT) ||
            !wrapper.isDependencyTreeStatic()
          ) {
            notSingletons.push(nameOf(token));
          } else if (composition === 'runtime' && isDescribeAdapter(wrapper.instance)) {
            describeAdapters.push(nameOf(token));
          }
        }
        if (notSingletons.length + describeAdapters.length > 0) {
          throw new PortBindingError(notSingletons, describeAdapters);
        }
      },
    }),
  };
}
