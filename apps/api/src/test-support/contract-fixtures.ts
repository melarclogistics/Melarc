import 'reflect-metadata';

import {
  applyDecorators,
  Body,
  Controller,
  Get,
  HttpCode,
  Module,
  Param,
  Post,
  type Type,
} from '@nestjs/common';
import { ContractOperation } from '../platform/contract/contract-operation.js';
import {
  ApiBody,
  ApiExcludeEndpoint,
  ApiExtension,
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiProperty,
  ApiQuery,
  ApiResponse,
  ApiSecurity,
} from '@nestjs/swagger';

import { TechnicalEndpoint } from '../platform/routes/access-declaration.js';

/**
 * A small slice of API written the way product slices will write theirs: controllers with decorators, and
 * DTO classes. It exists only in tests and is never in the production module graph. `FIXTURE_CONTRACT` is
 * the hand-authored contract for it, and the conforming controller is the implementation that matches. Each
 * other controller below has exactly one deliberate defect, so the conformance check is shown to catch it in
 * a real application's own description and not only in edited JSON.
 *
 * The fixture borrows the technical access declaration because the permission declaration arrives with the
 * first product slice; what the checks need from it is only "declared".
 */

export class FixtureErrorDto {
  @ApiProperty({ enum: ['NOT_FOUND', 'STATE_CONFLICT', 'VALIDATION_FAILED'] })
  code!: string;

  @ApiProperty()
  message!: string;

  @ApiProperty()
  request_id!: string;
}

/** An error body that has lost a required property. */
export class FixtureErrorWithoutRequestIdDto {
  @ApiProperty({ enum: ['NOT_FOUND', 'STATE_CONFLICT', 'VALIDATION_FAILED'] })
  code!: string;

  @ApiProperty()
  message!: string;
}

export class WidgetDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: ['DRAFT', 'ACTIVE'] })
  state!: string;

  @ApiProperty({ required: false, nullable: true, type: String })
  note?: string | null;
}

/** A widget whose state accepts a value the contract does not have. */
export class WidgetWithExtraStateDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: ['DRAFT', 'ACTIVE', 'ARCHIVED'] })
  state!: string;

  @ApiProperty({ required: false, nullable: true, type: String })
  note?: string | null;
}

/** A widget whose `note` can no longer be null. */
export class WidgetWithNonNullNoteDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: ['DRAFT', 'ACTIVE'] })
  state!: string;

  @ApiProperty({ required: false, type: String })
  note?: string;
}

/** A class-based body. A decorated class cannot say `additionalProperties: false`, so it describes an open object. */
export class WidgetCreateDto {
  @ApiProperty({ maxLength: 40 })
  label!: string;

  @ApiProperty({ required: false, type: Boolean })
  urgent?: boolean;
}

/** The body the contract describes: closed, so nothing the contract does not name is accepted. */
export const CREATE_BODY_SCHEMA = {
  type: 'object',
  required: ['label'],
  additionalProperties: false,
  properties: {
    label: { type: 'string', maxLength: 40 },
    urgent: { type: 'boolean' },
  },
} as const;

const IDEMPOTENCY_KEY = { type: 'string', maxLength: 128 } as const;

interface ReadOptions {
  /** Whether the handler is bound to its operation; when not, only the description names it. */
  readonly bound?: boolean;
  readonly response?: Type<unknown>;
  readonly withNotFound?: boolean;
  readonly notFound?: Type<unknown>;
  readonly withEtag?: boolean;
  readonly permission?: string;
}

/** What describes `GET /widgets/{id}`, with the one thing a variant gets wrong passed in. */
function describeRead(options: ReadOptions = {}): MethodDecorator {
  const {
    bound = true,
    response = WidgetDto,
    withNotFound = true,
    notFound = FixtureErrorDto,
    withEtag = true,
    permission = 'widget.read',
  } = options;
  return applyDecorators(
    bound ? ContractOperation('getWidget') : ApiOperation({ operationId: 'getWidget' }),
    ApiParam({ name: 'id', format: 'uuid', type: String }),
    ApiExtension('x-permission', permission),
    ApiResponse({
      status: 200,
      type: response,
      ...(withEtag
        ? { headers: { ETag: { description: 'Record version', schema: { type: 'string' } } } }
        : {}),
    }),
    ...(withNotFound ? [ApiResponse({ status: 404, type: notFound })] : []),
  );
}

interface CreateOptions {
  readonly body?: { schema: object } | { type: Type<unknown> };
  /** The credential scheme the operation names; `null` leaves the operation with none. */
  readonly security?: string | null;
  readonly withIdempotencyKey?: boolean;
}

/** What describes `POST /widgets`. */
function describeCreate(options: CreateOptions = {}): MethodDecorator {
  const {
    body = { schema: CREATE_BODY_SCHEMA },
    security = 'browserSession',
    withIdempotencyKey = true,
  } = options;
  return applyDecorators(
    ContractOperation('createWidget'),
    ...(withIdempotencyKey
      ? [ApiHeader({ name: 'Idempotency-Key', required: true, schema: IDEMPOTENCY_KEY })]
      : []),
    ApiBody(body),
    ...(security === null ? [] : [ApiSecurity(security)]),
    ApiQuery({ name: 'dry_run', required: false, type: Boolean }),
    ApiExtension('x-permission', 'widget.create'),
    ApiResponse({ status: 201, type: WidgetDto }),
    ApiResponse({ status: 409, type: FixtureErrorDto }),
  );
}

/** The implementation that matches `FIXTURE_CONTRACT`. */
@Controller('widgets')
@TechnicalEndpoint()
export class ConformingWidgetsController {
  @Get(':id')
  @describeRead()
  read(@Param('id') id: string): { id: string } {
    return { id };
  }

  @Post()
  @HttpCode(201)
  @describeCreate()
  create(@Body() body: unknown): unknown {
    return body;
  }
}

@Controller('widgets')
@TechnicalEndpoint()
export class RequiredDriftWidgetsController {
  @Get(':id')
  @describeRead()
  read(@Param('id') id: string): { id: string } {
    return { id };
  }

  @Post()
  @HttpCode(201)
  @describeCreate({ body: { schema: { ...CREATE_BODY_SCHEMA, required: [] } } })
  create(@Body() body: unknown): unknown {
    return body;
  }
}

@Controller('widgets')
@TechnicalEndpoint()
export class EnumDriftWidgetsController {
  @Get(':id')
  @describeRead({ response: WidgetWithExtraStateDto })
  read(@Param('id') id: string): { id: string } {
    return { id };
  }

  @Post()
  @HttpCode(201)
  @describeCreate()
  create(@Body() body: unknown): unknown {
    return body;
  }
}

@Controller('widgets')
@TechnicalEndpoint()
export class NullableDriftWidgetsController {
  @Get(':id')
  @describeRead({ response: WidgetWithNonNullNoteDto })
  read(@Param('id') id: string): { id: string } {
    return { id };
  }

  @Post()
  @HttpCode(201)
  @describeCreate()
  create(@Body() body: unknown): unknown {
    return body;
  }
}

/** The contract closes the body; a decorated class describes it open. */
@Controller('widgets')
@TechnicalEndpoint()
export class OpenBodyWidgetsController {
  @Get(':id')
  @describeRead()
  read(@Param('id') id: string): { id: string } {
    return { id };
  }

  @Post()
  @HttpCode(201)
  @describeCreate({ body: { type: WidgetCreateDto } })
  create(@Body() body: WidgetCreateDto): unknown {
    return body;
  }
}

@Controller('widgets')
@TechnicalEndpoint()
export class MissingErrorWidgetsController {
  @Get(':id')
  @describeRead({ withNotFound: false })
  read(@Param('id') id: string): { id: string } {
    return { id };
  }

  @Post()
  @HttpCode(201)
  @describeCreate()
  create(@Body() body: unknown): unknown {
    return body;
  }
}

@Controller('widgets')
@TechnicalEndpoint()
export class ErrorBodyDriftWidgetsController {
  @Get(':id')
  @describeRead({ notFound: FixtureErrorWithoutRequestIdDto })
  read(@Param('id') id: string): { id: string } {
    return { id };
  }

  @Post()
  @HttpCode(201)
  @describeCreate()
  create(@Body() body: unknown): unknown {
    return body;
  }
}

/** Signs a state-changing operation in as the Rider, where the contract says the browser session. */
@Controller('widgets')
@TechnicalEndpoint()
export class SecurityDriftWidgetsController {
  @Get(':id')
  @describeRead()
  read(@Param('id') id: string): { id: string } {
    return { id };
  }

  @Post()
  @HttpCode(201)
  @describeCreate({ security: 'riderSession' })
  create(@Body() body: unknown): unknown {
    return body;
  }
}

/** Leaves a state-changing operation open to anyone. */
@Controller('widgets')
@TechnicalEndpoint()
export class AnonymousWidgetsController {
  @Get(':id')
  @describeRead()
  read(@Param('id') id: string): { id: string } {
    return { id };
  }

  @Post()
  @HttpCode(201)
  @describeCreate({ security: null })
  create(@Body() body: unknown): unknown {
    return body;
  }
}

@Controller('widgets')
@TechnicalEndpoint()
export class HeaderDriftWidgetsController {
  @Get(':id')
  @describeRead({ withEtag: false })
  read(@Param('id') id: string): { id: string } {
    return { id };
  }

  @Post()
  @HttpCode(201)
  @describeCreate({ withIdempotencyKey: false })
  create(@Body() body: unknown): unknown {
    return body;
  }
}

@Controller('widgets')
@TechnicalEndpoint()
export class ExtensionDriftWidgetsController {
  @Get(':id')
  @describeRead({ permission: 'widget.admin' })
  read(@Param('id') id: string): { id: string } {
    return { id };
  }

  @Post()
  @HttpCode(201)
  @describeCreate()
  create(@Body() body: unknown): unknown {
    return body;
  }
}

/** Hides an implemented route from the application's own description. */
@Controller('widgets')
@TechnicalEndpoint()
export class HiddenWidgetsController {
  @Get(':id')
  @ApiExcludeEndpoint()
  @describeRead()
  read(@Param('id') id: string): { id: string } {
    return { id };
  }

  @Post()
  @HttpCode(201)
  @describeCreate()
  create(@Body() body: unknown): unknown {
    return body;
  }
}

/** Serves a route the contract has never heard of. */
@Controller('widgets')
@TechnicalEndpoint()
export class UndocumentedRouteWidgetsController {
  @Get(':id')
  @describeRead()
  read(@Param('id') id: string): { id: string } {
    return { id };
  }

  @Post()
  @HttpCode(201)
  @describeCreate()
  create(@Body() body: unknown): unknown {
    return body;
  }

  @Get('debug/dump')
  @ApiOperation({ operationId: 'dumpWidgets' })
  dump(): { all: boolean } {
    return { all: true };
  }
}

/** Implements the operation and describes it correctly, but is not bound to it, so nothing validates its requests. */
@Controller('widgets')
@TechnicalEndpoint()
export class UnboundWidgetsController {
  @Get(':id')
  @describeRead({ bound: false })
  read(@Param('id') id: string): { id: string } {
    return { id };
  }

  @Post()
  @HttpCode(201)
  @describeCreate()
  create(@Body() body: unknown): unknown {
    return body;
  }
}

/** Implements only one of the two operations that the scope claims. */
@Controller('widgets')
@TechnicalEndpoint()
export class ReadOnlyWidgetsController {
  @Get(':id')
  @describeRead()
  read(@Param('id') id: string): { id: string } {
    return { id };
  }
}

/** The response schema of `GADGET_CONTRACT`, with the one thing a variant gets wrong passed in. */
function gadgetSchema(options: { repeatedKind?: boolean; looseMarker?: boolean } = {}): object {
  return {
    type: 'object',
    required: ['kind', 'marker'],
    properties: {
      kind: {
        oneOf: options.repeatedKind
          ? [{ type: 'string' }, { type: 'string' }]
          : [{ type: 'string' }],
      },
      marker: options.looseMarker ? {} : { const: null },
    },
  };
}

/** What describes `GET /gadgets`: an array in the query, and a response that leans on `oneOf` and `const: null`. */
function describeGadgets(
  options: { explode?: boolean; repeatedKind?: boolean; looseMarker?: boolean } = {},
): MethodDecorator {
  return applyDecorators(
    ContractOperation('listGadgets'),
    ApiQuery({
      name: 'ids',
      required: false,
      schema: { type: 'array', items: { type: 'string', format: 'uuid' } },
      ...(options.explode === undefined ? {} : { explode: options.explode }),
    }),
    ApiExtension('x-permission', 'gadget.read'),
    ApiResponse({ status: 200, schema: gadgetSchema(options) }),
  );
}

/** The implementation that matches `GADGET_CONTRACT`. */
@Controller('gadgets')
@TechnicalEndpoint()
export class ConformingGadgetsController {
  @Get()
  @describeGadgets()
  list(): unknown {
    return { kind: 'k', marker: null };
  }
}

/** Writes the array in the query as `ids=a,b` where the contract has `ids=a&ids=b`. */
@Controller('gadgets')
@TechnicalEndpoint()
export class ExplodeDriftGadgetsController {
  @Get()
  @describeGadgets({ explode: false })
  list(): unknown {
    return { kind: 'k', marker: null };
  }
}

/** Describes a `oneOf` branch twice, so that nothing can match exactly one. */
@Controller('gadgets')
@TechnicalEndpoint()
export class RepeatedBranchGadgetsController {
  @Get()
  @describeGadgets({ repeatedKind: true })
  list(): unknown {
    return { kind: 'k', marker: null };
  }
}

/** Forgets that `marker` is always null, so any value is described as allowed. */
@Controller('gadgets')
@TechnicalEndpoint()
export class LooseMarkerGadgetsController {
  @Get()
  @describeGadgets({ looseMarker: true })
  list(): unknown {
    return { kind: 'k', marker: null };
  }
}

function moduleOf(controller: Type<unknown>): Type<unknown> {
  @Module({ controllers: [controller] })
  class FixtureWidgetsModule {}
  return FixtureWidgetsModule;
}

export const ConformingWidgetsModule = moduleOf(ConformingWidgetsController);
export const RequiredDriftWidgetsModule = moduleOf(RequiredDriftWidgetsController);
export const EnumDriftWidgetsModule = moduleOf(EnumDriftWidgetsController);
export const NullableDriftWidgetsModule = moduleOf(NullableDriftWidgetsController);
export const OpenBodyWidgetsModule = moduleOf(OpenBodyWidgetsController);
export const MissingErrorWidgetsModule = moduleOf(MissingErrorWidgetsController);
export const ErrorBodyDriftWidgetsModule = moduleOf(ErrorBodyDriftWidgetsController);
export const SecurityDriftWidgetsModule = moduleOf(SecurityDriftWidgetsController);
export const AnonymousWidgetsModule = moduleOf(AnonymousWidgetsController);
export const HeaderDriftWidgetsModule = moduleOf(HeaderDriftWidgetsController);
export const ExtensionDriftWidgetsModule = moduleOf(ExtensionDriftWidgetsController);
export const HiddenWidgetsModule = moduleOf(HiddenWidgetsController);
export const UndocumentedRouteWidgetsModule = moduleOf(UndocumentedRouteWidgetsController);
export const ReadOnlyWidgetsModule = moduleOf(ReadOnlyWidgetsController);
export const UnboundWidgetsModule = moduleOf(UnboundWidgetsController);
export const ConformingGadgetsModule = moduleOf(ConformingGadgetsController);
export const ExplodeDriftGadgetsModule = moduleOf(ExplodeDriftGadgetsController);
export const RepeatedBranchGadgetsModule = moduleOf(RepeatedBranchGadgetsController);
export const LooseMarkerGadgetsModule = moduleOf(LooseMarkerGadgetsController);

/** The hand-authored contract for the gadget fixture: facts that `FIXTURE_CONTRACT` has no occasion to state. */
export const GADGET_CONTRACT = {
  openapi: '3.1.0',
  info: { title: 'Gadget fixture contract', version: '1' },
  servers: [{ url: '/api/v1' }],
  security: [],
  paths: {
    '/gadgets': {
      get: {
        operationId: 'listGadgets',
        security: [],
        'x-permission': 'gadget.read',
        parameters: [
          {
            name: 'ids',
            in: 'query',
            required: false,
            schema: { type: 'array', items: { type: 'string', format: 'uuid' } },
          },
        ],
        responses: {
          '200': {
            description: 'OK',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Gadget' } } },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      Gadget: {
        type: 'object',
        required: ['kind', 'marker'],
        properties: {
          kind: { oneOf: [{ type: 'string' }] },
          marker: { const: null },
        },
      },
    },
  },
} as const;

/** The security schemes `FIXTURE_CONTRACT` defines, which the application's own description does not yet carry. */
export const FIXTURE_SECURITY_SCHEMES = {
  browserSession: { type: 'apiKey', in: 'cookie', name: 'melarc_session' },
  riderSession: { type: 'http', scheme: 'bearer' },
} as const;

/** The hand-authored contract for the fixture, written as a person would write it, not generated. */
export const FIXTURE_CONTRACT = {
  openapi: '3.1.0',
  info: { title: 'Fixture contract', version: '1' },
  servers: [{ url: '/api/v1' }],
  security: [],
  paths: {
    '/widgets/{id}': {
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      get: {
        operationId: 'getWidget',
        security: [],
        'x-permission': 'widget.read',
        responses: {
          '200': {
            description: 'OK',
            headers: { ETag: { description: 'Record version', schema: { type: 'string' } } },
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Widget' } } },
          },
          '404': {
            description: 'Not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
          },
        },
      },
    },
    '/widgets': {
      post: {
        operationId: 'createWidget',
        security: [{ browserSession: [] }],
        'x-permission': 'widget.create',
        parameters: [
          { name: 'Idempotency-Key', in: 'header', required: true, schema: IDEMPOTENCY_KEY },
          { name: 'dry_run', in: 'query', required: false, schema: { type: 'boolean' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/WidgetCreate' } },
          },
        },
        responses: {
          '201': {
            description: 'Created',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Widget' } } },
          },
          '409': {
            description: 'Conflict',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
          },
        },
      },
    },
  },
  components: {
    securitySchemes: FIXTURE_SECURITY_SCHEMES,
    schemas: {
      Widget: {
        type: 'object',
        required: ['id', 'state'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          state: { type: 'string', enum: ['DRAFT', 'ACTIVE'] },
          note: { type: ['string', 'null'] },
        },
      },
      WidgetCreate: CREATE_BODY_SCHEMA,
      Error: {
        type: 'object',
        required: ['code', 'message', 'request_id'],
        properties: {
          code: { type: 'string', enum: ['NOT_FOUND', 'STATE_CONFLICT', 'VALIDATION_FAILED'] },
          message: { type: 'string' },
          request_id: { type: 'string' },
        },
      },
    },
  },
} as const;
