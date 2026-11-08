import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  BUNDLE_AUDIENCES,
  FIXED_POLICY_PRINCIPALS,
  GRANT_TIERS,
  HUB_SCOPES,
  IDENTITY_REASON_DOMAINS,
  OWNERSHIP_SCOPES,
  PERMISSION_DOMAINS,
  WORKFLOW_REASON_DOMAINS,
} from '../../platform/database/schema/reference-data.js';
import {
  parseCarryoverReasons,
  parseIdentityReasons,
  parsePermissionCatalogue,
  parsePickupCatalogueReasons,
  parseSettings,
  parseStopSkipReasons,
  statedGrantableKeys,
} from '../../test-support/seed-documents.js';
import { BUILD_FIXED_POLICY } from '../../platform/auth/sessions/build-fixed-policy.js';
import { BUNDLES, BUNDLE_IDS, FIXED_POLICIES, GRANTS } from './bundles.js';
import { HUBS } from './hubs.js';
import { PERMISSION_KEYS } from './permission-keys.js';
import { IDENTITY_REASONS } from './reasons.js';
import { SETTINGS } from './settings.js';
import { WORKFLOW_REASONS } from './workflow-reasons.js';

const ROOT = resolve(import.meta.dirname, '../../../../..');
const read = (path: string): string =>
  readFileSync(resolve(ROOT, path), 'utf8').replaceAll('\r', '');
const PERMISSIONS = read('contracts/permissions.md');
const SETTINGS_DOC = read('contracts/settings.md');
const DOMAIN_MODEL = read('contracts/domain-model.md');
const OPENAPI = read('contracts/openapi.yaml');

const CATALOGUE = parsePermissionCatalogue(PERMISSIONS);

/**
 * The reference seeds against the documents that own them (S0.9; Family Z: the authority is read, not copied). Nothing here
 * compares a count with a number typed into the test: what a document states is read from the document.
 */
describe('the permission catalogue (permissions.md section 7)', () => {
  // Break caught: a key added to the document and not to the seed (an unseeded key is unknown, so denied), or seeded and not in the
  // document (an authority nobody approved).
  it('is exactly the keys of the document', () => {
    expect([...PERMISSION_KEYS].toSorted()).toEqual(CATALOGUE.map((row) => row.key).toSorted());
  });

  it('is as many keys as the document says it grants, each once', () => {
    expect(PERMISSION_KEYS.length).toBe(statedGrantableKeys(PERMISSIONS));
    expect(new Set(PERMISSION_KEYS).size).toBe(PERMISSION_KEYS.length);
  });

  // Break caught: a key whose first part is not one of the seventeen domains (the table's own check would refuse the row at the seed).
  it('uses only the closed list of domains', () => {
    for (const key of PERMISSION_KEYS) {
      expect(PERMISSION_DOMAINS as readonly string[], key).toContain(key.split('.')[0]);
    }
  });
});

describe('the bundles', () => {
  const byId = new Map(BUNDLES.map((bundle) => [bundle.id, bundle]));
  const nameOf = (id: string) => byId.get(id)?.name ?? '?';
  /** The letter the catalogue's "Holders" column uses for each bundle. */
  const HOLDER_OF: Record<string, string> = {
    [BUNDLE_IDS.opsStaff]: 'A',
    [BUNDLE_IDS.seniorOps]: 'S',
    [BUNDLE_IDS.platformAdmin]: 'P',
    [BUNDLE_IDS.finance]: 'Finance',
    [BUNDLE_IDS.rider]: 'R',
    [BUNDLE_IDS.vendor]: 'V',
  };

  it('has the confirmed staff bundles and the two fixed ones, each once, with the privileged flag the contract states', () => {
    expect(BUNDLES.map((bundle) => bundle.name).toSorted()).toEqual([
      'Finance/Reconciliation',
      'Ops Staff',
      'Platform Admin',
      'Rider',
      'Senior Ops',
      'Vendor',
    ]);
    expect(new Set(BUNDLES.map((bundle) => bundle.id)).size).toBe(BUNDLES.length);
    expect(new Set(BUNDLES.map((bundle) => bundle.name)).size).toBe(BUNDLES.length);
    // domain-model.md section 6.9: privileged for Senior Ops and Platform Admin and for no other.
    expect(
      BUNDLES.filter((bundle) => bundle.privileged)
        .map((bundle) => bundle.name)
        .toSorted(),
    ).toEqual(['Platform Admin', 'Senior Ops']);
    for (const bundle of BUNDLES) {
      expect(BUNDLE_AUDIENCES as readonly string[], bundle.name).toContain(bundle.audience);
    }
  });

  // Break caught: a Rider or Vendor bundle assignable to a human staff identity, or a staff bundle that is not offered.
  it('gives Rider and Vendor their own fixed audiences, and the staff bundles STAFF', () => {
    expect(byId.get(BUNDLE_IDS.rider)?.audience).toBe('RIDER');
    expect(byId.get(BUNDLE_IDS.vendor)?.audience).toBe('VENDOR');
    for (const id of [
      BUNDLE_IDS.opsStaff,
      BUNDLE_IDS.seniorOps,
      BUNDLE_IDS.platformAdmin,
      BUNDLE_IDS.finance,
    ]) {
      expect(byId.get(id)?.audience, nameOf(id)).toBe('STAFF');
    }
  });

  // Break caught: a stable identifier that is not a UUID, which the table's primary key and a session's lineage would refuse.
  it('has stable UUID identifiers', () => {
    for (const bundle of BUNDLES)
      expect(bundle.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  describe('their grants', () => {
    // The keys SLICE-000's operations need (D-11: grant only the approved contents the slice needs). Derived from the contract:
    // every `x-permission` of an operation this slice builds that names a key of the catalogue.
    const SLICE_000_KEYS = [
      'dispatch.read',
      'permission.assignable_bundle.read',
      'settings.reason.read',
      'staff.credential.recover',
      'staff.device.register',
      'staff.device.reregister',
      'staff.device.revoke',
      'staff.identity.approve',
      'staff.identity.create',
      'staff.mfa.reset',
      'staff.read',
      'staff.session.revoke',
      'vendor.credential.recover',
      'vendor.organization.approve',
      'vendor.read',
    ];
    // The keys the operations of SLICE-001 need (S1.8; its plan names the operations): the same rule, applied to the pickup, hub intake,
    // price correction, custody handover and saved-location operations. Left out on purpose, each because its operation waits for
    // another slice or for a decision: `pickup.request.reassign_hub` (SLICE-014), `pickup.request.override_window` and
    // `hub.parcel.assess_handling` (their own slices, D-09), `hub.intake.reopen` (deferred, D-07), `hub.setting.*` and
    // `pricing.structure.*` (no hub administration, D-02), `pricing.reprice.*` (controlled repricing is not built, ruling R14) and the
    // `fleet.custody` keys of a delivery run's return (`return`, `receive`, `variance_resolve`).
    const SLICE_001_KEYS = [
      'fleet.custody.accept',
      'fleet.custody.initiate',
      'fleet.custody.read',
      'hub.handover.submit',
      'hub.intake.close',
      'hub.intake.close_exception',
      'hub.intake.count',
      'hub.intake.itemize',
      'hub.osd.adjudicate',
      'hub.read',
      'pickup.attempt.extend',
      'pickup.cancellation_charge.waive',
      'pickup.collection.confirm',
      'pickup.exception.approve',
      'pickup.exception.request',
      'pickup.failure.report',
      'pickup.failure.resolve',
      'pickup.handshake.override',
      'pickup.handshake.resolve',
      'pickup.manifest.assign',
      'pickup.manifest.create',
      'pickup.manifest.dispatch',
      'pickup.read',
      'pickup.request.cancel',
      'pickup.request.cancel_chargeable',
      'pickup.request.confirm',
      'pickup.request.create',
      'pickup.run.execute',
      'pickup.stop.skip',
      'pricing.correction.approve',
      'pricing.correction.create',
      'pricing.read',
      'vendor.pickup_location.manage',
    ];
    // S1.12e: the key of the Ops message log, granted by its own migration (0057) and its own list (NOTIFICATION_READ_GRANTS).
    const SLICE_001_NOTIFICATION_KEYS = ['notification.read'];
    const SLICE_KEYS = [...SLICE_000_KEYS, ...SLICE_001_KEYS, ...SLICE_001_NOTIFICATION_KEYS];

    it('name only keys of the catalogue, once per bundle', () => {
      const keys = new Set(PERMISSION_KEYS);
      const seen = new Set<string>();
      for (const grant of GRANTS) {
        expect(keys.has(grant.permissionKey), grant.permissionKey).toBe(true);
        expect(byId.has(grant.bundleId), grant.permissionKey).toBe(true);
        const id = `${grant.bundleId}:${grant.permissionKey}`;
        expect(seen.has(id), id).toBe(false);
        seen.add(id);
      }
    });

    it('use only the closed scopes and tiers, with the tier of a staff bundle as its holder letter', () => {
      for (const grant of GRANTS) {
        expect(HUB_SCOPES as readonly string[], grant.permissionKey).toContain(grant.hubScope);
        expect(OWNERSHIP_SCOPES as readonly string[], grant.permissionKey).toContain(
          grant.ownershipScope,
        );
        if (grant.tier !== null) expect(GRANT_TIERS as readonly string[]).toContain(grant.tier);
        const holder = HOLDER_OF[grant.bundleId];
        const expectedTier = holder === 'A' || holder === 'S' || holder === 'P' ? holder : null;
        expect(grant.tier, `${nameOf(grant.bundleId)} ${grant.permissionKey}`).toBe(expectedTier);
      }
    });

    // Break caught (the bundle is not inferred from its name): a grant to a bundle the catalogue does not name as a holder of the
    // key, or a holder of a slice key that is left without its grant.
    it('are the holders of the catalogue, for the keys this slice needs: no more, no fewer', () => {
      const catalogue = new Map(CATALOGUE.map((row) => [row.key, row]));
      for (const grant of GRANTS) {
        const holders = catalogue.get(grant.permissionKey)?.holders ?? [];
        expect(holders, `${nameOf(grant.bundleId)} ${grant.permissionKey}`).toContain(
          HOLDER_OF[grant.bundleId],
        );
        expect(SLICE_KEYS).toContain(grant.permissionKey);
      }
      for (const key of SLICE_KEYS) {
        for (const holder of catalogue.get(key)?.holders ?? []) {
          const bundle = Object.entries(HOLDER_OF).find(([, letter]) => letter === holder)?.[0];
          // Auditor, Executive and Fleet Manager are not seeded (proposed, or not yet specified); every other holder is.
          if (bundle === undefined) continue;
          expect(
            GRANTS.some((grant) => grant.bundleId === bundle && grant.permissionKey === key),
            `${holder} ${key}`,
          ).toBe(true);
        }
      }
    });

    // Break caught: a hub scope the document does not give the key (an `all` where it says own hub only, which widens authority).
    it('give a hub scope the catalogue row supports', () => {
      const catalogue = new Map(CATALOGUE.map((row) => [row.key, row]));
      for (const grant of GRANTS) {
        const text = `${catalogue.get(grant.permissionKey)?.scope ?? ''} ${catalogue.get(grant.permissionKey)?.notes ?? ''}`;
        const label = `${nameOf(grant.bundleId)} ${grant.permissionKey}`;
        if (grant.hubScope === 'all') expect(text, label).toMatch(/all hubs|all-Hub/i);
        else if (grant.hubScope === 'own') expect(text, label).toMatch(/own hub/i);
        else {
          // A Rider's boundary is its assignment and a Vendor's is its own records: neither has a hub reach to read off the row.
          const fixedAudience =
            grant.bundleId === BUNDLE_IDS.rider || grant.bundleId === BUNDLE_IDS.vendor;
          expect(fixedAudience || /none/i.test(text), label).toBe(true);
        }
        if (grant.ownershipScope === 'assigned')
          expect(grant.bundleId, label).toBe(BUNDLE_IDS.rider);
        if (grant.ownershipScope === 'own') expect(grant.bundleId, label).toBe(BUNDLE_IDS.vendor);
        if (grant.bundleId === BUNDLE_IDS.vendor || grant.bundleId === BUNDLE_IDS.rider) {
          expect(grant.hubScope, label).toBe('none');
        }
      }
    });

    // Break caught: the staff grants of the slice given the ownership scope of a Vendor or a Rider (or the reverse), which would
    // make a hub's officer see only what they own, or a Vendor see everything of a hub.
    it('give staff ownership "any", a Vendor "own" and a Rider "assigned", for every key of the slice', () => {
      for (const grant of GRANTS) {
        const label = `${nameOf(grant.bundleId)} ${grant.permissionKey}`;
        if (grant.bundleId === BUNDLE_IDS.vendor) expect(grant.ownershipScope, label).toBe('own');
        else if (grant.bundleId === BUNDLE_IDS.rider)
          expect(grant.ownershipScope, label).toBe('assigned');
        else expect(grant.ownershipScope, label).toBe('any');
      }
    });

    // Break caught: the test above accepting a scope for a row that states two (it only looks for "own hub" or "all hubs" somewhere
    // in the row), so that Senior Ops given the Platform Admin's reach, or the reverse, would pass. These are the rows that give
    // different holders different reach, typed from permissions.md section 7 and pinned one by one.
    it('give each holder the reach its own part of a row states, where a row states two', () => {
      const scopeOf = (bundle: keyof typeof BUNDLE_IDS, key: string) =>
        GRANTS.find((grant) => grant.bundleId === BUNDLE_IDS[bundle] && grant.permissionKey === key)
          ?.hubScope;
      // staff.session.revoke: "P: all hubs · S: own hub".
      expect(scopeOf('seniorOps', 'staff.session.revoke')).toBe('own');
      expect(scopeOf('platformAdmin', 'staff.session.revoke')).toBe('all');
      // staff.device.register: "S: own hub · P: all hubs, each by the scope of its own grant".
      expect(scopeOf('seniorOps', 'staff.device.register')).toBe('own');
      expect(scopeOf('platformAdmin', 'staff.device.register')).toBe('all');
      // staff.device.reregister: "own hub" for S and P alike.
      expect(scopeOf('seniorOps', 'staff.device.reregister')).toBe('own');
      expect(scopeOf('platformAdmin', 'staff.device.reregister')).toBe('own');
      // vendor.read: "own hub · all hubs": Platform Admin and Finance at all hubs, the other staff holders at their own.
      expect(scopeOf('opsStaff', 'vendor.read')).toBe('own');
      expect(scopeOf('seniorOps', 'vendor.read')).toBe('own');
      expect(scopeOf('platformAdmin', 'vendor.read')).toBe('all');
      expect(scopeOf('finance', 'vendor.read')).toBe('all');
      // pickup.exception.approve: "own hub · P: all hubs"; every Ops Staff member holds it (Product Owner, 29 October 2026).
      expect(scopeOf('opsStaff', 'pickup.exception.approve')).toBe('own');
      expect(scopeOf('seniorOps', 'pickup.exception.approve')).toBe('own');
      expect(scopeOf('platformAdmin', 'pickup.exception.approve')).toBe('all');
      // pricing.read: "own hub" for staff and Finance's reach is all hubs (section 8); a Vendor reads the fee on its own orders.
      expect(scopeOf('opsStaff', 'pricing.read')).toBe('own');
      expect(scopeOf('platformAdmin', 'pricing.read')).toBe('own');
      expect(scopeOf('finance', 'pricing.read')).toBe('all');
      expect(scopeOf('vendor', 'pricing.read')).toBe('none');
      // Every other key of the slice is the own-hub reach of the staff who hold it (a Platform Admin without a primary hub reaches
      // no hub by it: a finding for the Product Owner, not a widening made here).
      for (const bundle of ['opsStaff', 'seniorOps', 'platformAdmin'] as const) {
        for (const key of SLICE_001_KEYS) {
          const scope = scopeOf(bundle, key);
          if (scope === undefined) continue;
          const allHubs = bundle === 'platformAdmin' && key === 'pickup.exception.approve';
          expect(scope, `${bundle} ${key}`).toBe(allHubs ? 'all' : 'own');
        }
      }
    });

    // Break caught: the only tiers a staff bundle may carry (its holder's letter) and none on a fixed audience; and a slice key
    // granted to a holder the catalogue does not name (a Rider holding a hub key, a Vendor an Ops one).
    it('give the Vendor and the Rider only the keys the catalogue names them as holders of', () => {
      const catalogue = new Map(CATALOGUE.map((row) => [row.key, row]));
      const keysOf = (bundle: string) =>
        GRANTS.filter((grant) => grant.bundleId === bundle).map((grant) => grant.permissionKey);
      for (const key of keysOf(BUNDLE_IDS.vendor)) {
        expect(catalogue.get(key)?.holders, key).toContain('V');
      }
      for (const key of keysOf(BUNDLE_IDS.rider)) {
        expect(catalogue.get(key)?.holders, key).toContain('R');
      }
      expect(keysOf(BUNDLE_IDS.vendor).toSorted()).toEqual([
        'pickup.collection.confirm',
        'pickup.read',
        'pickup.request.cancel',
        'pickup.request.create',
        'pricing.read',
        'vendor.pickup_location.manage',
      ]);
      expect(keysOf(BUNDLE_IDS.rider).toSorted()).toEqual([
        'dispatch.read',
        'fleet.custody.accept',
        'fleet.custody.read',
        'hub.handover.submit',
        'pickup.collection.confirm',
        'pickup.failure.report',
        'pickup.read',
        'pickup.run.execute',
        'settings.reason.read',
      ]);
    });

    it('make all-hub scope explicit on the grants meant to have it: staff.mfa.reset and staff.credential.recover are Platform Admin’s at all hubs', () => {
      const admin = (key: string) =>
        GRANTS.find(
          (grant) => grant.bundleId === BUNDLE_IDS.platformAdmin && grant.permissionKey === key,
        );
      expect(admin('staff.mfa.reset')?.hubScope).toBe('all');
      expect(admin('staff.credential.recover')?.hubScope).toBe('all');
      expect(admin('vendor.credential.recover')?.hubScope).toBe('all');
      // Senior Ops never holds a key the catalogue gives to Platform Admin alone (AC-SLICE-000-114).
      expect(
        GRANTS.some(
          (grant) =>
            grant.bundleId === BUNDLE_IDS.seniorOps && grant.permissionKey === 'staff.mfa.reset',
        ),
      ).toBe(false);
      expect(
        GRANTS.some(
          (grant) =>
            grant.bundleId === BUNDLE_IDS.opsStaff &&
            grant.permissionKey === 'staff.device.reregister',
        ),
      ).toBe(false);
    });

    it('leave the proposed bundles and Fleet Manager unseeded', () => {
      expect(BUNDLES.map((bundle) => bundle.name.toLowerCase()).join(' ')).not.toMatch(
        /auditor|executive|fleet/,
      );
    });
  });
});

describe('the fixed policy (SECURITY_DESIGN.md section 13.10)', () => {
  // Break caught: a policy row left out, or a floor above 1 (a seed that starts reduced would end the first sessions it could issue).
  it('has one row for each of Vendor and Rider, at the revision of the build with floor 1', () => {
    expect(FIXED_POLICIES.map((row) => row.principalType).toSorted()).toEqual(
      [...FIXED_POLICY_PRINCIPALS].toSorted(),
    );
    for (const row of FIXED_POLICIES) {
      expect([row.revision, row.minimumRevision]).toEqual([
        BUILD_FIXED_POLICY[row.principalType],
        1,
      ]);
    }
  });
});

describe('the settings (settings.md section 7; Family Z)', () => {
  const doc = parseSettings(SETTINGS_DOC);
  const seeded = new Map(SETTINGS.map((setting) => [setting.key, setting]));
  const IN_SCOPE = new Set(['7.1', '7.5', '7.7', '7.8']);
  // The five handshake keys sit in the hub tables of the document and are platform settings (the Product Owner, 30 October 2026; seeded by S1.27).
  const HANDSHAKE_KEYS = new Set([
    'handshake_code_length',
    'handshake_code_ttl_minutes',
    'handshake_max_wrong_attempts',
    'sms_fallback_max_per_pickup',
    'sms_fallback_cooldown_seconds',
  ]);
  const inScope = (row: { readonly section: string; readonly key: string }): boolean =>
    IN_SCOPE.has(row.section) || HANDSHAKE_KEYS.has(row.key);

  // Break caught: a confirmed company-wide or platform value left out (the setting would be missing at run time), or a value that
  // is not confirmed (open, retired, or hub-scoped) seeded as if it were.
  it('seeds every confirmed company-wide and platform key, and nothing else', () => {
    const confirmed = doc
      .filter((row) => inScope(row) && row.status === 'CONFIRMED')
      .map((row) => row.key);
    expect([...seeded.keys()].toSorted()).toEqual(confirmed.toSorted());
    for (const row of doc.filter((each) => each.status !== 'CONFIRMED')) {
      expect(seeded.has(row.key), `${row.key} is ${row.status}`).toBe(false);
    }
  });

  it('seeds the document’s scope: section 7.1 is company-wide, 7.5, 7.7 and 7.8 platform', () => {
    for (const row of doc.filter((each) => inScope(each) && each.status === 'CONFIRMED')) {
      expect(seeded.get(row.key)?.scope, row.key).toBe(
        row.section === '7.1' ? 'COMPANY' : 'PLATFORM',
      );
    }
  });

  // Break caught: a number typed differently from the document. Every number the document's value cell names is in the seeded value
  // (a money amount in pesewas, a minute in minutes), and the seeded value has no number the cell does not.
  it('carries the numbers of the document’s value cell, and no other', () => {
    const MONEY = new Set([
      'liability_cap_amount',
      'value_declaration_threshold',
      'global_vendor_account_limit_amount',
    ]);
    const numbersIn = (text: string): number[] =>
      [...text.replaceAll(',', '').matchAll(/\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
    const flat = (value: unknown): number[] =>
      typeof value === 'number'
        ? [value]
        : Array.isArray(value)
          ? value.flatMap(flat)
          : value !== null && typeof value === 'object'
            ? Object.values(value).flatMap(flat)
            : [];
    for (const row of doc.filter((each) => inScope(each) && each.status === 'CONFIRMED')) {
      const setting = seeded.get(row.key);
      if (setting === undefined) continue;
      // Words in a value cell that name no number the setting carries: the zone of an hours window, the three categories.
      if (setting.valueType === 'string' || setting.valueType === 'list') continue;
      const expected = numbersIn(row.value).map((n) => (MONEY.has(row.key) ? n * 100 : n));
      expect(
        flat(setting.value).toSorted((a, b) => a - b),
        row.key,
      ).toEqual(expected.toSorted((a, b) => a - b));
    }
  });

  it('carries the text of the document’s value cell for the settings that are words', () => {
    const get = (key: string) => seeded.get(key)?.value;
    expect(get('transaction_currency')).toBe('GHS');
    expect(get('service_window_days')).toBe('Monday–Saturday');
    expect(get('service_window_hours')).toBe('07:00–18:00 Africa/Accra');
    expect(get('return_fee_waiver_reasons')).toEqual([
      'Melarc-caused operational error',
      'Unresolved documented dispute at return-start',
      'One-time goodwill or service-recovery exception',
    ]);
  });

  it('has the per-tier values as named objects, the rider’s idle rule being none by rule', () => {
    expect(seeded.get('session_lifetime_minutes')?.value).toEqual({
      rider: 1440,
      standard: 720,
      privileged: 480,
    });
    expect(seeded.get('session_idle_timeout_minutes')?.value).toEqual({
      rider: null,
      standard: 30,
      privileged: 15,
    });
  });

  it('gives every setting a unit, a description and a type its value has', () => {
    for (const setting of SETTINGS) {
      expect(setting.unit.trim().length, setting.key).toBeGreaterThan(0);
      expect(setting.description.trim().length, setting.key).toBeGreaterThan(0);
      const kind = typeof setting.value;
      const ok =
        (setting.valueType === 'integer' && Number.isInteger(setting.value)) ||
        (setting.valueType === 'string' && kind === 'string') ||
        (setting.valueType === 'list' && Array.isArray(setting.value)) ||
        (setting.valueType === 'object' &&
          kind === 'object' &&
          setting.value !== null &&
          !Array.isArray(setting.value)) ||
        (setting.valueType === 'boolean' && kind === 'boolean') ||
        (setting.valueType === 'decimal' && kind === 'number');
      expect(ok, `${setting.key} is ${setting.valueType}`).toBe(true);
    }
  });
});

describe('the identity reasons (domain-model.md section 3.9)', () => {
  const doc = parseIdentityReasons(DOMAIN_MODEL);

  // Break caught: a reason the document does not list, a label that drifted, or a permitted operation that is not the document's.
  it('are the twelve rows of the document: code, domain, label, permitted operations', () => {
    expect(doc).toHaveLength(12);
    expect(IDENTITY_REASONS.map((reason) => reason.code).toSorted()).toEqual(
      doc.map((row) => row.code).toSorted(),
    );
    for (const row of doc) {
      const reason = IDENTITY_REASONS.find((each) => each.code === row.code);
      expect([reason?.domain, reason?.label, reason?.permittedOperations]).toEqual([
        row.domain,
        row.label,
        row.permittedOperations,
      ]);
    }
  });

  it('cover the six identity domains, and no workflow domain', () => {
    expect(new Set(IDENTITY_REASONS.map((reason) => reason.domain))).toEqual(
      new Set(IDENTITY_REASON_DOMAINS),
    );
  });

  // Break caught: the flags "For all twelve" gives, written wrong (a note required where none is, an attribution other than MELARC).
  it('carry the flags the document gives all twelve', () => {
    for (const reason of IDENTITY_REASONS) {
      expect(reason, reason.code).toMatchObject({
        active: true,
        validCheckpoints: null,
        consumesDeliveryAttempt: false,
        attribution: 'MELARC',
        requiresPhoto: false,
        requiresContactAttempt: false,
        requiresApproval: false,
        requiresOpsReview: false,
        requiresEscalation: false,
        requiresNote: false,
      });
    }
  });

  // OB-74: the database checks the form of a permitted operation, not that the operation exists. The contract is the closed set.
  it('name only operations the contract has, and the branches the document names', () => {
    const operations = new Set(
      [...OPENAPI.matchAll(/^\s+operationId:\s*(\w+)\s*$/gm)].map((match) => match[1]),
    );
    const BRANCHES = new Set(['APPROVAL_REJECTED', 'FACTOR_ACTIVE', 'ENROLMENT_UNFINISHED']);
    for (const reason of IDENTITY_REASONS) {
      for (const entry of reason.permittedOperations) {
        const [operation = '', branch] = entry.split('#');
        expect(operations.has(operation), `${reason.code} names ${operation}`).toBe(true);
        if (branch !== undefined)
          expect(BRANCHES.has(branch), `${reason.code} ${entry}`).toBe(true);
      }
    }
  });
});

describe('the workflow reasons (domain-model.md section 3.9)', () => {
  const doc = parseStopSkipReasons(DOMAIN_MODEL);
  const catalogue = parsePickupCatalogueReasons(DOMAIN_MODEL);
  // The three domains the Product Owner admitted on 29 October 2026 (SLICE-001, D-05) and whose 25 codes he approved the same day.
  const CATALOGUE_DOMAINS = ['PICKUP_CANCELLATION', 'PICKUP_FAILURE', 'PICKUP_SHORT_COUNT'];
  const stopSkip = WORKFLOW_REASONS.filter((reason) => reason.domain === 'PICKUP_STOP_SKIP');
  const pickupCatalogue = WORKFLOW_REASONS.filter((reason) =>
    CATALOGUE_DOMAINS.includes(reason.domain),
  );
  const carryover = WORKFLOW_REASONS.filter((reason) => reason.domain === 'PICKUP_CARRYOVER');
  const carryoverDoc = parseCarryoverReasons(DOMAIN_MODEL);
  const sentenceCase = (code: string): string => {
    const words = code.toLowerCase().split('_').join(' ');
    return words.charAt(0).toUpperCase() + words.slice(1);
  };
  const codesOf = (
    domain: string,
    flag?: 'requiresNote' | 'requiresPhoto' | 'requiresContactAttempt',
  ) =>
    pickupCatalogue
      .filter((reason) => reason.domain === domain && (flag === undefined || reason[flag]))
      .map((reason) => reason.code)
      .toSorted();

  // Break caught: a code, an attribution or a note requirement that drifted from the table, which decides what Ops sees and what
  // the stop skip records.
  it('are the four PICKUP_STOP_SKIP rows of the document: code, attribution, note', () => {
    expect(doc).toHaveLength(4);
    expect(stopSkip.map((reason) => reason.code).toSorted()).toEqual(
      doc.map((row) => row.code).toSorted(),
    );
    for (const row of doc) {
      const reason = WORKFLOW_REASONS.find((each) => each.code === row.code);
      expect([reason?.domain, reason?.attribution, reason?.requiresNote], row.code).toEqual([
        'PICKUP_STOP_SKIP',
        row.attribution,
        row.requiresNote,
      ]);
    }
  });

  // Break caught: a flag the document does not give the domain ("valid_checkpoints is null for this domain", "consumes_delivery_attempt
  // is false and inert here", a skip is Melarc's operational decision), which a reason would then enforce on every skip.
  it('carry the flags the document gives the stop skip, and a label of the words of the code', () => {
    for (const reason of stopSkip) {
      expect(reason, reason.code).toMatchObject({
        active: true,
        validCheckpoints: null,
        permittedOperations: null,
        consumesDeliveryAttempt: false,
        requiresPhoto: false,
        requiresContactAttempt: false,
        requiresApproval: false,
        requiresOpsReview: false,
        requiresEscalation: false,
      });
      // The document gives no label; the label is the code's own words, in sentence case, and nothing added.
      expect(reason.label, reason.code).toBe(sentenceCase(reason.code));
    }
  });

  // Break caught: a code, an attribution (which decides the cancellation charge) or a requirement of the three pickup catalogues that
  // drifted from the table the Product Owner approved.
  it('are the 25 rows of the three pickup catalogues of the document: code, attribution and the requirements', () => {
    expect(catalogue).toHaveLength(25);
    expect(pickupCatalogue).toHaveLength(25);
    expect(pickupCatalogue.map((reason) => reason.code).toSorted()).toEqual(
      catalogue.map((row) => row.code).toSorted(),
    );
    expect(new Set(WORKFLOW_REASONS.map((reason) => reason.code)).size).toBe(
      WORKFLOW_REASONS.length,
    );
    for (const row of catalogue) {
      const reason = WORKFLOW_REASONS.find((each) => each.code === row.code);
      expect(
        [
          reason?.domain,
          reason?.attribution,
          reason?.requiresNote,
          reason?.requiresContactAttempt,
          reason?.requiresPhoto,
        ],
        row.code,
      ).toEqual([
        row.domain,
        row.attribution,
        row.requiresNote,
        row.requiresContactAttempt,
        row.requiresPhoto,
      ]);
    }
  });

  // Break caught: the document and the seed drifting together from what the Product Owner approved on 29 October 2026, which the
  // comparison above cannot see. These are his 25 codes, by domain, attribution and requirement.
  it('are the codes the Product Owner approved on 29 October 2026', () => {
    expect(codesOf('PICKUP_CANCELLATION')).toEqual(
      [
        'VENDOR_NO_LONGER_NEEDS_PICKUP',
        'VENDOR_PARCELS_NOT_READY',
        'VENDOR_WRONG_DETAILS',
        'DUPLICATE_REQUEST',
        'OTHER_CUSTOMER_REASON',
        'NO_RIDER_AVAILABLE',
        'HUB_SYSTEM_FAULT',
        'INTERNAL_ROUTING_ERROR',
        'OTHER_MELARC_REASON',
        'ROAD_OR_WEATHER_DISRUPTION',
        'GENUINE_EMERGENCY',
        'OTHER_EXTERNAL_REASON',
      ].toSorted(),
    );
    expect(codesOf('PICKUP_FAILURE')).toEqual(
      [
        'VENDOR_NOT_AT_LOCATION',
        'VENDOR_UNREACHABLE_BY_PHONE',
        'ENTRY_REFUSED_BY_SECURITY',
        'LOCATION_CLOSED',
        'PARCELS_NOT_PACKED',
        'VENDOR_ASKED_TO_COME_BACK_LATER',
        'VENDOR_REFUSED_HANDOVER',
        'PARCEL_NOT_ACCEPTABLE',
      ].toSorted(),
    );
    expect(codesOf('PICKUP_SHORT_COUNT')).toEqual(
      [
        'SOME_PARCELS_NOT_READY',
        'VENDOR_HELD_BACK_PARCELS',
        'PARCEL_DAMAGED_OR_UNSAFE',
        'BOOKED_COUNT_WRONG',
        'VENDOR_DISPUTES_COUNT',
      ].toSorted(),
    );
    const attributed = (attribution: string) =>
      pickupCatalogue
        .filter(
          (reason) => reason.domain === 'PICKUP_CANCELLATION' && reason.attribution === attribution,
        )
        .map((reason) => reason.code)
        .toSorted();
    expect(attributed('MELARC')).toEqual(
      [
        'HUB_SYSTEM_FAULT',
        'INTERNAL_ROUTING_ERROR',
        'NO_RIDER_AVAILABLE',
        'OTHER_MELARC_REASON',
      ].toSorted(),
    );
    expect(attributed('EXTERNAL')).toEqual(
      ['GENUINE_EMERGENCY', 'OTHER_EXTERNAL_REASON', 'ROAD_OR_WEATHER_DISRUPTION'].toSorted(),
    );
    expect(attributed('CUSTOMER')).toHaveLength(5);
    // The failure reasons: customer-caused except the two access refusals, which are external.
    expect(
      pickupCatalogue
        .filter((reason) => reason.domain === 'PICKUP_FAILURE' && reason.attribution === 'EXTERNAL')
        .map((reason) => reason.code)
        .toSorted(),
    ).toEqual(['ENTRY_REFUSED_BY_SECURITY', 'LOCATION_CLOSED']);
    expect(
      pickupCatalogue
        .filter((reason) => reason.domain === 'PICKUP_SHORT_COUNT')
        .every((reason) => reason.attribution === 'CUSTOMER'),
    ).toBe(true);
    // The requirements: a note for the catch-alls and the emergency, for every failure and for two short-count reasons; a contact attempt
    // where the vendor was not found; a photo where access was refused or a parcel was damaged.
    expect(codesOf('PICKUP_CANCELLATION', 'requiresNote')).toEqual(
      [
        'GENUINE_EMERGENCY',
        'OTHER_CUSTOMER_REASON',
        'OTHER_EXTERNAL_REASON',
        'OTHER_MELARC_REASON',
      ].toSorted(),
    );
    expect(codesOf('PICKUP_FAILURE', 'requiresNote')).toEqual(codesOf('PICKUP_FAILURE'));
    expect(codesOf('PICKUP_FAILURE', 'requiresContactAttempt')).toEqual(
      ['VENDOR_NOT_AT_LOCATION', 'VENDOR_UNREACHABLE_BY_PHONE'].toSorted(),
    );
    expect(codesOf('PICKUP_FAILURE', 'requiresPhoto')).toEqual([
      'ENTRY_REFUSED_BY_SECURITY',
      'LOCATION_CLOSED',
    ]);
    expect(codesOf('PICKUP_SHORT_COUNT', 'requiresNote')).toEqual(
      ['VENDOR_DISPUTES_COUNT', 'VENDOR_HELD_BACK_PARCELS'].toSorted(),
    );
    expect(codesOf('PICKUP_SHORT_COUNT', 'requiresPhoto')).toEqual(['PARCEL_DAMAGED_OR_UNSAFE']);
    expect(codesOf('PICKUP_CANCELLATION', 'requiresPhoto')).toEqual([]);
    expect(codesOf('PICKUP_CANCELLATION', 'requiresContactAttempt')).toEqual([]);
    expect(codesOf('PICKUP_SHORT_COUNT', 'requiresContactAttempt')).toEqual([]);
  });

  // Break caught: a flag the document does not give the three domains (no checkpoints, no permitted operations, no approval, no Ops
  // review, no escalation, no delivery attempt), which a reason would then enforce on every cancellation, failure and short count.
  it('carry the flags the document gives the pickup catalogues, and a label of the words of the code', () => {
    for (const reason of pickupCatalogue) {
      expect(reason, reason.code).toMatchObject({
        active: true,
        validCheckpoints: null,
        permittedOperations: null,
        consumesDeliveryAttempt: false,
        requiresApproval: false,
        requiresOpsReview: false,
        requiresEscalation: false,
      });
      expect(reason.label, reason.code).toBe(sentenceCase(reason.code));
    }
  });

  // Break caught: a carry-over code, attribution, note requirement or label that drifted from the table, which decides what Ops is offered
  // when it carries an overdue request over and what the report counts.
  it('are the eight PICKUP_CARRYOVER rows of the document: code, attribution, note and label', () => {
    expect(carryoverDoc).toHaveLength(8);
    expect(carryover.map((reason) => reason.code).toSorted()).toEqual(
      carryoverDoc.map((row) => row.code).toSorted(),
    );
    for (const row of carryoverDoc) {
      const reason = WORKFLOW_REASONS.find((each) => each.code === row.code);
      expect(
        [reason?.domain, reason?.attribution, reason?.requiresNote, reason?.label],
        row.code,
      ).toEqual(['PICKUP_CARRYOVER', row.attribution, row.requiresNote, row.label]);
    }
  });

  // Break caught: the document and the seed drifting together from what was decided on 2 November 2026, which the comparison above cannot
  // see; a carry-over reason that asks for no note where the reason is a judgement; and a name that collides with another domain's code (a
  // code is the table's primary key, so five of the eight names approved are held under a prefix).
  it('are the eight carry-over reasons decided on 2 November 2026, five of them under the prefix their names need', () => {
    expect(
      carryover.map((reason) => [reason.code, reason.attribution, reason.requiresNote]).toSorted(),
    ).toEqual(
      [
        ['CARRYOVER_NO_RIDER_AVAILABLE', 'MELARC', false],
        ['CARRYOVER_OTHER_CUSTOMER_REASON', 'CUSTOMER', true],
        ['CARRYOVER_OTHER_EXTERNAL_REASON', 'EXTERNAL', true],
        ['CARRYOVER_OTHER_MELARC_REASON', 'MELARC', true],
        ['CARRYOVER_ROAD_OR_WEATHER_DISRUPTION', 'EXTERNAL', true],
        ['HUB_OR_SYSTEM_FAULT', 'MELARC', true],
        ['RUN_FULL_OR_OUT_OF_TIME', 'MELARC', true],
        ['VENDOR_ASKED_FOR_LATER_PICKUP', 'CUSTOMER', true],
      ].toSorted(),
    );
    // A prefixed code is the approved name of a code the cancellation catalogue already holds, and an unprefixed one is free everywhere.
    const held = new Set(pickupCatalogue.map((reason) => reason.code));
    for (const reason of carryover) {
      const prefixed = reason.code.startsWith('CARRYOVER_');
      expect(held.has(reason.code), reason.code).toBe(false);
      expect(held.has(reason.code.replace(/^CARRYOVER_/, '')), reason.code).toBe(prefixed);
    }
  });

  // Break caught: a flag that would make a carry-over reason do more than explain (an approval, a review, an escalation, a consumed attempt),
  // or one that would hide a reason from the list.
  it('carry the flags that make a carry-over reason explain a carry-over and nothing else', () => {
    for (const reason of carryover) {
      expect(reason, reason.code).toMatchObject({
        active: true,
        validCheckpoints: null,
        permittedOperations: null,
        consumesDeliveryAttempt: false,
        requiresPhoto: false,
        requiresContactAttempt: false,
        requiresApproval: false,
        requiresOpsReview: false,
        requiresEscalation: false,
      });
    }
  });

  // Break caught: the closed set of domains and the document's list drifting apart, which the table's check would then refuse or admit.
  it('make the closed set of workflow domains the document’s list, the three pickup catalogues included', () => {
    const row = DOMAIN_MODEL.split('\n').find((line) =>
      line.startsWith('| `domain`| enum| no| Which workflow offers it.'),
    );
    const named = [...(row ?? '').matchAll(/`([A-Z_]{4,})`/g)].map((match) => match[1] ?? '');
    expect(named.toSorted()).toEqual([...WORKFLOW_REASON_DOMAINS].toSorted());
    for (const domain of CATALOGUE_DOMAINS)
      expect(WORKFLOW_REASON_DOMAINS as readonly string[]).toContain(domain);
  });
});

describe('the hub', () => {
  it('seeds one hub, with a name', () => {
    expect(HUBS).toHaveLength(1);
    expect(HUBS[0]?.name.trim().length).toBeGreaterThan(0);
    expect(HUBS[0]?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
