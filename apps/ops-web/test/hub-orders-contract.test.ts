import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import { SIGNED_IN_ROUTES } from '../src/app/navigation/route-registry';
import {
  BLOCKERS,
  COMMERCIAL_MODES,
  COMMERCIAL_STATES,
  CORRECTION_STATES,
  CORRECTION_VIEWS,
  GATE_STATES,
  LANES,
  PARCEL_ORIGINS,
  PARCEL_STATES,
  PAYER_INTENTS,
  PRICE_STATUSES,
  RECEIVING_MODES,
  RESOLUTIONS,
  SIZE_CLASSES,
  SPLIT_BASES,
  WILL_CONFIRM,
  WORK_STATES,
  WORKLIST_VIEWS,
} from '../src/platform/hub-orders/orders-shape';
import { captured, termsOf } from '../src/test-support/orders-fixture';

/**
 * The guards that judge the answers of the order screens (`src/platform/hub-orders/orders-shape.ts`) are runtime checks, not a second description of the wire: the types are the generated ones. This test reads the
 * contract and holds the screens to it: **every value of an enumeration a guard recognises is one the contract has, and the other way round** (a value the contract adds would otherwise be refused by a screen that
 * has no words for it); **each screen is behind the key of the operation that is its point**; each act sends the headers its operation declares (a preview none, a save a key and a version); and **every real answer
 * the tests are made of** (`test/fixtures/orders`, captured from the API) **has every member the contract requires and none it does not name**, so a test built from them is true to the contract. **The vendor's summary
 * has no member that could carry a phone number, an address or a key**: it is the vendor's own view and nothing of the hub's.
 */
const CONTRACT = resolve(import.meta.dirname, '../../../contracts/openapi.yaml');

interface Schema {
  readonly type?: string | readonly string[];
  readonly enum?: readonly (string | null)[];
  readonly required?: readonly string[];
  readonly properties?: Record<string, Schema>;
  readonly items?: Schema;
  readonly $ref?: string;
  readonly allOf?: readonly Schema[];
  readonly oneOf?: readonly Schema[];
  readonly anyOf?: readonly Schema[];
  readonly additionalProperties?: boolean | Schema;
}
interface Parameter {
  readonly $ref?: string;
  readonly name?: string;
  readonly in?: string;
  readonly required?: boolean;
  readonly schema?: Schema;
}
interface Operation {
  readonly operationId?: string;
  readonly 'x-permission'?: string;
  readonly 'x-error-codes'?: readonly string[];
  readonly parameters?: readonly Parameter[];
}

const document = parse(readFileSync(CONTRACT, 'utf8')) as {
  components: { schemas: Record<string, Schema>; parameters: Record<string, Parameter> };
  paths: Record<string, Record<string, unknown> & { parameters?: readonly Parameter[] }>;
};

const nameOf = (reference: string): string => reference.split('/').at(-1) ?? '';
const schemaNamed = (name: string): Schema => {
  const schema = document.components.schemas[name];
  if (schema === undefined) throw new Error(`The contract has no schema ${name}`);
  return schema;
};
/** A schema with its `$ref` followed (and its `allOf` parts joined), so that a member is found wherever the contract wrote it. */
function resolved(schema: Schema | undefined): Schema {
  if (schema === undefined) return {};
  if (schema.$ref !== undefined)
    return resolved(
      schema.$ref.startsWith('#/components/schemas/') ? schemaNamed(nameOf(schema.$ref)) : {},
    );
  if (schema.allOf !== undefined) {
    const parts = schema.allOf.map(resolved);
    return {
      ...schema,
      required: parts.flatMap((part) => [...(part.required ?? [])]),
      properties: Object.assign({}, ...parts.map((part) => part.properties ?? {})) as Record<
        string,
        Schema
      >,
      enum: parts.flatMap((part) => [...(part.enum ?? [])]),
    };
  }
  return schema;
}
/** The values of an enumeration where a member points at one, through `$ref`s, `oneOf`/`anyOf` (a nullable member) and `items` (a list of values). */
function enumValues(schema: Schema | undefined): string[] {
  if (schema === undefined) return [];
  const direct = resolved(schema);
  const found = [...(direct.enum ?? [])];
  for (const part of [...(direct.oneOf ?? []), ...(direct.anyOf ?? [])])
    found.push(...enumValues(part));
  if (direct.items !== undefined) found.push(...enumValues(direct.items));
  return found.filter((value): value is string => value !== null);
}
const memberOf = (schemaName: string, ...path: string[]): Schema | undefined => {
  let current: Schema | undefined = schemaNamed(schemaName);
  for (const member of path) {
    const next: Schema = resolved(current);
    current =
      next.properties?.[member] ??
      (next.items === undefined ? undefined : resolved(next.items).properties?.[member]);
  }
  return current;
};

const operations = Object.values(document.paths).flatMap((item) =>
  Object.values(item).filter(
    (candidate): candidate is Operation =>
      typeof candidate === 'object' && candidate !== null && 'operationId' in candidate,
  ),
);
const operationNamed = (operationId: string): Operation => {
  const operation = operations.find((candidate) => candidate.operationId === operationId);
  if (operation === undefined) throw new Error(`The contract has no operation ${operationId}`);
  return operation;
};
function parametersOf(operationId: string): Parameter[] {
  return (operationNamed(operationId).parameters ?? []).map((each) =>
    each.$ref === undefined ? each : (document.components.parameters[nameOf(each.$ref)] ?? {}),
  );
}
const parameterOf = (operationId: string, name: string): Parameter | undefined =>
  parametersOf(operationId).find((parameter) => parameter.name === name);

describe('the values the guards recognise are the contract’s', () => {
  const sorted = (values: readonly string[]): string[] => [...values].toSorted();

  // Break caught: a value the guard takes that the contract does not have, or one the contract adds that a screen would refuse for want of words.
  it.each([
    ['SIZE_CLASSES', SIZE_CLASSES, enumValues(memberOf('Order', 'size_class'))],
    // The order's own `lane` and `commercial_mode` are plain strings in the answer; their values are those the request names.
    ['LANES', LANES, enumValues(memberOf('OrderItemizePreview', 'lane'))],
    [
      'COMMERCIAL_MODES',
      COMMERCIAL_MODES,
      enumValues(memberOf('OrderItemizePreview', 'commercial_mode')),
    ],
    ['COMMERCIAL_STATES', COMMERCIAL_STATES, enumValues(memberOf('Order', 'commercial_state'))],
    ['PRICE_STATUSES', PRICE_STATUSES, enumValues(memberOf('Order', 'price_status'))],
    ['RESOLUTIONS', RESOLUTIONS, enumValues(memberOf('Order', 'destination_zone_resolution'))],
    ['PAYER_INTENTS', PAYER_INTENTS, enumValues(memberOf('PayerAllocationInput', 'payer_intent'))],
    ['SPLIT_BASES', SPLIT_BASES, enumValues(memberOf('PayerAllocationInput', 'split_basis'))],
    ['WILL_CONFIRM', WILL_CONFIRM, enumValues(memberOf('OrderPreview', 'will_confirm'))],
    [
      'GATE_STATES',
      GATE_STATES,
      enumValues(memberOf('OrderPreview', 'payer', 'commercial_state_after_confirmation')),
    ],
    ['CORRECTION_STATES', CORRECTION_STATES, enumValues(memberOf('PayerCorrection', 'state'))],
    ['WORK_STATES', WORK_STATES, enumValues(memberOf('IntakeOrderList', 'items', 'work_state'))],
    ['BLOCKERS', BLOCKERS, enumValues(memberOf('IntakeClosureAssessment', 'blockers'))],
    ['RECEIVING_MODES', RECEIVING_MODES, enumValues(schemaNamed('ReceivingMode'))],
    ['PARCEL_STATES', PARCEL_STATES, enumValues(schemaNamed('IntakeParcelState'))],
    ['PARCEL_ORIGINS', PARCEL_ORIGINS, enumValues(schemaNamed('IntakeParcelOrigin'))],
    [
      'the worklist views',
      WORKLIST_VIEWS,
      enumValues(parameterOf('listIntakeOrders', 'view')?.schema),
    ],
    [
      'the correction views',
      CORRECTION_VIEWS,
      enumValues(parameterOf('listPayerCorrections', 'state')?.schema),
    ],
  ] as const)('%s', (name, guard, declared) => {
    expect(declared.length, `${name}: the contract's values were not found`).toBeGreaterThan(0);
    expect(sorted(guard)).toEqual(sorted(declared));
  });
});

describe('each screen is behind the key of the operation that is its point', () => {
  const keyOf = (path: string): string | undefined => {
    const route = SIGNED_IN_ROUTES.find((each) => each.path === path);
    if (route === undefined) throw new Error(`No route ${path}`);
    return typeof route.access === 'object' ? route.access.permission : undefined;
  };

  // Break caught: a screen that opens for a key its operation does not need (the officer sees a page whose every read is refused), or one that needs a key its operation does not ask for.
  it.each([
    ['/orders-to-make', 'listHubIntakes'],
    ['/intakes/:id/orders', 'listIntakeOrders'],
    ['/intakes/:id/orders/new', 'itemizeOrder'],
    ['/intakes/:id/close', 'closeHubIntake'],
    ['/intakes/:id/summary', 'getIntakeSummary'],
    ['/orders/:id', 'getOrder'],
    ['/orders/:id/amend', 'amendOrder'],
    ['/payer-corrections', 'listPayerCorrections'],
    ['/payer-corrections/:id', 'getPayerCorrection'],
    ['/closed-vendors', 'listClosedIntakeExceptions'],
  ])('%s opens for the key of %s', (path, operationId) => {
    expect(keyOf(path)).toBe(operationNamed(operationId)['x-permission']);
  });

  // Break caught: an act offered for a key the contract does not ask of it (it would be drawn and then refused), or the wrong act behind a button.
  it.each([
    ['previewOrder', 'hub.intake.itemize'],
    ['itemizeOrder', 'hub.intake.itemize'],
    ['previewOrderAmendment', 'hub.intake.itemize'],
    ['amendOrder', 'hub.intake.itemize'],
    ['reverseOrderArrival', 'hub.osd.adjudicate'],
    ['correctOrderRecipient', 'hub.intake.itemize'],
    ['setParcelWaitingForVendor', 'hub.intake.itemize'],
    // The read of the hub's zones, for an address that matches none, is asked under the key of the order form.
    ['listDestinationZones', 'hub.intake.itemize'],
    ['requestPayerCorrection', 'pricing.correction.create'],
    ['approvePayerCorrection', 'pricing.correction.approve'],
    ['getIntakeClosure', 'hub.intake.close'],
    ['closeHubIntake', 'hub.intake.close'],
    ['getOrder', 'pricing.read'],
    ['getIntakeSummary', 'pickup.read'],
  ])('%s asks for %s', (operationId, key) => {
    expect(operationNamed(operationId)['x-permission']).toBe(key);
  });
});

describe('each act sends the headers its operation declares, and no other', () => {
  const headersOf = (operationId: string): string[] =>
    parametersOf(operationId)
      .filter((parameter) => parameter.in === 'header')
      .map((parameter) => parameter.name ?? '')
      .toSorted();

  // Break caught: a preview that is sent a key and a version (it changes nothing), or a save sent without them (a lost answer would make an order twice, an order that changed would be overwritten).
  it.each([
    ['previewOrder', []],
    ['previewOrderAmendment', []],
    ['itemizeOrder', ['Idempotency-Key', 'If-Match']],
    ['amendOrder', ['Idempotency-Key', 'If-Match']],
    ['reverseOrderArrival', ['Idempotency-Key', 'If-Match']],
    ['correctOrderRecipient', ['Idempotency-Key', 'If-Match']],
    // The mark states the parcel's desired state, so it takes no key (idempotent by nature), and the vendor's version.
    ['setParcelWaitingForVendor', ['If-Match']],
    // A read of the zones sends no header at all.
    ['listDestinationZones', []],
    ['requestPayerCorrection', ['Idempotency-Key', 'If-Match']],
    ['approvePayerCorrection', ['Idempotency-Key', 'If-Match']],
    ['closeHubIntake', ['Idempotency-Key', 'If-Match']],
  ])('%s', (operationId, headers) => {
    expect(headersOf(operationId)).toEqual(headers);
  });

  it('declares the refusals the words of the screens are written for', () => {
    // Every operation of the screens can be refused for want of the key, and the words for it are the capability's.
    for (const operationId of [
      'itemizeOrder',
      'amendOrder',
      'reverseOrderArrival',
      'correctOrderRecipient',
      'approvePayerCorrection',
      'closeHubIntake',
    ]) {
      expect(operationNamed(operationId)['x-error-codes'], operationId).toContain(
        'PERMISSION_DENIED',
      );
      expect(operationNamed(operationId)['x-error-codes'], operationId).toContain('STATE_CONFLICT');
    }
    // The two refusals that come back as results are conflicts of the save and of the close.
    expect(operationNamed('itemizeOrder')['x-error-codes']).toContain('STATE_CONFLICT');
    expect(operationNamed('closeHubIntake')['x-error-codes']).toContain('STATE_CONFLICT');
  });
});

describe('the answers the tests are made of are the contract’s', () => {
  const SCHEMAS: readonly (readonly [string, readonly string[]])[] = [
    [
      'Order',
      [
        'order',
        'order-early',
        'order-reversed',
        'order-saved',
        'amend-saved',
        'order-with-photo',
        'order-corrected',
      ],
    ],
    // The mark of a parcel the officer is waiting on (Run G1, D-S7-12), as the API answered it.
    ['ParcelWaitingForVendor', ['parcel-wait', 'parcel-wait-off']],
    // The hub's zones the form offers for an address that matches none (Run G1, D-S7-5), as the API answered.
    ['DestinationZoneList', ['destination-zones']],
    ['OrderPreview', ['preview', 'amend-preview']],
    ['OrderArrivalReversal', ['reversal']],
    ['PayerCorrection', ['correction', 'correction-requested', 'correction-decided']],
    ['PayerCorrectionPage', ['corrections-list']],
    ['IntakeSummary', ['summary-officer', 'summary-no-price']],
    ['IntakeClosureAssessment', ['closure-ready', 'closure-exception', 'closure-needs-exception']],
    ['ClosedIntakeExceptionPage', ['closed-exceptions']],
    [
      'IntakeOrderList',
      [
        'worklist-photo',
        'worklist-needs-order',
        'worklist-early',
        'worklist-reversed',
        'worklist-blind',
        'worklist-blind-awaiting',
        'worklist-waiting',
        'worklist-waiting-view',
        'worklist-needs-order-waiting',
      ],
    ],
  ];

  // Break caught: a captured answer that lacks a member the contract requires, or has one it does not name (a test would be proving a screen against a wire that does not exist).
  for (const [schemaName, fixtures] of SCHEMAS) {
    for (const fixture of fixtures) {
      it(`${fixture}: has every member of ${schemaName} that the contract requires, and none it does not name`, () => {
        const answer = captured(fixture);
        const schema = resolved(schemaNamed(schemaName));
        const members = Object.keys(schema.properties ?? {});
        for (const required of schema.required ?? [])
          expect(Object.keys(answer), `${fixture}.${required}`).toContain(required);
        for (const member of Object.keys(answer))
          expect(members, `${fixture}.${member}`).toContain(member);
      });
    }
  }
});

describe('who pays adds up to the price in every answer the tests are made of', () => {
  // Break caught: a price of another figure that carries the portions it was captured with (a sender and a recipient that do not add up to the total), which a screen would draw as it was given and a test would
  // then hold as right.
  it.each([3500, 4000, 4500, 5000])('in the preview of a price of %i', (total) => {
    const terms = termsOf({}, total) as {
      price: { total: { amount_minor: number } };
      payer: { sender: { amount_minor: number }; recipient: { amount_minor: number } };
    };
    expect(terms.price.total.amount_minor).toBe(total);
    expect(terms.payer.sender.amount_minor + terms.payer.recipient.amount_minor).toBe(total);
  });
});

describe('the vendor’s summary', () => {
  // Break caught: a member that could carry a number to dial, an address or a key added to the summary, which the screen would then draw: the summary is the vendor's own view and nothing of the hub's.
  it('has no member that could carry a phone number, an address or a key', () => {
    for (const name of ['IntakeSummary', 'VendorOrderSummary']) {
      for (const member of Object.keys(schemaNamed(name).properties ?? {})) {
        expect(member, `${name}.${member}`).not.toMatch(
          /phone|mobile|msisdn|email|address|landmark|object_key|storage|url|signed|token$|serial|imei/i,
        );
      }
      expect(schemaNamed(name).additionalProperties, name).toBe(false);
    }
  });

  it('says nothing of the receiving side: no count of the rider’s, no declaration, no finding', () => {
    for (const member of [
      ...Object.keys(schemaNamed('IntakeSummary').properties ?? {}),
      ...Object.keys(schemaNamed('VendorOrderSummary').properties ?? {}),
    ]) {
      expect(member).not.toMatch(/count|declar|discrep|condition|adjudic|evidence|parcel/i);
    }
  });
});
