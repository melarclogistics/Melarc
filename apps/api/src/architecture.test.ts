import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PORTS } from './platform/auth/ports/index.js';
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
 * adds the one file of inert describe adapters, which `adapterRefusals` keeps out of any environment but a local run. The next
 * adapter, a real one, is added here by the task that builds it, and a review sees the line.
 */
const ALLOWED_PORT_IMPLEMENTATIONS: readonly string[] = [
  'platform/auth/describe/describe-ports.adapter.ts',
];

/**
 * The composition root: the files that may import an adapter, because they are where an adapter is bound to its token. It is a
 * list, not a pattern. A file is not the composition root for being a module; a task that adds an adapter lists the one module
 * file that provides it here, so every widening of this list is a reviewed line of this file.
 */
const COMPOSITION_ROOT: readonly string[] = ['app.module.ts'];

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

    it('names the composition root explicitly, and it is the application module alone', () => {
      expect(COMPOSITION_ROOT).toEqual(['app.module.ts']);
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

      expect(
        files.filter((source) => source.path.endsWith('.adapter.ts')).map((source) => source.path),
      ).toEqual([...ALLOWED_PORT_IMPLEMENTATIONS]);
      expect(
        findPortImplementationViolations(realModel(), PORT_NAMES, ALLOWED_PORT_IMPLEMENTATIONS),
      ).toEqual([]);
    }, 30_000);

    // Break caught: the checker not seeing the describe adapters at all, so the allow-list would be permitting nothing and the
    // rule would be passing because it is blind.
    it('sees every port implemented in the listed file, and only there, when the list is empty', () => {
      const found = findPortImplementationViolations(realModel(), PORT_NAMES, []);

      expect(found).toHaveLength(PORT_NAMES.length);
      for (const name of PORT_NAMES) {
        expect(found).toContain(
          `${ALLOWED_PORT_IMPLEMENTATIONS[0] ?? ''} implements the port ${name} inside platform/; a port has no adapter there until the task that builds it lists the file`,
        );
      }
    }, 30_000);

    it('imports no adapter outside the composition root', () => {
      expect(findAdapterImportViolations(realModel(), PORT_NAMES, COMPOSITION_ROOT)).toEqual([]);
    }, 30_000);
  });
});
