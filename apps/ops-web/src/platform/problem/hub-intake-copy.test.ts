import { ApiError } from '@melarc/api-client/browser';
import { describe, expect, it } from 'vitest';

import { OperationFailure } from '../api/api-response';
import { HUB_INTAKE_COPY } from './hub-intake-copy';
import { problemOf, PROBLEM_COPY } from './problem-copy';

/**
 * What is left of the first words of the receiving screens (S1.35), in the one table the Ops Portal keeps, keyed by operation, context and code: **the steps of a photo** that every
 * receiving screen shares. The words of a vendor's record, its count, its damage and its decision are `receiving-copy.ts`'s, in the floor's voice, and are held by `receiving-copy.test.ts`. The tests pin that
 * each refused act names its own capability and no key or role, that a step of a photo made for a senior's decision is refused in the decision's capability, and that no wording draws a figure of a count or names
 * an officer.
 */
const refused = (code: string | undefined, status: number): ApiError =>
  new ApiError({ kind: 'http', status, ...(code === undefined ? {} : { code }) });
const conflict = (rule: string | undefined): OperationFailure =>
  new OperationFailure(refused('STATE_CONFLICT', 409), [], rule === undefined ? {} : { rule });

const OPERATIONS = [
  'createEvidence',
  'completeEvidenceUpload',
  'createEvidenceRetrievalAuthorization',
];

describe('the words of the table', () => {
  it('are in the table the screens read', () => {
    for (const rule of HUB_INTAKE_COPY) expect(PROBLEM_COPY).toContain(rule);
  });

  // Break caught: a rule written for a place nothing asks for, which is words nobody will ever read.
  it('has no rule for an operation these screens do not call', () => {
    for (const rule of HUB_INTAKE_COPY) expect(OPERATIONS, rule.text).toContain(rule.operation);
  });

  // Break caught: an operation of these screens with no words of its own, so a refusal of it is told as a generic failure.
  it('has words for every operation of these screens, the vendor’s photo among them', () => {
    for (const operation of OPERATIONS) {
      expect(
        HUB_INTAKE_COPY.some(
          (rule) =>
            rule.operation === operation &&
            rule.code === undefined &&
            (rule.context === undefined || rule.context === 'intake'),
        ),
        operation,
      ).toBe(true);
    }
  });

  it('has no two rules for the same place, here or in the rest of the table', () => {
    const place = (rule: { operation?: string; context?: string; code?: string }) =>
      `${rule.operation ?? ''}|${rule.context ?? ''}|${rule.code ?? ''}`;
    const mine = HUB_INTAKE_COPY.map(place);
    expect(new Set(mine).size).toBe(mine.length);
    const others = new Set(
      PROBLEM_COPY.filter((rule) => !HUB_INTAKE_COPY.includes(rule)).map(place),
    );
    for (const each of mine) expect(others.has(each), each).toBe(false);
  });
});

describe('the words of the refusals of authority', () => {
  // Break caught (PRODUCT_DESIGN_DIRECTION section 6.5): a refusal that names a key, or the wrong act, so that an administrator is asked to grant the wrong access.
  it.each([['createEvidence', /check in the parcels received at a hub/]])(
    'names the capability of %s and never a key',
    (operation, words) => {
      const message = problemOf(refused('PERMISSION_DENIED', 403), { operation }).message;
      expect(message).toMatch(words);
      expect(message).not.toMatch(/\bhub\.[a-z_]+|permission|\brole\b|Ops Staff|Senior Ops/i);
    },
  );

  // Break caught: a photo made for a senior's decision refused in the receiver's capability, or with a way out through an administrator, who cannot make a senior officer's decision.
  it('refuses a photo made for a decision as a senior officer’s, and one made at the door in the receiver’s', () => {
    const decision = problemOf(refused('PERMISSION_DENIED', 403), {
      operation: 'createEvidence',
      context: 'decision',
    }).message;
    expect(decision).toBe('A senior officer decides this. Ask one to open this page.');
    expect(decision).not.toMatch(/administrator/i);
    expect(
      problemOf(refused('PERMISSION_DENIED', 403), { operation: 'createEvidence' }).message,
    ).toMatch(/check in the parcels received at a hub/);
  });

  it('words a photo of a vendor in the key that reads the vendor, and a stop’s photo in its own words', () => {
    expect(
      problemOf(refused('PERMISSION_DENIED', 403), {
        operation: 'createEvidenceRetrievalAuthorization',
        context: 'intake',
      }).message,
    ).toBe(
      'Your account can’t see what has been handed over at a hub. Ask an administrator for access.',
    );
    expect(
      problemOf(refused('PERMISSION_DENIED', 403), {
        operation: 'createEvidenceRetrievalAuthorization',
      }).message,
    ).toMatch(/see pickup runs/);
  });
});

describe('the words of the photos', () => {
  it('tells a photo that has not been counted yet, and one that cannot be confirmed, in plain words', () => {
    expect(
      problemOf(conflict('intake_not_counted'), { operation: 'createEvidence' }).message,
    ).toMatch(/not been counted yet/);
    expect(
      problemOf(refused('EVIDENCE_UPLOAD_EXPIRED', 422), { operation: 'completeEvidenceUpload' })
        .message,
    ).toMatch(/time to send this photo ran out/);
  });

  // Break caught: wording that draws a figure of a count, names an officer, or shows a key or a role.
  it('names no officer, no key and no role, and says no figure of a count', () => {
    for (const rule of HUB_INTAKE_COPY) {
      expect(rule.text, rule.text).not.toMatch(
        /\b(?:hub\.[a-z_.]+|Ops Staff|Platform Admin|Senior Ops)\b/,
      );
      // The only number a sentence may carry is the 0 of a count's lower bound: no figure of a count is ever drawn by the words.
      expect(rule.text, rule.text).not.toMatch(/\b[1-9]\d*\b/);
    }
  });
});
