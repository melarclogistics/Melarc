import dns from 'node:dns';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { PORTS, type PortBindings } from '../ports/index.js';
import { DescribeAdapter, isDescribeAdapter, isDescribeAdapterClass } from './describe-adapter.js';
import { DescribeAdapterInvokedError } from './describe-adapter-error.js';
import { DESCRIBE_PORT_BINDINGS } from './describe-ports.adapter.js';

const lowerFirst = (name: string): string => name.charAt(0).toLowerCase() + name.slice(1);

/** The class the describe composition binds to a port. */
function adapterClassOf(name: string): new () => object {
  const binding = DESCRIBE_PORT_BINDINGS[lowerFirst(name) as keyof PortBindings];
  if (binding === undefined || !('useClass' in binding)) {
    throw new Error(`The describe composition binds no class to ${name}.`);
  }
  return binding.useClass;
}

/** Calls an operation of an adapter with no arguments, as a caller that merely used the port would. */
function invoke(adapter: object, operation: string): unknown {
  const method: unknown = Reflect.get(adapter, operation);
  if (typeof method !== 'function') throw new Error(`There is no ${operation} to invoke.`);
  return Reflect.apply(method, adapter, []);
}

const operationsOf = (name: string): string[] => {
  const entry = PORTS.find((candidate) => candidate.name === name);
  if (entry === undefined) throw new Error(`No port ${name}`);
  return Object.keys(entry.descriptor.operations);
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the describe adapters (S0.2)', () => {
  // Break caught: a port with no adapter in the describe composition, so the tools that describe the application cannot resolve it.
  it('bind a class to every port, and to nothing else', () => {
    expect(Object.keys(DESCRIBE_PORT_BINDINGS).toSorted()).toEqual(
      PORTS.map((entry) => lowerFirst(entry.name)).toSorted(),
    );
  });

  // Break caught: an operation added to a port's descriptor without the describe adapter, or a method the port does not have,
  // so the adapter and the port drift apart without the compiler or a test saying so.
  it.each(PORTS.map((entry) => entry.name))(
    'has exactly the operations of the %s descriptor',
    (name) => {
      const methods = Object.getOwnPropertyNames(adapterClassOf(name).prototype)
        .filter((method) => method !== 'constructor')
        .toSorted();

      expect(methods).toEqual(operationsOf(name).toSorted());
    },
  );

  // The exit condition of S0.2: a test invokes every describe adapter and sees the clear failure with no socket opened.
  it.each(
    PORTS.flatMap((entry) =>
      operationsOf(entry.name).map((operation) => [entry.name, operation] as const),
    ),
  )('fails clearly, by name, when %s.%s is invoked', (name, operation) => {
    const adapter = new (adapterClassOf(name))();
    let thrown: unknown;
    try {
      invoke(adapter, operation);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DescribeAdapterInvokedError);
    expect(thrown).toBeInstanceOf(Error);
    const failure = thrown as DescribeAdapterInvokedError;
    expect(failure.name).toBe('DescribeAdapterInvokedError');
    expect(failure.port).toBe(name);
    expect(failure.operation).toBe(operation);
    expect(failure.message).toContain(`${name}.${operation}`);
  });

  // Break caught: a describe adapter that opens a socket, resolves a name or reaches a provider when it is invoked or built.
  it('opens no socket, resolves no name and makes no request, whatever is invoked', () => {
    const reached = [
      vi.spyOn(net.Socket.prototype, 'connect'),
      vi.spyOn(net.Server.prototype, 'listen'),
      vi.spyOn(dns, 'lookup'),
      vi.spyOn(tls, 'connect'),
      vi.spyOn(http, 'request'),
      vi.spyOn(https, 'request'),
    ];

    for (const entry of PORTS) {
      const adapter = new (adapterClassOf(entry.name))();
      for (const operation of operationsOf(entry.name)) {
        expect(() => invoke(adapter, operation)).toThrow(DescribeAdapterInvokedError);
      }
    }

    for (const spy of reached) expect(spy).not.toHaveBeenCalled();
  });

  // Break caught: an adapter that holds state, a configuration or a secret it could read, or that is built from the environment.
  it('hold nothing: no property, no configuration, no secret', () => {
    for (const entry of PORTS) {
      const adapter = new (adapterClassOf(entry.name))();

      expect(Object.getOwnPropertyNames(adapter)).toEqual([]);
      expect(Object.getOwnPropertySymbols(adapter)).toEqual([]);
    }
  });

  // Break caught: the adapter file importing anything that could connect, read a file or read the environment.
  it('import nothing but the ports and their own error, and never read the environment', () => {
    const source = readFileSync(new URL('./describe-ports.adapter.ts', import.meta.url), 'utf8');
    const specifiers = [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]);

    expect(specifiers.toSorted()).toEqual([
      '../ports/index.js',
      './describe-adapter-error.js',
      './describe-adapter.js',
    ]);
    expect(source).not.toMatch(/process\.env|node:|require\(|import\(/);
  });

  // Break caught: an adapter outside the base class, which the runtime composition could not recognise as inert and would accept.
  it.each(PORTS.map((entry) => entry.name))(
    'has the %s adapter extend the describe base',
    (name) => {
      const adapter = new (adapterClassOf(name))();

      expect(adapter).toBeInstanceOf(DescribeAdapter);
      expect(isDescribeAdapter(adapter)).toBe(true);
      expect(isDescribeAdapterClass(adapterClassOf(name))).toBe(true);
    },
  );

  it('recognises a describe adapter only by the base, and nothing else', () => {
    class Unrelated {
      readonly kind = 'unrelated';
    }
    class Extends extends adapterClassOf('Clock') {}

    const neither: [label: string, value: unknown][] = [
      ['undefined', undefined],
      ['null', null],
      ['the name of an adapter', 'DescribeClock'],
      ['a number', 7],
      ['a plain object', {}],
      ['an array', []],
      ['an unrelated instance', new Unrelated()],
      ['an unrelated class', Unrelated],
    ];
    for (const [label, value] of neither) {
      expect(isDescribeAdapter(value), label).toBe(false);
      expect(isDescribeAdapterClass(value), label).toBe(false);
    }
    expect(isDescribeAdapter(new Extends())).toBe(true);
    expect(isDescribeAdapterClass(Extends)).toBe(true);
    expect(isDescribeAdapterClass(DescribeAdapter)).toBe(true);
  });

  it('say where they are bound, in terms an operator can act on', () => {
    const failure = new DescribeAdapterInvokedError('Hasher', 'hash');

    expect(failure.message).toMatch(/describe adapter for the Hasher port cannot run Hasher\.hash/);
    expect(failure.message).toMatch(/never connects, delivers or reads a secret/);
  });
});
