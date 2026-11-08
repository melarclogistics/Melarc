import 'reflect-metadata';

import { Controller, Get, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ApiResponse } from '@nestjs/swagger';
import { describe, expect, it, afterEach } from 'vitest';
import type { INestApplication } from '@nestjs/common';

import { PERMISSION_KEYS } from '../../tools/seed/permission-keys.js';
import { ContractOperation } from '../contract/contract-operation.js';
import type { JsonObject } from '../contract/json.js';
import { buildOpenApiDocument } from '../openapi/build-openapi-document.js';
import {
  ACCESS_DECLARATION_KEY,
  ACCESS_DETAIL_KEY,
  Anonymous,
  isPermissionKey,
  RequiresPermission,
  Self,
  TechnicalEndpoint,
  type AccessDetail,
} from './access-declaration.js';
import { EVERY_SURFACE } from '../../test-support/route-options.js';

describe('the four declarations', () => {
  @Controller('declared')
  class Declared {
    @Get('technical')
    @TechnicalEndpoint()
    technical(): string {
      return 'x';
    }

    @Post('anonymous')
    @Anonymous()
    anonymous(): string {
      return 'x';
    }

    @Get('self')
    @Self(EVERY_SURFACE)
    self(): string {
      return 'x';
    }

    @Get('permission')
    @RequiresPermission('staff.read', EVERY_SURFACE)
    permission(): string {
      return 'x';
    }
  }

  // The decorators put their metadata on the method's function, which is the value of its descriptor on the prototype.
  const handlerOf = (name: keyof Declared): object =>
    Object.getOwnPropertyDescriptor(Declared.prototype, name)?.value as object;
  const kind = (name: keyof Declared): unknown =>
    Reflect.getMetadata(ACCESS_DECLARATION_KEY, handlerOf(name));
  const detail = (name: keyof Declared): AccessDetail | undefined =>
    Reflect.getMetadata(ACCESS_DETAIL_KEY, handlerOf(name)) as AccessDetail | undefined;

  it('record which kind of access a route has', () => {
    expect(kind('technical')).toBe('technical');
    expect(kind('anonymous')).toBe('anonymous');
    expect(kind('self')).toBe('self');
    expect(kind('permission')).toBe('permission');
  });

  // Break caught: the permission a route requires not being on the route, where a reader and the authorization guard look for it.
  it('keep the permission key of a permission declaration, with what every authenticated route states', () => {
    expect(detail('permission')).toEqual({
      permission: 'staff.read',
      authenticated: { surfaces: EVERY_SURFACE.surfaces, activity: 'qualifying' },
    });
    expect(detail('self')).toEqual({
      authenticated: { surfaces: EVERY_SURFACE.surfaces, activity: 'qualifying' },
    });
  });
});

describe('what an authenticated route must state (S0.26)', () => {
  const detailOf = (decorator: MethodDecorator): AccessDetail | undefined => {
    const handler = (): void => undefined;
    decorator({}, 'handler', { value: handler });
    return Reflect.getMetadata(ACCESS_DETAIL_KEY, handler) as AccessDetail | undefined;
  };

  // Break caught: a route that serves no surface, or one that is not a surface, accepted: it would be refused for everyone or served
  // to someone it was never meant for.
  it.each([
    ['no surface', { surfaces: [], activity: 'qualifying' }],
    ['a surface that does not exist', { surfaces: ['ADMIN_PANEL'], activity: 'qualifying' }],
    ['the SYSTEM surface', { surfaces: ['SYSTEM'], activity: 'qualifying' }],
    ['a surface twice', { surfaces: ['OPS_PORTAL', 'OPS_PORTAL'], activity: 'qualifying' }],
    ['surfaces that are not a list', { surfaces: 'OPS_PORTAL', activity: 'qualifying' }],
  ])('refuses %s', (_label, options) => {
    expect(() => Self(options as never)).toThrow(/surfaces it serves/);
    expect(() => RequiresPermission('staff.read', options as never)).toThrow(/surfaces it serves/);
  });

  // Break caught: the activity policy defaulted. A forgotten polling route would then keep an unattended session alive for ever, or
  // a route in use would end the session under the person who is using it (decision A of 12 October 2026).
  it.each([
    ['none', { surfaces: ['OPS_PORTAL'] }],
    ['a policy that does not exist', { surfaces: ['OPS_PORTAL'], activity: 'always' }],
    ['a policy that is empty', { surfaces: ['OPS_PORTAL'], activity: '' }],
  ])('refuses %s as the activity policy, there is no default', (_label, options) => {
    expect(() => Self(options as never)).toThrow(/counts as the person acting/);
  });

  it('keeps both policies as stated, and the surfaces in the order given', () => {
    expect(
      detailOf(Self({ surfaces: ['VENDOR_PWA', 'OPS_PORTAL'], activity: 'background' })),
    ).toEqual({
      authenticated: { surfaces: ['VENDOR_PWA', 'OPS_PORTAL'], activity: 'background' },
    });
  });

  // Break caught: a stated option that a caller can change afterwards, so a declaration is not what the guard reads.
  it('freezes what it keeps', () => {
    const surfaces = ['OPS_PORTAL' as const];
    const kept = detailOf(Self({ surfaces, activity: 'qualifying' }))?.authenticated;
    surfaces.push('VENDOR_PWA' as never);

    expect(kept?.surfaces).toEqual(['OPS_PORTAL']);
    expect(Object.isFrozen(kept)).toBe(true);
    expect(Object.isFrozen(kept?.surfaces)).toBe(true);
  });

  it('keeps the record a route names, and refuses a record scope that is not an entity and a parameter', () => {
    expect(
      detailOf(
        RequiresPermission('staff.read', {
          surfaces: ['OPS_PORTAL'],
          activity: 'qualifying',
          record: { entity: 'staff_identity', param: 'id' },
        }),
      )?.authenticated?.record,
    ).toEqual({ entity: 'staff_identity', param: 'id' });

    for (const record of [
      { entity: 'Staff', param: 'id' },
      { entity: 'staff-identity', param: 'id' },
      { entity: 'staff_identity', param: 'the id' },
      { entity: 'staff_identity', param: '' },
      { entity: 1, param: 'id' },
      'staff_identity',
      null,
    ]) {
      expect(() =>
        Self({ surfaces: ['OPS_PORTAL'], activity: 'qualifying', record: record as never }),
      ).toThrow(/entity and the path parameter/);
    }
  });
});

describe('the tier an authenticated route needs (the review of 12 October 2026, F01)', () => {
  const detailOf = (decorator: MethodDecorator): AccessDetail | undefined => {
    const handler = (): void => undefined;
    decorator({}, 'handler', { value: handler });
    return Reflect.getMetadata(ACCESS_DETAIL_KEY, handler) as AccessDetail | undefined;
  };
  const record = { entity: 'fixture_order', param: 'id' } as const;
  const base = { surfaces: ['OPS_PORTAL'], activity: 'qualifying' } as const;

  // Break caught: the declaration dropped, so the guard has nothing to decide step 6 by and the tier is left to the handler.
  it('keeps a minimum tier, a rule, or both, frozen', () => {
    const kept = detailOf(
      RequiresPermission('staff.read', {
        ...base,
        record,
        tier: { minimum: 'S', rule: 'order_tier' },
      }),
    )?.authenticated?.tier;

    expect(kept).toEqual({ minimum: 'S', rule: 'order_tier' });
    expect(Object.isFrozen(kept)).toBe(true);
    expect(
      detailOf(RequiresPermission('staff.read', { ...base, tier: { minimum: 'P' } }))?.authenticated
        ?.tier,
    ).toEqual({ minimum: 'P' });
    expect(
      detailOf(RequiresPermission('staff.read', { ...base, record, tier: { rule: 'order_tier' } }))
        ?.authenticated?.tier,
    ).toEqual({ rule: 'order_tier' });
  });

  // Break caught: a tier declaration that says nothing, or something that is not a tier, accepted as "no requirement".
  it.each([
    ['nothing', {}],
    ['a minimum that is not a tier', { minimum: 'Z' }],
    ['a lower-case tier', { minimum: 's' }],
    ['a rule with a name that is not an identifier', { rule: 'Order Tier' }],
    ['a rule that is not text', { rule: 7 }],
    ['a declaration that is not an object', 'S'],
    ['null', null],
  ])('refuses %s', (_label, tier) => {
    expect(() =>
      RequiresPermission('staff.read', { ...base, record, tier: tier as never }),
    ).toThrow(/names a minimum tier/);
  });

  // Break caught: a rule on a route that names no record: it would have no id to ask about, and so would never be asked.
  it('refuses a rule on a route that names no record', () => {
    expect(() =>
      RequiresPermission('staff.read', { ...base, tier: { rule: 'order_tier' } }),
    ).toThrow(/names the record/);
  });

  // Break caught: a self operation given a tier, which it has no grant to hold.
  it('refuses a tier on a self operation, which holds no grant', () => {
    expect(() => Self({ ...base, tier: { minimum: 'S' } })).toThrow(/no grant/);
  });
});

describe('what an anonymous route states about its client (S0.25)', () => {
  const clientOf = (decorator: MethodDecorator): AccessDetail['client'] => {
    const handler = (): void => undefined;
    decorator({}, 'handler', { value: handler });
    return (Reflect.getMetadata(ACCESS_DETAIL_KEY, handler) as AccessDetail | undefined)?.client;
  };

  // Break caught: an anonymous route that says nothing taken for native, which would release a pre-session mutation from the Origin
  // check by omission.
  it('is a browser route on both surfaces unless it says otherwise', () => {
    expect(clientOf(Anonymous())).toEqual({
      kind: 'browser',
      surfaces: ['OPS_PORTAL', 'VENDOR_PWA'],
    });
  });

  it('keeps the surfaces a browser route names, and a native route as native', () => {
    expect(clientOf(Anonymous(undefined, { kind: 'browser', surfaces: ['VENDOR_PWA'] }))).toEqual({
      kind: 'browser',
      surfaces: ['VENDOR_PWA'],
    });
    expect(clientOf(Anonymous(undefined, { kind: 'native' }))).toEqual({ kind: 'native' });
  });

  it.each([
    ['a browser route with no surface', { kind: 'browser', surfaces: [] }],
    ['a surface twice', { kind: 'browser', surfaces: ['OPS_PORTAL', 'OPS_PORTAL'] }],
    ['a surface that does not exist', { kind: 'browser', surfaces: ['RIDER_ANDROID'] }],
    ['a client that is neither', { kind: 'robot' }],
    ['no client kind', {}],
  ])('refuses %s', (_label, client) => {
    expect(() => Anonymous(undefined, client as never)).toThrow();
  });
});

describe('RequiresPermission: a key of the closed catalogue', () => {
  // Break caught: a key mistyped (or invented) that would be a permission nobody holds and every request would be refused for,
  // or a keyword such as none or self standing in for a key.
  it.each([
    'staff.read',
    'staff.session.revoke',
    'settings.reason.read',
    'pickup.request.cancel_chargeable',
  ])('accepts %s', (key) => {
    expect(isPermissionKey(key)).toBe(true);
    expect(() => RequiresPermission(key, EVERY_SURFACE)).not.toThrow();
  });

  it.each([
    '',
    'none',
    'self',
    'staff',
    'staff.',
    '.read',
    'staff..read',
    'Staff.read',
    'staff.Read',
    'staff.read ',
    ' staff.read',
    'staff-read',
    'staff.read.too.many',
    'staff.read.too.many.parts',
    '1staff.read',
    'staff.read\n',
  ])('refuses %j', (key) => {
    expect(isPermissionKey(key)).toBe(false);
    expect(() => RequiresPermission(key, EVERY_SURFACE)).toThrow(/not a permission key/);
  });

  // Break caught: the pattern drifting from the catalogue it stands for. Every key the seed holds (the document's order, the
  // document's keys) has the shape the declaration accepts.
  it('accepts every key of the catalogue that is seeded', () => {
    expect(PERMISSION_KEYS.length).toBeGreaterThan(100);
    for (const key of PERMISSION_KEYS) expect(isPermissionKey(key), key).toBe(true);
  });
});

describe('the declarations state the operation in the description, so the guard and the description cannot differ', () => {
  let app: INestApplication | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  @Controller('described')
  class Described {
    @Post('anonymous')
    @ContractOperation('anonymousOperation')
    @Anonymous()
    @ApiResponse({ status: 200, description: 'OK' })
    anonymous(): string {
      return 'x';
    }

    @Get('self')
    @ContractOperation('selfOperation')
    @Self(EVERY_SURFACE)
    @ApiResponse({ status: 200, description: 'OK' })
    self(): string {
      return 'x';
    }

    @Get('permission')
    @ContractOperation('permissionOperation')
    @RequiresPermission('staff.read', EVERY_SURFACE)
    @ApiResponse({ status: 200, description: 'OK' })
    permission(): string {
      return 'x';
    }
  }

  async function document(): Promise<JsonObject> {
    const module = await Test.createTestingModule({ controllers: [Described] }).compile();
    app = module.createNestApplication({ logger: false });
    await app.init();
    return JSON.parse(JSON.stringify(buildOpenApiDocument(app))) as JsonObject;
  }

  const operation = (doc: JsonObject, path: string, method: string): JsonObject => {
    const paths = doc.paths as Record<string, Record<string, JsonObject>>;
    const found = paths[path]?.[method];
    if (found === undefined) throw new Error(`no ${method} ${path}`);
    return found;
  };

  // Break caught (AC-SLICE-000-43): anonymity inferred, or stated by a permission keyword. An anonymous operation says so with an
  // explicit empty requirement, and `x-permission: none` is the contract's word for "no permission to hold".
  it('states an anonymous operation as an explicit empty requirement, with the permission none', async () => {
    const anonymous = operation(await document(), '/described/anonymous', 'post');

    expect(anonymous.security).toEqual([]);
    expect(anonymous['x-permission']).toBe('none');
  });

  it('states an operation on the caller’s own record as inheriting the authenticated default, with the permission self', async () => {
    const self = operation(await document(), '/described/self', 'get');

    expect('security' in self).toBe(false);
    expect(self['x-permission']).toBe('self');
  });

  it('states the permission key of a permission operation, and inherits the authenticated default', async () => {
    const permission = operation(await document(), '/described/permission', 'get');

    expect('security' in permission).toBe(false);
    expect(permission['x-permission']).toBe('staff.read');
  });
});
