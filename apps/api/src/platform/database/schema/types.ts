import { customType } from 'drizzle-orm/pg-core';

/**
 * `bytea` as a Node `Buffer`: a response body kept byte for byte, a sealed envelope, a keyed digest. Drizzle has no native builder
 * for it, so the tables that hold binary values share this one.
 */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});
