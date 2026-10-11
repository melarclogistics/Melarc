import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PORTS } from './platform/auth/ports/index.js';
import { CAPABILITY_ACCESS } from './platform/database/capability-access.js';
import { findAdvisoryLockViolations } from './test-support/advisory-locks.js';
import { findOwnClockViolations } from './test-support/budget-time.js';
import {
  findCapabilityOpenerViolations,
  findDatabaseDoorViolations,
  findScopeProbeWriterViolations,
} from './test-support/database-door.js';
import {
  findPlatformBoundaryViolations,
  type SourceFile,
} from './test-support/platform-boundary.js';
import {
  PORTS_DIRECTORY,
  findAdapterImportViolations,
  findPortDescriptorProblems,
  findPortImplementationViolations,
  findPortSourceProblems,
  findTransactionCategoryProblems,
  portConstant,
  portFileName,
  sourceModelOf,
  type DescribedPort,
  type SourceModel,
} from './test-support/port-placement.js';

/**
 * The ports `platform/auth` reaches domain data and I/O through (SOLUTION_ARCHITECTURE.md §5; plan task S0.1). The list is
 * written out here on purpose: removing a port from the registry must fail this test, not shrink what it checks.
 */
const PORT_NAMES = [
  'Clock',
  'Hasher',
  'SecretCipher',
  'TokenService',
  'TotpVerifier',
  'RateLimiter',
  'HashAdmission',
  'IdempotencyStore',
  'AuditWriter',
  'SessionStore',
  'IdentityDirectory',
  'UnitOfWork',
  'DeliveryQueue',
  'DeliveryProvider',
  'AttestationVerifier',
  'Metrics',
] as const;

/**
 * The files in `platform/` allowed to implement a port, each added by the task that builds that adapter. S0.1 added none. S0.2
 * added the one file of inert describe adapters, which `adapterRefusals` keeps out of any environment but a local run. S0.3 adds
 * the four cryptographic adapters (`Hasher`, `SecretCipher`, `TokenService`, `TotpVerifier`), one file each. S0.6 adds the
 * production `Clock`, the first adapter the composition root binds itself. S0.11 adds the audit writer over PostgreSQL, S0.12 the idempotency store and S0.14 the two rate limiters (the authoritative one
 * and the in-memory one that unit tests use and a deployed environment refuses), S0.15 the bounded metrics registry and S0.16 the bounded hash admission.
 * S0.17 adds the durable delivery queue over PostgreSQL. S0.18 adds the two delivery providers of the worker: the capture adapter and
 * the allow-list that stands in front of a real provider (no real provider is built). The next adapter, a real one, is added here by
 * the task that builds it, and a review sees the line.
 */
const ALLOWED_PORT_IMPLEMENTATIONS: readonly string[] = [
  'platform/audit/postgres.audit-writer.adapter.ts',
  'platform/auth/clock/system.clock.adapter.ts',
  'platform/auth/crypto/aes-gcm.secret-cipher.adapter.ts',
  'platform/auth/crypto/argon2.hasher.adapter.ts',
  'platform/auth/crypto/rfc6238.totp-verifier.adapter.ts',
  'platform/auth/crypto/sha256.token-service.adapter.ts',
  'platform/auth/describe/describe-ports.adapter.ts',
  'platform/delivery/postgres.delivery-queue.adapter.ts',
  'platform/delivery/worker/allow-listed.delivery-provider.adapter.ts',
  'platform/delivery/worker/capture.delivery-provider.adapter.ts',
  'platform/idempotency/postgres.idempotency-store.adapter.ts',
  'platform/limiter/bounded.hash-admission.adapter.ts',
  'platform/limiter/in-memory.rate-limiter.adapter.ts',
  'platform/limiter/postgres.rate-limiter.adapter.ts',
  'platform/metrics/bounded.metrics.adapter.ts',
];

/** The port each real adapter above implements, so that a test can say what the checker must see in each file. */
const ADAPTED_PORTS: readonly (readonly [file: string, port: string])[] = [
  ['platform/audit/postgres.audit-writer.adapter.ts', 'AuditWriter'],
  ['platform/auth/clock/system.clock.adapter.ts', 'Clock'],
  ['platform/auth/crypto/aes-gcm.secret-cipher.adapter.ts', 'SecretCipher'],
  ['platform/auth/crypto/argon2.hasher.adapter.ts', 'Hasher'],
  ['platform/auth/crypto/rfc6238.totp-verifier.adapter.ts', 'TotpVerifier'],
  ['platform/auth/crypto/sha256.token-service.adapter.ts', 'TokenService'],
  ['platform/delivery/postgres.delivery-queue.adapter.ts', 'DeliveryQueue'],
  ['platform/delivery/worker/allow-listed.delivery-provider.adapter.ts', 'DeliveryProvider'],
  ['platform/delivery/worker/capture.delivery-provider.adapter.ts', 'DeliveryProvider'],
  ['platform/idempotency/postgres.idempotency-store.adapter.ts', 'IdempotencyStore'],
  ['platform/limiter/bounded.hash-admission.adapter.ts', 'HashAdmission'],
  ['platform/limiter/in-memory.rate-limiter.adapter.ts', 'RateLimiter'],
  ['platform/limiter/postgres.rate-limiter.adapter.ts', 'RateLimiter'],
  ['platform/metrics/bounded.metrics.adapter.ts', 'Metrics'],
];
const DESCRIBE_ADAPTERS = 'platform/auth/describe/describe-ports.adapter.ts';

/**
 * The composition root: the files that may import an adapter, because they are where an adapter is bound to its token. It is a
 * list, not a pattern. A file is not the composition root for being a module; a task that adds an adapter lists the one module
 * file that provides it here, so every widening of this list is a reviewed line of this file.
 */
const COMPOSITION_ROOT: readonly string[] = [
  'app.module.ts',
  'delivery-worker-runtime.ts',
  'tools/seed/seed-runtime.ts',
];

/**
 * The only operations described as `independent`: safe local work, in process, with no database connection, no I/O and no lock.
 * An operation that opens its own transaction or calls out is `outside-any-transaction`, whatever it takes none of the caller's
 * locks for. A task that makes a port operation local adds it here, so the claim is reviewed.
 */
const LOCAL_OPERATIONS: readonly string[] = [
  'Clock.now',
  'Clock.monotonicMilliseconds',
  'SecretCipher.seal',
  'SecretCipher.open',
  'TokenService.issue',
  'TokenService.hash',
  'TokenService.matches',
  'TotpVerifier.newSeed',
  'TotpVerifier.verify',
  'Metrics.increment',
  'Metrics.observe',
];

const sourceRoot = import.meta.dirname;
function sourceFiles(): SourceFile[] {
  return readdirSync(sourceRoot, { recursive: true, encoding: 'utf8' })
    .map((path) => path.replaceAll('\\', '/'))
    .filter((path) => path.endsWith('.ts'))
    .map((path) => ({ path, text: readFileSync(join(sourceRoot, path), 'utf8') }));
}

let real: SourceModel | undefined;
/** The whole source tree as the compiler sees it, built once: parsing it is the slow part of the checks below. */
const realModel = (): SourceModel => (real ??= sourceModelOf(sourceFiles()));

describe('findPlatformBoundaryViolations', () => {
  const file = (path: string, text: string): SourceFile => ({ path, text });

  // Break caught: a rule so strict that ordinary platform code, or any package import, is flagged.
  // Climbing "../" from inside platform/ to a sibling platform folder is fine; only leaving platform/ is not.
  it('accepts imports of packages and of other platform files', () => {
    const files = [
      file(
        'platform/health/health.controller.ts',
        [
          "import { Controller } from '@nestjs/common';",
          "import type { Logger } from 'pino';",
          "import { LOGGER } from '../platform.tokens.js';",
          "import { ReadinessRegistry } from './readiness.registry.js';",
          "import { TechnicalEndpoint } from '../routes/access-declaration.js';",
        ].join('\n'),
      ),
    ];
    expect(findPlatformBoundaryViolations(files)).toEqual([]);
  });

  // Break caught: platform code reaching up into the composition root or sideways into a domain module.
  // The file sits at src/platform/auth/session.ts, so "../../" is src/ and "../" is still platform/.
  it.each([
    [
      'the composition root',
      "import { AppModule } from '../../app.module.js';",
      '../../app.module.js',
    ],
    [
      'a domain module',
      "import { Pickup } from '../../pickup/requests/create.js';",
      '../../pickup/requests/create.js',
    ],
    ['a re-export', "export * from '../../pickup/index.js';", '../../pickup/index.js'],
    ['a dynamic import', "const m = await import('../../hub/intake.js');", '../../hub/intake.js'],
    ['a side-effect import', "import '../../pickup/register.js';", '../../pickup/register.js'],
    [
      'a type import',
      "import type { Order } from '../../pricing/order.js';",
      '../../pricing/order.js',
    ],
  ])('flags %s', (_label, line, specifier) => {
    const violations = findPlatformBoundaryViolations([file('platform/auth/session.ts', line)]);
    expect(violations).toEqual([
      `platform/auth/session.ts imports ${specifier}, which is outside platform/`,
    ]);
  });

  // Break caught: the rule applied to tests, which legitimately build the whole application.
  it('does not apply to test files or to code outside platform/', () => {
    const files = [
      file('platform/health/health.test.ts', "import { createApp } from '../../create-app.js';"),
      file('main.ts', "import { AppModule } from './app.module.js';"),
      file('pickup/pickup.module.ts', "import { LOGGER } from '../platform/platform.tokens.js';"),
    ];
    expect(findPlatformBoundaryViolations(files)).toEqual([]);
  });
});

describe('the platform directory', () => {
  // Break caught: a platform file depending on a domain module, which would let authorization or audit
  // be bypassed per feature. This is the dependency direction SOLUTION_ARCHITECTURE.md §5 requires.
  it('depends on nothing outside itself', () => {
    const sourceRoot = import.meta.dirname;
    const files: SourceFile[] = readdirSync(sourceRoot, { recursive: true, encoding: 'utf8' })
      .map((path) => path.replaceAll('\\', '/'))
      .filter((path) => path.startsWith('platform/') && path.endsWith('.ts'))
      .map((path) => ({ path, text: readFileSync(join(sourceRoot, path), 'utf8') }));

    expect(files.length).toBeGreaterThan(10);
    expect(findPlatformBoundaryViolations(files)).toEqual([]);
  });

  // Break caught (S0.1 a): a port, or the code that will implement one, reaching into a domain module. The existing rule
  // already covers every platform file; this pins that it covers the folder the ports live in.
  it('flags a port that imports a domain module', () => {
    const violations = findPlatformBoundaryViolations([
      {
        path: 'platform/auth/ports/session-store.port.ts',
        text: "import type { Staff } from '../../../staff/staff.entity.js';",
      },
    ]);

    expect(violations).toEqual([
      'platform/auth/ports/session-store.port.ts imports ../../../staff/staff.entity.js, which is outside platform/',
    ]);
  });
});

describe('the ports of platform/auth (S0.1)', () => {
  const file = (path: string, text: string): SourceFile => ({ path, text });
  const complete = (name: string): SourceFile => {
    const constant = portConstant(name);
    return file(
      `${PORTS_DIRECTORY}/${portFileName(name)}`,
      [
        `export interface ${name} { readonly ok: true }`,
        `export const ${constant} = Symbol('${constant}');`,
        `export const ${constant}_DESCRIPTOR: PortDescriptor<${name}> = { port: '${name}' };`,
      ].join('\n'),
    );
  };

  it('derives the file and the constants of a port from its name', () => {
    expect(portFileName('SecretCipher')).toBe('secret-cipher.port.ts');
    expect(portConstant('SecretCipher')).toBe('SECRET_CIPHER');
    expect(portFileName('Clock')).toBe('clock.port.ts');
    expect(portConstant('TotpVerifier')).toBe('TOTP_VERIFIER');
  });

  describe('every port has an interface, a token and a complete descriptor', () => {
    // Break caught: a port dropped from the registry, or one added to it without being written down here.
    it('registers exactly the listed ports, in order, each with its own token', () => {
      expect(PORTS.map((entry) => entry.name)).toEqual([...PORT_NAMES]);
      expect(new Set(PORTS.map((entry) => entry.token)).size).toBe(PORT_NAMES.length);
    });

    it('has a descriptor with no gap for every registered port', () => {
      expect(findPortDescriptorProblems(PORTS, PORT_NAMES)).toEqual([]);
    });

    it('declares the interface, the token and the descriptor of every port in its own file', () => {
      const inPorts = sourceFiles().filter((source) =>
        source.path.startsWith(`${PORTS_DIRECTORY}/`),
      );

      expect(inPorts.length).toBeGreaterThanOrEqual(PORT_NAMES.length);
      expect(findPortSourceProblems(inPorts, PORT_NAMES)).toEqual([]);
    });

    // Break caught (S0.1 b): a port with no interface, no token or no descriptor passing because the check only counted files.
    it('accepts a complete port', () => {
      expect(findPortSourceProblems([complete('Clock')], ['Clock'])).toEqual([]);
    });

    it.each([
      [
        'has no file',
        [],
        'platform/auth/ports/clock.port.ts is missing: the port Clock has no file',
      ],
      [
        'does not export its interface',
        [
          file(
            'platform/auth/ports/clock.port.ts',
            "interface Clock {}\nexport const CLOCK = Symbol('CLOCK');\nexport const CLOCK_DESCRIPTOR: PortDescriptor<Clock> = {};",
          ),
        ],
        'platform/auth/ports/clock.port.ts does not export the interface Clock',
      ],
      [
        'has no token',
        [
          file(
            'platform/auth/ports/clock.port.ts',
            'export interface Clock {}\nexport const CLOCK_DESCRIPTOR: PortDescriptor<Clock> = {};',
          ),
        ],
        "platform/auth/ports/clock.port.ts does not export the token CLOCK, which must be Symbol('CLOCK')",
      ],
      [
        'has a token that is not a symbol',
        [
          file(
            'platform/auth/ports/clock.port.ts',
            "export interface Clock {}\nexport const CLOCK = 'CLOCK';\nexport const CLOCK_DESCRIPTOR: PortDescriptor<Clock> = {};",
          ),
        ],
        "platform/auth/ports/clock.port.ts does not export the token CLOCK, which must be Symbol('CLOCK')",
      ],
      [
        'has no descriptor',
        [
          file(
            'platform/auth/ports/clock.port.ts',
            "export interface Clock {}\nexport const CLOCK = Symbol('CLOCK');",
          ),
        ],
        'platform/auth/ports/clock.port.ts does not export the descriptor CLOCK_DESCRIPTOR: PortDescriptor<Clock>',
      ],
      [
        'has a descriptor typed as something else',
        [
          file(
            'platform/auth/ports/clock.port.ts',
            "export interface Clock {}\nexport const CLOCK = Symbol('CLOCK');\nexport const CLOCK_DESCRIPTOR: unknown = {};",
          ),
        ],
        'platform/auth/ports/clock.port.ts does not export the descriptor CLOCK_DESCRIPTOR: PortDescriptor<Clock>',
      ],
    ])('flags a port that %s', (_label, files, problem) => {
      expect(findPortSourceProblems(files, ['Clock'])).toEqual([problem]);
    });

    // Break caught: a new port file added without being listed, so no test ever checks it.
    it('flags a port file that is not in the list of ports', () => {
      expect(findPortSourceProblems([complete('Clock'), complete('Mailer')], ['Clock'])).toEqual([
        'platform/auth/ports/mailer.port.ts is a port file that is not in the list of ports',
      ]);
    });

    describe('descriptors', () => {
      interface Mutable {
        name: string;
        token: unknown;
        descriptor: Record<string, unknown>;
      }
      const baseline = (): Mutable[] =>
        PORTS.map((entry) => ({
          name: entry.name,
          token: entry.token,
          descriptor: JSON.parse(JSON.stringify(entry.descriptor)) as Record<string, unknown>,
        }));
      const first = (entries: Mutable[]): Mutable => {
        const entry = entries[0];
        if (entry === undefined) throw new Error('no ports registered');
        return entry;
      };
      const operationOf = (entry: Mutable): Record<string, unknown> => {
        const operations = entry.descriptor.operations as Record<string, Record<string, unknown>>;
        const [key] = Object.keys(operations);
        const operation = key === undefined ? undefined : operations[key];
        if (key === undefined || operation === undefined) throw new Error('no operation');
        return operation;
      };
      const operationName = (entry: Mutable): string =>
        Object.keys(entry.descriptor.operations as object)[0] ?? '';
      const problems = (entries: DescribedPort[]) =>
        findPortDescriptorProblems(entries, PORT_NAMES);

      it('accepts the registry as written', () => {
        expect(problems(baseline())).toEqual([]);
      });

      it('flags a missing port', () => {
        expect(problems(baseline().slice(1))).toEqual([`${PORT_NAMES[0]}: is not in the registry`]);
      });

      it('flags a port registered twice', () => {
        const entries = baseline();
        entries.push(first(entries));
        expect(problems(entries)).toEqual([`${PORT_NAMES[0]}: is registered twice`]);
      });

      it('flags a registered port that is not in the list', () => {
        const entries = baseline();
        entries.push({ ...first(entries), name: 'Mailer' });
        expect(problems(entries)).toContain(
          'Mailer: is registered but is not in the list of ports',
        );
      });

      it('flags a token that is not a symbol with the right description', () => {
        const wrong = baseline();
        first(wrong).token = 'CLOCK';
        expect(problems(wrong)).toEqual(["Clock: the token must be a Symbol described as 'CLOCK'"]);

        const renamed = baseline();
        first(renamed).token = Symbol('OTHER');
        expect(problems(renamed)).toEqual([
          "Clock: the token must be a Symbol described as 'CLOCK'",
        ]);
      });

      // Break caught: a port bound to another port's token, so that asking for one yields the other.
      it("flags a port that reuses another port's token", () => {
        const entries = baseline();
        const second = entries[1];
        if (second === undefined) throw new Error('no second port');
        second.token = first(entries).token;
        expect(problems(entries)).toEqual([
          "Hasher: the token must be a Symbol described as 'HASHER'",
        ]);
      });

      it('flags a descriptor that names another port', () => {
        const entries = baseline();
        first(entries).descriptor.port = 'Hasher';
        expect(problems(entries)).toEqual(["Clock: the descriptor names the port 'Hasher'"]);
      });

      it.each([
        ['no owner', undefined],
        ['an owner of an unknown kind', { kind: 'somewhere' }],
        ['a domain owner with no domain', { kind: 'domain', domains: [] }],
        ['a platform owner with no area', { kind: 'platform', area: '' }],
      ])('flags %s', (_label, owner) => {
        const entries = baseline();
        first(entries).descriptor.owner = owner;
        expect(problems(entries)).toEqual([
          'Clock: the owner is not a platform area or a list of domains',
        ]);
      });

      it('flags a descriptor with no operations', () => {
        const entries = baseline();
        first(entries).descriptor.operations = {};
        expect(problems(entries)).toEqual(['Clock: the descriptor has no operations']);
      });

      it.each(['inputs', 'outputs'])('flags an operation whose %s is blank', (field) => {
        const entries = baseline();
        const target = first(entries);
        operationOf(target)[field] = '   ';
        expect(problems(entries)).toEqual([`Clock.${operationName(target)}: ${field} is empty`]);
      });

      // Break caught (S0.1, failure description): the two kinds of failure run together, so a caller cannot tell an answer the
      // operation returns from a condition it throws.
      describe.each(['outcomes', 'raises'])('%s', (field) => {
        it.each([
          ['an empty list', []],
          ['a missing value', undefined],
          ['an entry that is not a SCREAMING_SNAKE name', ['not-a-name']],
        ])('flags a value given as %s', (_label, value) => {
          const entries = baseline();
          const target = first(entries);
          operationOf(target)[field] = value;
          expect(problems(entries)).toEqual([
            `Clock.${operationName(target)}: ${field} must be 'none' or a list of SCREAMING_SNAKE names`,
          ]);
        });
      });

      it('flags a name listed both as an outcome that is returned and as a condition that is raised', () => {
        const entries = baseline();
        const target = first(entries);
        operationOf(target).outcomes = ['SOME_NAME'];
        operationOf(target).raises = ['SOME_NAME'];
        expect(problems(entries)).toEqual([
          `Clock.${operationName(target)}: SOME_NAME is listed both as an outcome and as a raise`,
        ]);
      });

      it.each([undefined, 'sometimes'])('flags a transaction requirement of %s', (transaction) => {
        const entries = baseline();
        const target = first(entries);
        operationOf(target).transaction = transaction;
        expect(problems(entries)).toEqual([
          `Clock.${operationName(target)}: transaction must be inside-callers-transaction, outside-any-transaction or independent`,
        ]);
      });
    });
  });

  // The categories mean something (port-descriptor.ts): inside is the caller's TransactionHandle, independent is safe local
  // work, and everything else, every autonomous database operation among it, runs with no transaction of the caller's open.
  describe('transaction requirements (S0.1, categories)', () => {
    const handle = file(
      `${PORTS_DIRECTORY}/unit-of-work.port.ts`,
      'export interface TransactionHandle { readonly brand: true }',
    );
    const writer = file(
      `${PORTS_DIRECTORY}/audit-writer.port.ts`,
      "import type { TransactionHandle } from './unit-of-work.port.js';\nexport interface AuditWriter { write(transaction: TransactionHandle, event: string): Promise<void>; flush(): void }",
    );
    const operation = (transaction: string) => ({
      inputs: 'x',
      outputs: 'y',
      outcomes: 'none',
      raises: 'none',
      transaction,
    });
    const entry = (
      write: string,
      flush: string,
      extra: Record<string, unknown> = {},
    ): DescribedPort => ({
      name: 'AuditWriter',
      token: Symbol('AUDIT_WRITER'),
      descriptor: {
        port: 'AuditWriter',
        owner: { kind: 'platform', area: 'audit' },
        operations: { write: operation(write), flush: operation(flush), ...extra },
      },
    });
    const check = (described: DescribedPort, local: readonly string[]) =>
      findTransactionCategoryProblems(sourceModelOf([handle, writer]), [described], local);

    it('accepts a method that takes the handle as inside and local work as independent', () => {
      expect(
        check(entry('inside-callers-transaction', 'independent'), ['AuditWriter.flush']),
      ).toEqual([]);
    });

    // Break caught: an operation that takes the caller's transaction described as running outside it, or the reverse, so the
    // description and the signature disagree about whether the caller's connection is in play.
    it('flags a method that takes the handle but is not described as inside', () => {
      expect(check(entry('outside-any-transaction', 'independent'), ['AuditWriter.flush'])).toEqual(
        [
          "AuditWriter.write: takes the caller's TransactionHandle, so it must be described as inside-callers-transaction, not outside-any-transaction",
        ],
      );
    });

    it('flags a method described as inside that takes no handle', () => {
      expect(check(entry('inside-callers-transaction', 'inside-callers-transaction'), [])).toEqual([
        'AuditWriter.flush: is described as inside-callers-transaction but takes no TransactionHandle',
      ]);
    });

    // Break caught (the audit finding): an operation that opens its own database transaction filed as `independent`, so a
    // caller is told it is harmless to call from inside its own transaction.
    it('reserves independent for the listed safe local work', () => {
      expect(check(entry('inside-callers-transaction', 'independent'), [])).toEqual([
        'AuditWriter.flush: is described as independent, which is reserved for the listed safe local operations, and is not one of them',
      ]);
      expect(
        check(entry('inside-callers-transaction', 'outside-any-transaction'), [
          'AuditWriter.flush',
        ]),
      ).toEqual([
        'AuditWriter.flush: is on the list of safe local operations but is described as outside-any-transaction',
      ]);
    });

    it('flags a described operation the interface does not have, and a method with no description', () => {
      expect(
        check(
          entry('inside-callers-transaction', 'independent', { nope: operation('independent') }),
          ['AuditWriter.flush', 'AuditWriter.nope'],
        ),
      ).toEqual(['AuditWriter.nope: is described but the interface has no such method']);

      const sparse: DescribedPort = {
        name: 'AuditWriter',
        token: Symbol('AUDIT_WRITER'),
        descriptor: {
          port: 'AuditWriter',
          owner: { kind: 'platform', area: 'audit' },
          operations: { write: operation('inside-callers-transaction') },
        },
      };
      expect(check(sparse, [])).toEqual([
        'AuditWriter.flush: is a method of the interface with no description',
      ]);
    });

    it('describes the real ports consistently, with the autonomous database operations outside', () => {
      const model = realModel();

      expect(findTransactionCategoryProblems(model, PORTS, LOCAL_OPERATIONS)).toEqual([]);
      const category = (port: string, method: string): unknown =>
        (
          PORTS.find((entry) => entry.name === port)?.descriptor.operations[method] as
            { transaction: string } | undefined
        )?.transaction;
      expect(category('RateLimiter', 'admit')).toBe('outside-any-transaction');
      expect(category('DeliveryQueue', 'claim')).toBe('outside-any-transaction');
      expect(category('DeliveryQueue', 'recordOutcome')).toBe('outside-any-transaction');
      expect(category('UnitOfWork', 'run')).toBe('outside-any-transaction');
    }, 30_000);
  });

  // Fixtures for the two source rules below. The ports are declared in memory, so a name is resolved through the compiler's
  // symbols, as in the real tree, and a fixture can use an alias or a namespace as production code could.
  const declared = PORT_NAMES.map((name) =>
    file(
      `${PORTS_DIRECTORY}/${portFileName(name)}`,
      `export interface ${name} { readonly ok: true }`,
    ),
  );
  const barrel = file(
    `${PORTS_DIRECTORY}/index.ts`,
    PORT_NAMES.map((name) => `export * from './${portFileName(name).replace('.ts', '.js')}';`).join(
      '\n',
    ),
  );
  const modelOf = (...files: SourceFile[]) => sourceModelOf([...declared, barrel, ...files]);

  describe('no adapter is imported outside the composition root (S0.1 c)', () => {
    const adapter = file(
      'platform/auth/crypto/argon2.hasher.adapter.ts',
      'export class Argon2Hasher {}',
    );
    const check = (files: SourceFile[], root: readonly string[] = COMPOSITION_ROOT) =>
      findAdapterImportViolations(modelOf(adapter, ...files), PORT_NAMES, root);
    const importing = (path: string, text: string) => file(path, text);
    const IMPORT =
      "import { Argon2Hasher } from './crypto/argon2.hasher.adapter.js';\nexport const x = Argon2Hasher;";

    // S0.9 added the second: the `db:seed` process binds the production clock for the seed's database service, in a file of its own.
    // S0.18 added the third: the delivery worker is its own process, and binds its adapters in a file of its own.
    it('names the composition root explicitly: the application module, the delivery worker and the seed process wiring', () => {
      expect(COMPOSITION_ROOT).toEqual([
        'app.module.ts',
        'delivery-worker-runtime.ts',
        'tools/seed/seed-runtime.ts',
      ]);
    });

    it.each([
      [
        'the application module',
        'app.module.ts',
        "import { Argon2Hasher } from './platform/auth/crypto/argon2.hasher.adapter.js';",
      ],
      ['a test', 'platform/auth/sign-in.test.ts', IMPORT],
      [
        'test support',
        'test-support/test-app.ts',
        "import { Argon2Hasher } from '../platform/auth/crypto/argon2.hasher.adapter.js';",
      ],
    ])('lets %s import an adapter', (_label, path, text) => {
      expect(check([importing(path, text)])).toEqual([]);
    });

    // Break caught (S0.1 c): a *.module.ts file imported an adapter because it was called a module, which is the exemption the
    // audit found; being a module is not being the composition root.
    it.each([
      ['a platform module', 'platform/auth/auth.module.ts', './crypto/argon2.hasher.adapter.js'],
      [
        'a domain module',
        'staff/staff.module.ts',
        '../platform/auth/crypto/argon2.hasher.adapter.js',
      ],
      [
        'the platform module',
        'platform/platform.module.ts',
        './auth/crypto/argon2.hasher.adapter.js',
      ],
    ])('flags %s that imports an adapter', (_label, path, specifier) => {
      const text = `import { Argon2Hasher } from '${specifier}';
export const x = Argon2Hasher;`;

      expect(check([importing(path, text)])).toEqual([
        `${path} imports the adapter ${specifier}; only a composition-root file may import an adapter`,
      ]);
    });

    it('lets a module the composition root lists import an adapter, and no other', () => {
      const text =
        "import { Argon2Hasher } from '../platform/auth/crypto/argon2.hasher.adapter.js';";
      const listed = ['app.module.ts', 'staff/staff.module.ts'];

      expect(check([importing('staff/staff.module.ts', text)], listed)).toEqual([]);
      expect(check([importing('vendor/vendor.module.ts', text)], listed)).toEqual([
        'vendor/vendor.module.ts imports the adapter ../platform/auth/crypto/argon2.hasher.adapter.js; only a composition-root file may import an adapter',
      ]);
    });

    it.each([
      [
        'a service',
        'platform/auth/sign-in.service.ts',
        IMPORT,
        './crypto/argon2.hasher.adapter.js',
      ],
      [
        'a controller',
        'platform/auth/auth.controller.ts',
        IMPORT,
        './crypto/argon2.hasher.adapter.js',
      ],
      [
        'a type import',
        'platform/auth/sign-in.service.ts',
        "import type { Argon2Hasher } from './crypto/argon2.hasher.adapter.js';",
        './crypto/argon2.hasher.adapter.js',
      ],
      [
        'a re-export',
        'platform/auth/index.ts',
        "export * from './crypto/argon2.hasher.adapter.js';",
        './crypto/argon2.hasher.adapter.js',
      ],
      [
        'a dynamic import',
        'platform/auth/sign-in.service.ts',
        "export const load = () => import('./crypto/argon2.hasher.adapter.js');",
        './crypto/argon2.hasher.adapter.js',
      ],
      [
        'an import type node',
        'platform/auth/sign-in.service.ts',
        "export type H = import('./crypto/argon2.hasher.adapter.js').Argon2Hasher;",
        './crypto/argon2.hasher.adapter.js',
      ],
      [
        'an extensionless import',
        'platform/auth/sign-in.service.ts',
        "import { Argon2Hasher } from './crypto/argon2.hasher.adapter';\nexport const x = Argon2Hasher;",
        './crypto/argon2.hasher.adapter',
      ],
      [
        'main',
        'main.ts',
        "import { Argon2Hasher } from './platform/auth/crypto/argon2.hasher.adapter.js';\nexport const x = Argon2Hasher;",
        './platform/auth/crypto/argon2.hasher.adapter.js',
      ],
    ])('flags %s that imports an adapter', (_label, path, text, specifier) => {
      expect(check([importing(path, text)])).toEqual([
        `${path} imports the adapter ${specifier}; only a composition-root file may import an adapter`,
      ]);
    });

    // Break caught: an adapter reached through a barrel or a path the name rule cannot see.
    it('flags an adapter that does not exist yet by its name, and one reached through a file that implements a port', () => {
      expect(
        check([
          importing(
            'platform/auth/sign-in.service.ts',
            "import { X } from './missing.adapter.js';\nexport const y = X;",
          ),
        ]),
      ).toEqual([
        'platform/auth/sign-in.service.ts imports the adapter ./missing.adapter.js; only a composition-root file may import an adapter',
      ]);

      const implementation = file(
        'staff/directory.ts',
        "import type { IdentityDirectory } from '../platform/auth/ports/identity-directory.port.js';\nexport class StaffDirectory implements IdentityDirectory {}",
      );
      const service = file(
        'staff/staff.service.ts',
        "import { StaffDirectory } from './directory.js';\nexport const d = StaffDirectory;",
      );
      expect(
        findAdapterImportViolations(modelOf(implementation, service), PORT_NAMES, COMPOSITION_ROOT),
      ).toEqual([
        'staff/staff.service.ts imports the adapter ./directory.js; only a composition-root file may import an adapter',
      ]);
    });

    it('does not mistake a port, a package or an ordinary file for an adapter', () => {
      const text = [
        "import { CLOCK } from './ports/clock.port.js';",
        "import { createHash } from 'node:crypto';",
        "import { notes } from './adapter-notes.js';",
        'export const x = [CLOCK, createHash, notes];',
      ].join('\n');
      expect(
        check([
          importing('platform/auth/sign-in.service.ts', text),
          file('platform/auth/adapter-notes.ts', 'export const notes = 1;'),
        ]),
      ).toEqual([]);
    });
  });

  describe('no class implements a port inside platform/ (S0.1 d)', () => {
    const check = (files: SourceFile[], allowed: readonly string[] = []) =>
      findPortImplementationViolations(modelOf(...files), PORT_NAMES, allowed);
    const IMPORT_CLOCK = "import type { Clock } from './ports/clock.port.js';\n";
    const message = (path: string, port: string) =>
      `${path} implements the port ${port} inside platform/; a port has no adapter there until the task that builds it lists the file`;

    // Break caught (S0.1 d, the audit finding): the rule read the port's name as text, so an import under another name, a
    // namespace, a re-export or a type alias walked past it.
    it.each([
      ['directly', `${IMPORT_CLOCK}export class SystemClock implements Clock {}`],
      [
        'under another name',
        "import type { Clock as TimeSource } from './ports/clock.port.js';\nexport class SystemClock implements TimeSource {}",
      ],
      [
        'through a namespace import of the registry',
        "import type * as ports from './ports/index.js';\nexport class SystemClock implements ports.Clock {}",
      ],
      [
        'through a namespace import of the port file',
        "import type * as clock from './ports/clock.port.js';\nexport class SystemClock implements clock.Clock {}",
      ],
      [
        'through a re-export under another name',
        "import type { TimeSource } from './barrel.js';\nexport class SystemClock implements TimeSource {}",
      ],
      [
        'through a type alias',
        `${IMPORT_CLOCK}type Source = Clock;\nexport class SystemClock implements Source {}`,
      ],
      [
        'through an interface that extends it',
        `${IMPORT_CLOCK}interface Wider extends Clock { extra(): void }\nexport class SystemClock implements Wider {}`,
      ],
      [
        'as one of several interfaces',
        `${IMPORT_CLOCK}export class SystemClock implements Disposable, Clock {}`,
      ],
      [
        'with a generic heading over several lines',
        `${IMPORT_CLOCK}export class SystemClock<T>\n  extends Base<T>\n  implements\n    Disposable,\n    Clock\n{}`,
      ],
      [
        'as a class expression',
        `${IMPORT_CLOCK}export const SystemClock = class implements Clock {};`,
      ],
      [
        'as a literal typed with an alias',
        "import type { Clock as C } from './ports/clock.port.js';\nexport const clock: C = { now: () => new Date() };",
      ],
      [
        'as a literal typed through a namespace',
        "import type * as ports from './ports/index.js';\nexport const clock: ports.Clock = { now: () => new Date() };",
      ],
      [
        'as a literal that satisfies it',
        `${IMPORT_CLOCK}export const clock = { now: () => new Date() } satisfies Clock;`,
      ],
      [
        'as a literal that satisfies an intersection with it',
        `${IMPORT_CLOCK}export const clock = { now: () => new Date() } satisfies Clock & { extra?: number };`,
      ],
      [
        'as a literal asserted to be it',
        `${IMPORT_CLOCK}export const clock = { now: () => new Date() } as Clock;`,
      ],
      [
        'as a literal returned by a function typed with it',
        `${IMPORT_CLOCK}export function make(): Clock { return { now: () => new Date() }; }`,
      ],
      [
        'as a literal returned by an arrow function typed with it',
        `${IMPORT_CLOCK}export const make = (): Clock => ({ now: () => new Date() });`,
      ],
    ])('flags a port implemented %s', (_label, text) => {
      const barrelOfRenames = file(
        'platform/auth/barrel.ts',
        "export type { Clock as TimeSource } from './ports/clock.port.js';",
      );

      expect(check([barrelOfRenames, file('platform/auth/system-clock.ts', text)])).toEqual([
        message('platform/auth/system-clock.ts', 'Clock'),
      ]);
    });

    it('names every port a file implements', () => {
      const text =
        "import type { Clock, Hasher } from './ports/index.js';\nexport class Both implements Clock, Hasher {}";

      expect(check([file('platform/auth/both.ts', text)])).toEqual([
        message('platform/auth/both.ts', 'Clock'),
        message('platform/auth/both.ts', 'Hasher'),
      ]);
    });

    // Break caught: the reverse, a port-looking name that is not a port, flagged and teaching people to ignore the rule.
    it('does not flag a local interface that only shares a port name, or another namespace', () => {
      const other = file('platform/auth/other.ts', 'export interface Clock { other: true }');
      const files = [
        other,
        file(
          'platform/auth/local.ts',
          'interface Clock { tick(): void }\nexport class Local implements Clock {}',
        ),
        file(
          'platform/auth/namespaced.ts',
          "import type * as other from './other.js';\nexport class Namespaced implements other.Clock {}",
        ),
        file(
          'platform/auth/aliased.ts',
          "import type { Clock as Elsewhere } from './other.js';\nexport const c: Elsewhere = { other: true };",
        ),
      ];

      expect(check(files)).toEqual([]);
    });

    it('does not flag the use of a port, an unrelated interface, a comment, a string or a test', () => {
      const files = [
        file(
          'platform/auth/use.ts',
          `${IMPORT_CLOCK}export function use(clock: Clock): Clock { return clock; }\nexport const pass = (clock: Clock): Clock => clock;`,
        ),
        file('platform/auth/unrelated.ts', 'export class Other implements Disposable {}'),
        file(
          'platform/auth/prose.ts',
          `${IMPORT_CLOCK}// a class SystemClock implements Clock is an adapter\n/* export class X implements Clock {} */\nexport const s = 'export class Y implements Clock {}';`,
        ),
        file(
          'platform/auth/system-clock.test.ts',
          `${IMPORT_CLOCK}class FixedClock implements Clock {}`,
        ),
        file(
          'test-support/fixed-clock.ts',
          `import type { Clock } from '../platform/auth/ports/clock.port.js';\nexport class Fixed implements Clock {}`,
        ),
      ];

      expect(check(files)).toEqual([]);
    });

    it('lets a file that a task has listed implement its port, if it is named as an adapter', () => {
      const text = `${IMPORT_CLOCK}export class SystemClock implements Clock {}`;

      expect(
        check(
          [file('platform/auth/system-clock.adapter.ts', text)],
          ['platform/auth/system-clock.adapter.ts'],
        ),
      ).toEqual([]);
      expect(
        check([file('platform/auth/system-clock.ts', text)], ['platform/auth/system-clock.ts']),
      ).toEqual([
        'platform/auth/system-clock.ts implements the port Clock in a file that is not named *.adapter.ts; an adapter is named so that only the composition root can import it',
      ]);
    });

    it('requires an adapter outside platform/ to be in a file named .adapter.ts', () => {
      const text =
        "import type { IdentityDirectory } from '../platform/auth/ports/identity-directory.port.js';\nexport class StaffDirectory implements IdentityDirectory {}";

      expect(check([file('staff/staff-directory.ts', text)])).toEqual([
        'staff/staff-directory.ts implements the port IdentityDirectory in a file that is not named *.adapter.ts; an adapter is named so that only the composition root can import it',
      ]);
      expect(check([file('staff/staff-directory.adapter.ts', text)])).toEqual([]);
    });
  });

  describe('the application as it is', () => {
    it('has no adapter file but the listed ones, and no class that implements a port anywhere else', () => {
      const files = sourceFiles();

      // The order the directory is walked in is not the order of the list (a shallower folder comes first), so the two are compared sorted.
      expect(
        files
          .filter((source) => source.path.endsWith('.adapter.ts'))
          .map((source) => source.path)
          .sort(),
      ).toEqual([...ALLOWED_PORT_IMPLEMENTATIONS].sort());
      expect(
        findPortImplementationViolations(realModel(), PORT_NAMES, ALLOWED_PORT_IMPLEMENTATIONS),
      ).toEqual([]);
    }, 30_000);

    // Break caught: the checker not seeing the adapters at all, so the allow-list would be permitting nothing and the rule would
    // be passing because it is blind. The describe file implements every port, and each real adapter implements the one port
    // it is for, in the file that is listed for it and no other.
    it('sees every port implemented in the listed files, and only there, when the list is empty', () => {
      const found = findPortImplementationViolations(realModel(), PORT_NAMES, []);
      const said = (file: string, port: string) =>
        `${file} implements the port ${port} inside platform/; a port has no adapter there until the task that builds it lists the file`;

      expect(found).toHaveLength(PORT_NAMES.length + ADAPTED_PORTS.length);
      for (const name of PORT_NAMES) expect(found).toContain(said(DESCRIBE_ADAPTERS, name));
      for (const [file, port] of ADAPTED_PORTS) expect(found).toContain(said(file, port));
      expect([...ADAPTED_PORTS.map(([file]) => file), DESCRIBE_ADAPTERS].sort()).toEqual(
        [...ALLOWED_PORT_IMPLEMENTATIONS].sort(),
      );
    }, 30_000);

    it('imports no adapter outside the composition root', () => {
      expect(findAdapterImportViolations(realModel(), PORT_NAMES, COMPOSITION_ROOT)).toEqual([]);
    }, 30_000);
  });
});

describe('the database door (S0.4)', () => {
  const file = (path: string, text: string): SourceFile => ({ path, text });

  describe('where a SYSTEM capability is opened (capability-access.ts; registry §5.2 "opened only by")', () => {
    const check = (files: SourceFile[]) => findCapabilityOpenerViolations(files, CAPABILITY_ACCESS);

    // Break caught: the rule so strict that the place the registry names cannot open its own capability.
    it('accepts a capability opened where the matrix says', () => {
      expect(
        check([
          file(
            'platform/auth/staff/sign-in.service.ts',
            "const c = { taskCapability: 'authentication' };",
          ),
          file('tools/bootstrap/bootstrap.ts', 'const c = { taskCapability: "bootstrap" };'),
          file('tools/seed/seed.ts', 'const c = { taskCapability: `seed` };'),
          file('platform/delivery/worker/run.ts', "{ taskCapability:\n 'credential_delivery' }"),
          file('platform/limiter/limiter.ts', "{ taskCapability : 'rate_limit' }"),
        ]),
      ).toEqual([]);
    });

    // Break caught: a capability opened by a file the matrix does not name, which is how a label escapes the
    // composition root it was granted to (the API asserting `seed`, a domain module asserting `authentication`).
    it('refuses a capability opened outside the places listed for it', () => {
      expect(
        check([
          file('staff/staff.service.ts', "{ taskCapability: 'authentication' }"),
          file('platform/auth/sign-in.ts', "{ taskCapability: 'seed' }"),
          file('tools/seed/seed.ts', "{ taskCapability: 'bootstrap' }"),
        ]),
      ).toEqual([
        "staff/staff.service.ts opens the capability 'authentication', which the access matrix allows only under platform/auth/",
        "platform/auth/sign-in.ts opens the capability 'seed', which the access matrix allows only under platform/database/seed/, tools/seed/, tools/fixtures/",
        "tools/seed/seed.ts opens the capability 'bootstrap', which the access matrix allows only under tools/bootstrap/",
      ]);
    });

    // Break caught: a label outside the closed list, in source, which the context validation refuses at run time and
    // this refuses at review.
    it('refuses a capability that is not in the closed list', () => {
      expect(check([file('platform/auth/x.ts', "{ taskCapability: 'admin' }")])).toEqual([
        "platform/auth/x.ts opens the capability 'admin', which is not in the closed list",
      ]);
    });

    // Tests build contexts of every kind on purpose; the matrix is about production code.
    it('does not read tests or test support', () => {
      expect(
        check([
          file('platform/database/x.test.ts', "{ taskCapability: 'seed' }"),
          file('test-support/context.ts', "{ taskCapability: 'seed' }"),
        ]),
      ).toEqual([]);
    });

    // Break caught: the type, a parameter name or a comparison being read as opening a capability.
    it('does not read a type annotation, a comparison or a value held in a variable', () => {
      expect(
        check([
          file(
            'platform/auth/y.ts',
            "interface C { taskCapability?: TaskCapability }\nif (context.taskCapability === 'seed') {}\nconst c = { taskCapability: chosen };",
          ),
        ]),
      ).toEqual([]);
    });

    it('holds for the application as it is', () => {
      expect(findCapabilityOpenerViolations(sourceFiles(), CAPABILITY_ACCESS)).toEqual([]);
    });
  });

  describe('who writes melarc.scope_probe_id (SECURITY_DESIGN.md §14.1: existingRecordHub, and nothing else)', () => {
    // Break caught: a second writer of the probe id, which would make "set only by existingRecordHub" a sentence.
    it('refuses the setting named in a string anywhere but scope-probe.ts', () => {
      const text =
        "await tx.execute(sql`select set_config('melarc.scope_probe_id', ${id}, true)`);";
      expect(findScopeProbeWriterViolations([file('staff/staff.service.ts', text)])).toEqual([
        "staff/staff.service.ts names the setting 'melarc.scope_probe_id'; only platform/database/scope-probe.ts may write it",
      ]);
      expect(
        findScopeProbeWriterViolations([
          file('platform/database/transaction-context.ts', "add('scope_probe_id', x);"),
        ]),
      ).toEqual([
        "platform/database/transaction-context.ts names the setting 'scope_probe_id'; only platform/database/scope-probe.ts may write it",
      ]);
    });

    it('accepts scope-probe.ts, tests, and a mention that is not a setting name', () => {
      expect(
        findScopeProbeWriterViolations([
          file('platform/database/scope-probe.ts', "set_config('melarc.scope_probe_id', '', true)"),
          file('platform/database/scope-probe.test.ts', "'melarc.scope_probe_id'"),
          file(
            'platform/database/transaction-context.ts',
            '// `melarc.scope_probe_id` is deliberately not a field',
          ),
        ]),
      ).toEqual([]);
    });

    it('holds for the application as it is', () => {
      expect(findScopeProbeWriterViolations(sourceFiles())).toEqual([]);
    });
  });

  describe('the pool and the driver stay behind DatabaseService (S0.4c)', () => {
    // Break caught: a second door to PostgreSQL. The context-free `db` handle and `transaction()` are closed so that
    // every protected query runs under a validated context; code that took the pool or built its own drizzle
    // instance would walk round that.
    it.each([
      ["import pg from 'pg';"],
      ["import { Pool } from 'pg';"],
      ["import type { PoolClient } from 'pg';"],
      ["import { drizzle } from 'drizzle-orm/node-postgres';"],
      ["const pool = await import('pg');"],
      ['constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}'],
    ])('refuses %s outside platform/database/', (text) => {
      expect(findDatabaseDoorViolations([file('staff/staff.repository.ts', text)])).toHaveLength(1);
      expect(findDatabaseDoorViolations([file('platform/auth/x.ts', text)])).toHaveLength(1);
    });

    it('accepts the database module itself, the command-line tools, test support and tests', () => {
      const text =
        "import pg from 'pg';\nimport { drizzle } from 'drizzle-orm/node-postgres';\nDATABASE_POOL;";
      expect(
        findDatabaseDoorViolations([
          file('platform/database/database.service.ts', text),
          file('tools/database/run-migrations.ts', text),
          file('test-support/x.ts', text),
          file('staff/x.test.ts', text),
          file('platform/platform.tokens.ts', 'export const DATABASE_POOL = Symbol();'),
        ]),
      ).toEqual([]);
    });

    it('accepts a query builder that does not connect, and names the file when it refuses', () => {
      expect(
        findDatabaseDoorViolations([file('staff/x.ts', "import { sql } from 'drizzle-orm';")]),
      ).toEqual([]);
      expect(findDatabaseDoorViolations([file('staff/x.ts', "import pg from 'pg';")])).toEqual([
        'staff/x.ts reaches PostgreSQL other than through DatabaseService (pg, drizzle-orm/node-postgres or DATABASE_POOL)',
      ]);
    });

    it('holds for the application as it is', () => {
      expect(findDatabaseDoorViolations(sourceFiles())).toEqual([]);
    });

    // Break caught: the harness entry point (test/support/e2e-main.mjs, outside src/ and never built into dist) going
    // back through the service's pool. It wrote with `db.$client`, which is the door S0.4c closed: it now builds a pool
    // of its own, as the runtime identity, and the service neither offers its own nor is asked for it.
    it('keeps the harness entry point off the service’s pool and driver handle', () => {
      const entry = readFileSync(join(sourceRoot, '..', 'test', 'support', 'e2e-main.mjs'), 'utf8');

      expect(entry).not.toMatch(/\.\$client|\.db\b|DatabaseService/);
      expect(entry).toMatch(/createPool\(/);
    });
  });

  describe('elapsed time is read from the Clock and from nothing else (S0.6)', () => {
    // Break caught: a budget, a wait or a deadline measured on the wall clock (which a correction can move by hours) or on a
    // clock a test cannot control. The monotonic reading of the injected Clock is the only elapsed time there.
    it.each([
      ['Date.now()', 'const started = Date.now();'],
      ['performance.now()', 'const started = performance.now();'],
      ['new Date()', 'const started = new Date();'],
      ['Date.now (spaced)', 'const started = Date.now ( );'],
    ])('refuses %s in the database layer and the budget', (_label, text) => {
      expect(findOwnClockViolations([file('platform/database/x.ts', text)])).toHaveLength(1);
      expect(findOwnClockViolations([file('platform/execution/x.ts', text)])).toHaveLength(1);
    });

    it('names the file and what it read', () => {
      expect(
        findOwnClockViolations([
          file('platform/execution/execution-budget.ts', 'const t = Date.now();'),
        ]),
      ).toEqual([
        "platform/execution/execution-budget.ts reads the clock itself (Date.now()); elapsed time here is the injected Clock's monotonic reading",
      ]);
    });

    it('accepts the Clock, timers, comments that name a clock, tests and the adapter that is the clock', () => {
      expect(
        findOwnClockViolations([
          file('platform/execution/a.ts', 'const t = clock.monotonicMilliseconds();'),
          file('platform/database/b.ts', 'const timer = setTimeout(() => undefined, 5);'),
          file(
            'platform/database/c.ts',
            ['// not performance.now()', '/* nor Date.now() */', 'const x = 1;'].join('\n'),
          ),
          file('platform/database/d.test.ts', 'const t = Date.now();'),
          file('test-support/e.ts', 'const t = new Date();'),
          file('platform/auth/clock/system.clock.adapter.ts', 'return performance.now();'),
          file('platform/lifecycle/shutdown.registry.ts', 'const t = performance.now();'),
        ]),
      ).toEqual([]);
    });

    it('holds for the application as it is', () => {
      expect(findOwnClockViolations(sourceFiles())).toEqual([]);
    });
  });

  describe('advisory locks are transaction-scoped and live in policy-lock/ (S0.7)', () => {
    const file = (path: string, text: string): SourceFile => ({ path, text });

    // Break caught: a session-level advisory lock in application code. On a pooled connection it outlives the transaction and
    // the request, and the next request that reuses the connection holds a lock it never took (SECURITY_DESIGN.md §13.10a).
    it.each([
      ['pg_advisory_lock', 'await tx.execute(sql`select pg_advisory_lock(1, 2)`);'],
      ['pg_advisory_lock_shared', 'sql`select pg_advisory_lock_shared(1, 2)`'],
      ['pg_advisory_unlock', 'sql`select pg_advisory_unlock(1, 2)`'],
      ['pg_advisory_unlock_all', 'sql`select pg_advisory_unlock_all()`'],
      ['pg_advisory_unlock_shared', 'sql`select pg_advisory_unlock_shared(1, 2)`'],
    ])('refuses %s in application code', (_name, text) => {
      expect(findAdvisoryLockViolations([file('platform/auth/x.ts', text)])).toHaveLength(1);
      expect(findAdvisoryLockViolations([file('staff/x.ts', text)])).toHaveLength(1);
      expect(
        findAdvisoryLockViolations([file('platform/database/policy-lock/x.ts', text)]),
      ).toHaveLength(1);
    });

    // Break caught: a `pg_try_` call, which returns false instead of waiting. In a loop with no bound it spins on the database;
    // a bounded use is added to the allow-list with its bound.
    it.each([
      ['pg_try_advisory_lock', 'sql`select pg_try_advisory_lock(1, 2)`'],
      ['pg_try_advisory_xact_lock', 'sql`select pg_try_advisory_xact_lock(1, 2)`'],
      ['pg_try_advisory_xact_lock_shared', 'sql`select pg_try_advisory_xact_lock_shared(1, 2)`'],
    ])('refuses %s anywhere in application code', (_name, text) => {
      expect(
        findAdvisoryLockViolations([file('platform/database/policy-lock/x.ts', text)]),
      ).toHaveLength(1);
      expect(findAdvisoryLockViolations([file('staff/x.ts', text)])).toHaveLength(1);
    });

    // Break caught: a try-lock coming back into application code, in the limiter or anywhere else. The one there was (the limiter's
    // cleanup election; review of 10 October 2026) was removed when the capacity lock (G2-05) put every delete under one lock, and
    // the rule is again that none is allowed, with the class written in lock-keys.ts or in the call.
    it('refuses a try-lock in the limiter too, in every form, with or without a class from lock-keys.ts', () => {
      for (const text of [
        'sql`select pg_try_advisory_xact_lock(${RATE_LIMIT_CAPACITY}::int4, 0)`',
        'sql`select pg_try_advisory_lock(${RATE_LIMIT_CAPACITY}, 0)`',
        'sql`select pg_try_advisory_lock_shared(${RATE_LIMIT_CAPACITY}, 0)`',
        'sql`select pg_try_advisory_xact_lock_shared(${RATE_LIMIT_CAPACITY}, 0)`',
        'sql`select pg_try_advisory_xact_lock(7, 0)`',
      ]) {
        for (const path of [
          'platform/limiter/cleanup.ts',
          'platform/database/policy-lock/x.ts',
          'staff/x.ts',
        ]) {
          expect(findAdvisoryLockViolations([file(path, text)])).toHaveLength(1);
        }
      }
    });

    // Break caught: a second use of advisory locks, with a class of its own in the code that uses it, where the test that no two
    // classes share a value cannot see it. Every use goes through policy-lock/ (or an allow-listed file).
    it.each([
      ['pg_advisory_xact_lock', 'sql`select pg_advisory_xact_lock(1, 2)`'],
      ['pg_advisory_xact_lock_shared', 'sql`select pg_advisory_xact_lock_shared(1, 2)`'],
    ])('refuses %s outside platform/database/policy-lock/', (_name, text) => {
      expect(findAdvisoryLockViolations([file('staff/staff.repository.ts', text)])).toEqual([
        "staff/staff.repository.ts calls an advisory lock function; advisory locks live in platform/database/policy-lock/ (and the limiter's key lock in platform/limiter/) and take a class from lock-keys.ts",
      ]);
    });

    // Break caught: a tool taking a class of its own for a transaction-scoped lock, where the test of the classes cannot see it.
    it('refuses the transaction-scoped functions and try-locks in a command-line tool', () => {
      expect(
        findAdvisoryLockViolations([
          file('tools/database/x.ts', "client.query('select pg_advisory_xact_lock(1, 2)')"),
        ]),
      ).toHaveLength(1);
      expect(
        findAdvisoryLockViolations([
          file('tools/database/x.ts', "client.query('select pg_try_advisory_lock(1)')"),
        ]),
      ).toHaveLength(1);
    });

    // Break caught (OB-67): the limiter's key lock refused where the plan puts it, or accepted with a class written in the call, where the
    // test that no two classes share a value cannot see it.
    it('accepts the limiter’s key lock when it takes its class from lock-keys.ts, and refuses a class written in the call', () => {
      expect(
        findAdvisoryLockViolations([
          file(
            'platform/limiter/key-lock.ts',
            'sql`select pg_advisory_xact_lock(${RATE_LIMIT_KEY}, ${key})`',
          ),
        ]),
      ).toEqual([]);
      for (const text of [
        'sql`select pg_advisory_xact_lock(7, ${key})`',
        'sql`select pg_advisory_xact_lock_shared( 7, 8)`',
        'sql`select pg_advisory_xact_lock(-1, 2)`',
      ]) {
        expect(findAdvisoryLockViolations([file('platform/limiter/key-lock.ts', text)])).toEqual([
          'platform/limiter/key-lock.ts locks on a class written in the call; a class is defined in lock-keys.ts, where a test asserts that no two share a value',
        ]);
      }
      expect(
        findAdvisoryLockViolations([
          file('platform/limiters/other.ts', 'sql`select pg_advisory_xact_lock(1, 2)`'),
        ]),
      ).toHaveLength(1);
    });

    it('accepts the transaction-scoped functions in policy-lock/, the session-level ones in the command-line tools, tests and test support', () => {
      expect(
        findAdvisoryLockViolations([
          file(
            'platform/database/policy-lock/acquire.ts',
            'sql`select pg_advisory_xact_lock_shared(${lock.class}, ${lock.key})`',
          ),
          // A tool owns the one connection it locks on; the session-level functions are right there.
          file('tools/database/run-migrations.ts', "client.query('select pg_advisory_lock(1)')"),
          file('staff/x.test.ts', 'sql`select pg_advisory_lock(1, 2)`'),
          file('test-support/x.ts', 'sql`select pg_try_advisory_lock(1, 2)`'),
        ]),
      ).toEqual([]);
    });

    it('ignores a comment that names a function', () => {
      expect(
        findAdvisoryLockViolations([
          file(
            'staff/x.ts',
            [
              '// pg_advisory_lock is forbidden here',
              '/* nor pg_try_advisory_lock */',
              'const x = 1;',
            ].join('\n'),
          ),
        ]),
      ).toEqual([]);
    });

    it('holds for the application as it is', () => {
      expect(findAdvisoryLockViolations(sourceFiles())).toEqual([]);
    });
  });
});
