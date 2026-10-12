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
    @Self()
    self(): string {
      return 'x';
    }

    @Get('permission')
    @RequiresPermission('staff.read')
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
  it('keep the permission key of a permission declaration, and nothing else', () => {
    expect(detail('permission')).toEqual({ permission: 'staff.read' });
    expect(detail('self')).toBeUndefined();
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
    expect(() => RequiresPermission(key)).not.toThrow();
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
    expect(() => RequiresPermission(key)).toThrow(/not a permission key/);
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
    @Self()
    @ApiResponse({ status: 200, description: 'OK' })
    self(): string {
      return 'x';
    }

    @Get('permission')
    @ContractOperation('permissionOperation')
    @RequiresPermission('staff.read')
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
