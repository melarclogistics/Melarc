import type { components } from '@melarc/api-client';

import { instantOf, isOneOf, isRecord, lineOf, optional, uuidOf } from '../staff/staff-shape';

/**
 * What the vendor screens (S0.52b) believe of an answer, judged field by field before anything is drawn, as the identity screens' are
 * (`staff-shape.ts`). The contract gives a vendor account's **authentication status only** (identifier, organisation, status, whether a
 * secret and a recovery channel exist, how many browsers are active), never a credential or a recovery address; the shapes here read those
 * fields and no other, so a field a server should never send has nowhere to go.
 */
export type VendorAccountView = components['schemas']['VendorAccountSummary'];
export type VendorAccountStatus = VendorAccountView['status'];
export type RegisteredDeviceView = components['schemas']['RegisteredDevice'];

export interface VendorAccountPageView {
  readonly items: readonly VendorAccountView[];
  readonly nextPageToken: string | null;
}

export interface VendorAccountDetailView {
  readonly account: VendorAccountView;
  readonly devices: readonly RegisteredDeviceView[];
}

/** What a vendor re-issue came to: a setup grant is pending, until when. The grant is never in the answer. */
export interface VendorSetupGrantOutcome {
  readonly expiresAt: string;
}

const MAX_PAGE_ITEMS = 100;
/** Every browser an account has held is listed; a list far beyond what a business keeps is not the API's. */
const MAX_DEVICES = 500;
const MAX_TOKEN = 2048;

const countOf = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** One account of the list or the record, or nothing when it is not one the screens may show. */
export function parseVendorAccount(body: unknown): VendorAccountView | undefined {
  if (!isRecord(body)) return undefined;
  const id = uuidOf(body.id);
  const accountIdentifier = lineOf(body.account_identifier);
  const organizationId = uuidOf(body.vendor_organization_id);
  const legalName = lineOf(body.legal_name);
  const hubId = uuidOf(body.responsible_hub_id);
  const activeDevices = countOf(body.active_device_count);
  const channel = body.delivery_channel ?? null;
  if (
    id === undefined ||
    accountIdentifier === undefined ||
    organizationId === undefined ||
    legalName === undefined ||
    hubId === undefined ||
    !isOneOf(['ACTIVE', 'SUSPENDED'] as const, body.status) ||
    typeof body.credential_established !== 'boolean' ||
    activeDevices === undefined ||
    typeof body.has_recovery_email !== 'boolean' ||
    typeof body.has_recovery_phone !== 'boolean' ||
    (channel !== null && !isOneOf(['PHONE', 'EMAIL'] as const, channel))
  ) {
    return undefined;
  }
  return {
    id,
    account_identifier: accountIdentifier,
    vendor_organization_id: organizationId,
    legal_name: legalName,
    responsible_hub_id: hubId,
    status: body.status,
    credential_established: body.credential_established,
    active_device_count: activeDevices,
    has_recovery_email: body.has_recovery_email,
    has_recovery_phone: body.has_recovery_phone,
    delivery_channel: channel as VendorAccountView['delivery_channel'],
  };
}

/** A page of `listVendorAccounts`. */
export function parseVendorAccountPage(body: unknown): VendorAccountPageView | undefined {
  if (!isRecord(body) || !Array.isArray(body.items) || body.items.length > MAX_PAGE_ITEMS)
    return undefined;
  const items = body.items.map(parseVendorAccount);
  const token = body.next_page_token;
  if (items.some((item) => item === undefined)) return undefined;
  if (
    token !== null &&
    (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN)
  )
    return undefined;
  return { items: items as VendorAccountView[], nextPageToken: token };
}

/** One browser of an account: its id, its status and when it was registered, and whether by the vendor or by Melarc. Never a credential. */
export function parseRegisteredDevice(
  body: unknown,
  accountId: string,
): RegisteredDeviceView | undefined {
  if (!isRecord(body)) return undefined;
  const id = uuidOf(body.id);
  const registeredAt = optional(body.registered_at, instantOf);
  const registeredBy = optional(body.registered_by, uuidOf);
  if (
    id === undefined ||
    body.principal_type !== 'VENDOR' ||
    typeof body.principal_id !== 'string' ||
    body.principal_id.toLowerCase() !== accountId.toLowerCase() ||
    body.device_kind !== 'VENDOR_BROWSER_CREDENTIAL' ||
    !isOneOf(['ACTIVE', 'REPLACED', 'REVOKED'] as const, body.status) ||
    registeredAt === undefined ||
    registeredBy === undefined
  ) {
    return undefined;
  }
  return {
    id,
    principal_type: 'VENDOR',
    principal_id: body.principal_id,
    device_kind: 'VENDOR_BROWSER_CREDENTIAL',
    status: body.status,
    ...(registeredAt === null ? {} : { registered_at: registeredAt }),
    registered_by: registeredBy,
  };
}

/** `getVendorAccount`: the account and every browser it has held. */
export function parseVendorAccountDetail(body: unknown): VendorAccountDetailView | undefined {
  if (!isRecord(body) || !Array.isArray(body.devices) || body.devices.length > MAX_DEVICES)
    return undefined;
  const account = parseVendorAccount(body.account);
  if (account === undefined) return undefined;
  const devices = body.devices.map((device) => parseRegisteredDevice(device, account.id));
  if (devices.some((device) => device === undefined)) return undefined;
  return { account, devices: devices as RegisteredDeviceView[] };
}

/** The answer of `reissueVendorCredentialSetup` for the account asked for, or nothing when it is not one. */
export function parseVendorSetupGrant(
  body: unknown,
  accountId: string,
): VendorSetupGrantOutcome | undefined {
  if (!isRecord(body)) return undefined;
  const expiresAt = instantOf(body.expires_at);
  if (
    uuidOf(body.id) === undefined ||
    body.principal_type !== 'VENDOR' ||
    typeof body.principal_id !== 'string' ||
    body.principal_id.toLowerCase() !== accountId.toLowerCase() ||
    body.purpose !== 'VENDOR_CREDENTIAL_SETUP' ||
    body.state !== 'PENDING' ||
    expiresAt === undefined
  ) {
    return undefined;
  }
  return { expiresAt };
}
