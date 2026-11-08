import { described } from '../platform/openapi/described-schema.js';

/**
 * The shapes of `listVendorPickupLocations` as the application describes them (S1.14): the contract's `VendorPickupLocation` with its
 * references followed, and the envelope the operation answers. The conformance check compares both with the contract.
 */
export const VENDOR_PICKUP_LOCATION_SCHEMA = described({
  type: 'object',
  required: ['id', 'vendor_organization_id', 'label', 'location', 'is_default', 'active'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    vendor_organization_id: { type: 'string', format: 'uuid' },
    label: { type: 'string' },
    location: {
      type: 'object',
      required: ['address'],
      properties: {
        address: { type: 'string' },
        landmark: { type: 'string' },
        map_link: { type: 'string', format: 'uri' },
        latitude: { type: 'number' },
        longitude: { type: 'number' },
      },
    },
    is_default: { type: 'boolean' },
    active: { type: 'boolean' },
    created_by: { type: 'string', format: 'uuid' },
    created_at: { type: 'string', format: 'date-time' },
    updated_by: { type: ['string', 'null'], format: 'uuid' },
    updated_at: { type: ['string', 'null'], format: 'date-time' },
  },
});

export const VENDOR_PICKUP_LOCATION_LIST = described({
  type: 'object',
  required: ['items'],
  properties: { items: { type: 'array', items: VENDOR_PICKUP_LOCATION_SCHEMA } },
});
