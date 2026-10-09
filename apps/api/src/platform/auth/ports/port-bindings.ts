import type {
  ClassProvider,
  ExistingProvider,
  FactoryProvider,
  Provider,
  ValueProvider,
} from '@nestjs/common';

import { PORTS, type PortRegistryEntry, type PortTypes } from './port-registry.js';

type Unkeyed<P> = Omit<P, 'provide'>;

/** How an adapter is supplied for a port: a class, a ready value, a factory, or another provider already in the graph. */
export type PortBinding<T> =
  | Unkeyed<ClassProvider<T>>
  | Unkeyed<ValueProvider<T>>
  | Unkeyed<FactoryProvider<T>>
  | Unkeyed<ExistingProvider<T>>;

/**
 * What the composition root binds: a binding for a port, keyed by the port's name with a lower-case first letter. A key that
 * is not a port does not compile, and `portProviders` refuses one that slipped past the compiler. Nothing is bound until a
 * task adds an adapter; the root passes no binding today.
 */
export type PortBindings = {
  readonly [K in keyof PortTypes as Uncapitalize<K>]?: PortBinding<PortTypes[K]>;
};

export type PortProvider = Extract<Provider, { provide: unknown }> & { readonly provide: symbol };

// What each kind of binding takes, as Nest's own provider types define it: a class takes a scope and a durable flag but no
// `inject`; a factory takes `inject`; a value and an existing provider take nothing else. `provide` is never taken.
const SHAPES = {
  useClass: {
    keys: ['useClass', 'scope', 'durable'],
    valid: (value: unknown) => typeof value === 'function',
    said: 'a useClass that is not a class',
  },
  useValue: {
    keys: ['useValue'],
    valid: (value: unknown) => typeof value === 'object' && value !== null,
    said: 'a useValue that is not an object',
  },
  useFactory: {
    keys: ['useFactory', 'inject', 'scope', 'durable'],
    valid: (value: unknown) => typeof value === 'function',
    said: 'a useFactory that is not a function',
  },
  useExisting: {
    keys: ['useExisting'],
    valid: (value: unknown) =>
      typeof value === 'string' || typeof value === 'symbol' || typeof value === 'function',
    said: 'a useExisting that is not a token',
  },
} as const;
type Kind = keyof typeof SHAPES;
const KINDS = Object.keys(SHAPES) as Kind[];

const isPlainRecord = (value: unknown): value is Record<PropertyKey, unknown> => {
  if (typeof value !== 'object' || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
const lowerFirst = (name: string): string => name.charAt(0).toLowerCase() + name.slice(1);
const BY_KEY = new Map<string, PortRegistryEntry>(
  PORTS.map((entry) => [lowerFirst(entry.name), entry]),
);

/**
 * The Nest providers that bind each adapter in `bindings` to its port's token. Only the composition root calls this
 * (`src/app.module.ts`): a platform service asks for a token and never imports an adapter.
 *
 * The token is the port's own and is set last, from the registry. A binding that gives a `provide` of its own is refused, not
 * overwritten, because a root that quietly bound one port's adapter to another port's token would be mis-wired without a sign.
 * What arrives here may not be what the compiler promised (a value from untyped code), so every binding is checked as data:
 * a plain object, exactly one kind, only the properties that kind takes, and a value of the right sort for it.
 */
export function portProviders(bindings: PortBindings = {}): PortProvider[] {
  const providers: PortProvider[] = [];
  const given: [string, unknown][] = Object.entries(bindings);
  for (const [key, binding] of given) {
    const entry = BY_KEY.get(key);
    if (entry === undefined) {
      throw new Error(`"${key}" is not a port. The ports are: ${[...BY_KEY.keys()].join(', ')}.`);
    }
    if (binding === undefined) continue;
    const where = `The binding for the port ${entry.name}`;
    if (!isPlainRecord(binding)) {
      throw new Error(
        `${where} must be an object that gives exactly one of useClass, useValue, useFactory or useExisting.`,
      );
    }
    if (Object.hasOwn(binding, 'provide')) {
      throw new Error(
        `${where} must not give provide: the token is the port's own and the root does not accept another.`,
      );
    }
    const kinds = KINDS.filter((kind) => Object.hasOwn(binding, kind));
    const [kind] = kinds;
    if (kind === undefined || kinds.length !== 1) {
      throw new Error(
        `${where} must give exactly one of useClass, useValue, useFactory or useExisting.`,
      );
    }
    const shape = SHAPES[kind];
    const allowed: readonly PropertyKey[] = shape.keys;
    for (const property of Reflect.ownKeys(binding)) {
      if (!allowed.includes(property)) {
        throw new Error(
          `${where} gives "${String(property)}", which a ${kind} binding does not take.`,
        );
      }
    }
    if (!shape.valid(binding[kind])) throw new Error(`${where} gives ${shape.said}.`);
    if (Object.hasOwn(binding, 'inject') && !Array.isArray(binding.inject)) {
      throw new Error(`${where} gives an inject that is not a list.`);
    }
    providers.push({ ...binding, provide: entry.token } as PortProvider);
  }
  return providers;
}
