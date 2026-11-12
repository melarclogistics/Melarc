import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ModulesContainer } from '@nestjs/core';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startTestApp, type TestApp } from '../../test-support/test-app.js';
import { listBoundOperations } from '../contract/contract-operation.js';
import { listDeclaredRoutes } from './route-inventory.js';

/**
 * R76, the provider-initiating ceiling (SECURITY_DESIGN.md section 14.12; plan S1.27 and the review closeout of 5 November 2026). The
 * ceiling bounds what one session can make the platform send in a minute. It is enforced for a route that **declares** it
 * (`providerInitiating: true`), so the guarantee is only as good as the declarations: an operation that writes a notification envelope
 * and does not declare it spends the platform's provider budget with nothing to bound it. This test is the net under that: it reads
 * what the source writes into the outbox, reads what the routes declare, and requires the two to be the same set.
 *
 * What it reads, and why it is enough: the envelope of the outbox is written in two places only. The TypeScript writer
 * (`OutboxWriter.write`, called with the operation that did the act) and three `SECURITY DEFINER` functions that write it in SQL:
 * `melarc.handshake_envelope`, called with the operation's name, and the envelopes of the two acts of a rider that the writer cannot serve,
 * `melarc.failure_envelope` (`reportPickupFailure`) and `melarc.shortfall_envelope` (`recordCollection`), which fix their operation in their
 * own text and are called from that operation's service and from nowhere else. The TypeScript side is read as a syntax tree, not as text, so a
 * different variable name, a different layout or an envelope built apart from the call does not slip past: a file that imports the writer
 * and calls it in a way the test cannot read is a failure of its own, and so is a file that imports it and is not on the list below. A
 * fourth writer, in either language, fails here and has to be added on purpose, with its operation.
 *
 * What it does not cover, said here and in the plan (OB-S1-65): the credential messages (a setup grant, a recovery link, written by the
 * two stores that enqueue them for the credential delivery worker). They are not envelopes of the outbox and no route of the pickup
 * domain makes them; they are bounded by the recovery bucket (a request) and by the permissions of the administrators who start them,
 * and the credential worker sends nothing but captured messages until a real provider is chosen (G3). The last test pins who may
 * enqueue them, so that a third producer is a decision and not an accident.
 */

const SOURCE_ROOT = join(import.meta.dirname, '..', '..');
const MIGRATIONS = join(SOURCE_ROOT, '..', 'migrations');

interface Source {
  readonly file: string;
  readonly tree: ts.SourceFile;
}

/** The files of the application, parsed: no test, no test support. */
function applicationSources(): Source[] {
  return readdirSync(SOURCE_ROOT, { recursive: true, encoding: 'utf8' })
    .map((file) => file.replaceAll('\\', '/'))
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .filter((file) => !file.startsWith('test-support/'))
    .map((file) => ({
      file,
      tree: ts.createSourceFile(
        file,
        readFileSync(join(SOURCE_ROOT, file), 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      ),
    }));
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => {
    walk(child, visit);
  });
}

/** Whether any node of the tree, the root included, passes the test. */
function someNode(node: ts.Node, test: (node: ts.Node) => boolean): boolean {
  return (
    test(node) ||
    ts.forEachChild(node, (child) => (someNode(child, test) ? true : undefined)) === true
  );
}

/** The string a name stands for in this file: a literal, or a `const` of this file initialised with one. */
function stringOf(tree: ts.SourceFile, expression: ts.Expression): string | undefined {
  if (ts.isStringLiteralLike(expression)) return expression.text;
  if (!ts.isIdentifier(expression)) return undefined;
  let found: string | undefined;
  walk(tree, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === expression.text &&
      node.initializer !== undefined &&
      ts.isStringLiteralLike(node.initializer)
    ) {
      found = node.initializer.text;
    }
  });
  return found;
}

const propertyNamed = (literal: ts.ObjectLiteralExpression, name: string) =>
  literal.properties.find(
    (property): property is ts.PropertyAssignment =>
      ts.isPropertyAssignment(property) &&
      ts.isIdentifier(property.name) &&
      property.name.text === name,
  );

const importsOutboxWriter = (tree: ts.SourceFile): boolean =>
  tree.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text.endsWith('/outbox-writer.js'),
  );

interface EnvelopeWrite {
  readonly file: string;
  /** The operation the envelope names, or why it could not be read. */
  readonly operation: string;
}

/** The envelopes the TypeScript writer is called with: `x.write(h, { eventType, aggregate, operationId, ... })`, in the files that import the writer. */
function typescriptEnvelopeWrites(): EnvelopeWrite[] {
  const found: EnvelopeWrite[] = [];
  for (const { file, tree } of applicationSources()) {
    if (file === 'platform/notifications/outbox-writer.ts' || !importsOutboxWriter(tree)) continue;
    walk(tree, (node) => {
      if (
        !ts.isCallExpression(node) ||
        !ts.isPropertyAccessExpression(node.expression) ||
        node.expression.name.text !== 'write' ||
        node.arguments.length < 2
      ) {
        return;
      }
      const envelope = node.arguments[1];
      if (envelope !== undefined && ts.isObjectLiteralExpression(envelope)) {
        // An audit write in the same file is not an envelope: the envelope names an event type and an aggregate.
        if (
          propertyNamed(envelope, 'eventType') === undefined ||
          propertyNamed(envelope, 'aggregate') === undefined
        )
          return;
        const named = propertyNamed(envelope, 'operationId');
        const operation = named === undefined ? undefined : stringOf(tree, named.initializer);
        found.push({
          file,
          operation: operation ?? '(the operation is not a name this test can read)',
        });
        return;
      }
      found.push({ file, operation: '(an envelope built apart from its call)' });
    });
  }
  return found;
}

/** The migrations as statements, a statement's leading comment lines dropped. */
function migrationStatements(): { readonly file: string; readonly statement: string }[] {
  return readdirSync(MIGRATIONS)
    .filter((file) => file.endsWith('.sql'))
    .toSorted()
    .flatMap((file) =>
      readFileSync(join(MIGRATIONS, file), 'utf8')
        .split('--> statement-breakpoint')
        .map((statement) => ({
          file,
          statement: statement
            .split('\n')
            .filter((line) => !line.trimStart().startsWith('--'))
            .join('\n')
            .trim(),
        })),
    );
}

/** The operations the SQL writer is called for: `PERFORM melarc.handshake_envelope(..., 'x')`. */
function sqlEnvelopeOperations(): string[] {
  const found: string[] = [];
  for (const { statement } of migrationStatements()) {
    if (!/^CREATE (OR REPLACE )?FUNCTION/i.test(statement)) continue;
    for (const call of statement.matchAll(
      /PERFORM\s+melarc\.handshake_envelope\(([^;]*?)\)\s*;/g,
    )) {
      found.push(/,\s*'([A-Za-z]+)'\s*$/.exec(call[1] ?? '')?.[1] ?? '(no operation named)');
    }
  }
  return found;
}

/**
 * The two SQL writers that fix their operation in their own text, with the operation each is for and the one file of the application that may call it: the envelopes of the
 * two acts of a rider that the writer cannot serve (the rider's arm of the outbox asks for a rider scope that a request does not have). Each is called from its operation's
 * service, in the transaction of the act, and from nowhere else.
 */
const FIXED_OPERATION_WRITERS: Readonly<Record<string, { operation: string; caller: string }>> = {
  'melarc.failure_envelope': {
    operation: 'reportPickupFailure',
    caller: 'pickup/pickup-failure.service.ts',
  },
  'melarc.shortfall_envelope': {
    operation: 'recordCollection',
    caller: 'pickup/collection.service.ts',
  },
};

/** The operation a writer function names in its own envelope: the literal that follows the originating principal in its `VALUES`. */
const fixedOperationOf = (statement: string): string | undefined =>
  /melarc\.current_principal_id\(\),\s*'([A-Za-z]+)'/.exec(statement)?.[1];

/** The name of the function a statement creates, or why it is not one. */
const functionNameOf = (statement: string): string =>
  /^CREATE (?:OR REPLACE )?FUNCTION (melarc\.[a-z_]+)\(/i.exec(statement)?.[1] ??
  '(an outbox insert outside a function)';

let running: TestApp | undefined;

beforeAll(async () => {
  running = await startTestApp();
});

afterAll(async () => {
  await running?.stop();
});

/** The operations whose routes declare the ceiling, read from the real application. */
function declaredProviderInitiating(): string[] {
  if (running === undefined) throw new Error('the application did not start');
  const declared = listDeclaredRoutes(running.app).filter(
    (route) => route.authenticated?.providerInitiating === true,
  );
  const bound = listBoundOperations(running.app.get(ModulesContainer, { strict: false }));
  return declared
    .map((route) => {
      const operation = bound.find(
        (each) => each.method === route.method && each.path === route.path,
      );
      return operation?.operationId ?? `(no operation bound to ${route.method} ${route.path})`;
    })
    .toSorted();
}

describe('the provider-initiating ceiling covers every operation that writes a notification envelope', () => {
  // Break caught: a new file that writes the outbox (or imports the writer to), so that an operation sends text with nothing bounding what one session can make it send.
  it('knows every file that uses the outbox writer, and reads every envelope they write', () => {
    const importers = applicationSources()
      .filter(
        ({ file, tree }) =>
          file !== 'platform/notifications/outbox-writer.ts' && importsOutboxWriter(tree),
      )
      .map(({ file }) => file)
      .toSorted();
    expect(importers).toEqual([
      'pickup/pickup-manifest-dispatch.service.ts',
      'pickup/pickup-manifests-providers.ts',
      'pickup/pickup-request-confirmation.service.ts',
      'pickup/pickup-requests-providers.ts',
      'pickup/pickup-stop-skip.service.ts',
    ]);

    const writes = typescriptEnvelopeWrites();
    expect(writes.map((each) => `${each.file}: ${each.operation}`).toSorted()).toEqual([
      'pickup/pickup-manifest-dispatch.service.ts: dispatchManifest',
      'pickup/pickup-request-confirmation.service.ts: confirmPickupRequest',
      'pickup/pickup-stop-skip.service.ts: skipPickupStop',
    ]);
  });

  // Break caught: a further SQL function that inserts into the outbox, whose operation nobody declared, or one of the two that fix their operation changed to name another.
  it('knows the SQL functions that write the outbox, and the operations they are for', () => {
    const writers = migrationStatements().filter((each) =>
      /INSERT\s+INTO\s+(public\.)?"?outbox"?\s*\(/i.test(each.statement),
    );
    expect(writers.length).toBeGreaterThan(0);
    expect(
      writers
        .map((writer) => functionNameOf(writer.statement))
        .filter((name, at, all) => all.indexOf(name) === at)
        .toSorted(),
    ).toEqual([
      'melarc.failure_envelope',
      'melarc.handshake_envelope',
      'melarc.shortfall_envelope',
    ]);
    for (const [name, expected] of Object.entries(FIXED_OPERATION_WRITERS)) {
      const own = writers.filter((writer) => functionNameOf(writer.statement) === name);
      expect(own.length, name).toBe(1);
      expect(fixedOperationOf(own[0]?.statement ?? ''), name).toBe(expected.operation);
    }

    expect(
      sqlEnvelopeOperations()
        .filter((operation, at, all) => all.indexOf(operation) === at)
        .toSorted(),
    ).toEqual(['initiateHandshake', 'requestSmsHandshakeFallback']);
  });

  // Break caught: an operation that writes an envelope and does not declare the ceiling (the hole this test exists for), or a declaration left on an operation that no
  // longer writes one.
  it('declares the ceiling on exactly those operations', () => {
    const fixed = migrationStatements()
      .filter((each) => /INSERT\s+INTO\s+(public\.)?"?outbox"?\s*\(/i.test(each.statement))
      .filter((each) => functionNameOf(each.statement) in FIXED_OPERATION_WRITERS)
      .map((each) => fixedOperationOf(each.statement) ?? '(no operation named)');
    const writes = [
      ...typescriptEnvelopeWrites().map((each) => each.operation),
      ...sqlEnvelopeOperations(),
      ...fixed,
    ]
      .filter((operation, at, all) => all.indexOf(operation) === at)
      .toSorted();

    expect(declaredProviderInitiating()).toEqual(writes);
    expect(writes).toEqual([
      'confirmPickupRequest',
      'dispatchManifest',
      'initiateHandshake',
      'recordCollection',
      'reportPickupFailure',
      'requestSmsHandshakeFallback',
      'skipPickupStop',
    ]);
  });

  // Break caught: a call of one of the two envelopes of a rider's acts from another operation, whose envelope would then say the failure or the short count of an act that is not
  // one (the functions refuse a stop the caller did not just fail or count, but the net for the declaration reads callers), or the call dropped from its own operation.
  it('calls the envelopes of a rider’s acts from the service of the operation each is for, and from nowhere else', () => {
    for (const [name, { caller }] of Object.entries(FIXED_OPERATION_WRITERS)) {
      const callers = applicationSources()
        .filter(({ tree }) => tree.getFullText().includes(`${name}(`))
        .map(({ file }) => file);
      expect(callers, name).toEqual([caller]);
    }
  });
});

describe('the credential messages, which the ceiling does not cover, have two producers and no third', () => {
  // Break caught: a new producer of credential messages (a text or an e-mail to a person, queued for the credential worker) added without a decision about what bounds it. Today the
  // two stores are reached by the anonymous recovery requests (bounded by their bucket) and by administrators' operations (permissions and the session's bucket), and the credential
  // worker sends only captured messages: it refuses a real provider (G3). When one is chosen, these producers declare the ceiling or are given one of their own.
  it('are queued by the recovery store and the setup grant store only', () => {
    const producers = applicationSources()
      .filter(({ tree }) =>
        someNode(
          tree,
          (node) =>
            ts.isCallExpression(node) &&
            ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === 'enqueue' &&
            node.arguments.length >= 2,
        ),
      )
      .map(({ file }) => file)
      .toSorted();

    expect(producers).toEqual([
      'platform/auth/recovery/recovery-request-store.ts',
      'platform/auth/setup-grants/setup-grant-store.ts',
    ]);
  });
});
