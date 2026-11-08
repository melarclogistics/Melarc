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
} from '../../platform/database/schema/reference-data.js';
import {
  parseIdentityReasons,
  parsePermissionCatalogue,
  parseSettings,
  statedGrantableKeys,
} from '../../test-support/seed-documents.js';
import { BUNDLES, BUNDLE_IDS, FIXED_POLICIES, GRANTS } from './bundles.js';
import { HUBS } from './hubs.js';
import { PERMISSION_KEYS } from './permission-keys.js';
import { IDENTITY_REASONS } from './reasons.js';
import { SETTINGS } from './settings.js';

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
    const SLICE_KEYS = [
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
        else expect(grant.bundleId === BUNDLE_IDS.rider || /none/i.test(text), label).toBe(true);
        if (grant.ownershipScope === 'assigned')
          expect(grant.bundleId, label).toBe(BUNDLE_IDS.rider);
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
  it('has one row for each of Vendor and Rider, at revision 1 with floor 1', () => {
    expect(FIXED_POLICIES.map((row) => row.principalType).toSorted()).toEqual(
      [...FIXED_POLICY_PRINCIPALS].toSorted(),
    );
    for (const row of FIXED_POLICIES) expect([row.revision, row.minimumRevision]).toEqual([1, 1]);
  });
});

describe('the settings (settings.md section 7; Family Z)', () => {
  const doc = parseSettings(SETTINGS_DOC);
  const seeded = new Map(SETTINGS.map((setting) => [setting.key, setting]));
  const IN_SCOPE = new Set(['7.1', '7.5', '7.7']);

  // Break caught: a confirmed company-wide or platform value left out (the setting would be missing at run time), or a value that
  // is not confirmed (open, retired, or hub-scoped) seeded as if it were.
  it('seeds every confirmed company-wide and platform key, and nothing else', () => {
    const confirmed = doc
      .filter((row) => IN_SCOPE.has(row.section) && row.status === 'CONFIRMED')
      .map((row) => row.key);
    expect([...seeded.keys()].toSorted()).toEqual(confirmed.toSorted());
    for (const row of doc.filter((each) => each.status !== 'CONFIRMED')) {
      expect(seeded.has(row.key), `${row.key} is ${row.status}`).toBe(false);
    }
  });

  it('seeds the document’s scope: section 7.1 is company-wide, 7.5 and 7.7 platform', () => {
    for (const row of doc.filter(
      (each) => IN_SCOPE.has(each.section) && each.status === 'CONFIRMED',
    )) {
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
    for (const row of doc.filter(
      (each) => IN_SCOPE.has(each.section) && each.status === 'CONFIRMED',
    )) {
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

describe('the hub', () => {
  it('seeds one hub, with a name', () => {
    expect(HUBS).toHaveLength(1);
    expect(HUBS[0]?.name.trim().length).toBeGreaterThan(0);
    expect(HUBS[0]?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
