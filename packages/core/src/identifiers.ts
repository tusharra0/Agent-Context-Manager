import { randomUUID } from 'node:crypto';

import { z } from 'zod';

const UUID_HEX_PATTERN = '[0-9a-f]{32}';

export const SessionIdSchema = z
  .string()
  .regex(new RegExp(`^ses_${UUID_HEX_PATTERN}$`));
export const EventIdSchema = z
  .string()
  .regex(new RegExp(`^evt_${UUID_HEX_PATTERN}$`));
export const StateItemIdSchema = z
  .string()
  .regex(new RegExp(`^sti_${UUID_HEX_PATTERN}$`));

export type SessionId = z.infer<typeof SessionIdSchema>;
export type EventId = z.infer<typeof EventIdSchema>;
export type StateItemId = z.infer<typeof StateItemIdSchema>;
export type UuidGenerator = () => string;

function opaqueId(
  prefix: 'ses' | 'evt' | 'sti',
  generateUuid: UuidGenerator,
): string {
  const uuid = generateUuid().toLowerCase();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuid)
  ) {
    throw new TypeError('The UUID generator returned an invalid UUID.');
  }
  return `${prefix}_${uuid.replaceAll('-', '')}`;
}

export function createSessionId(
  generateUuid: UuidGenerator = randomUUID,
): SessionId {
  return SessionIdSchema.parse(opaqueId('ses', generateUuid));
}

export function createEventId(
  generateUuid: UuidGenerator = randomUUID,
): EventId {
  return EventIdSchema.parse(opaqueId('evt', generateUuid));
}

export function createStateItemId(
  generateUuid: UuidGenerator = randomUUID,
): StateItemId {
  return StateItemIdSchema.parse(opaqueId('sti', generateUuid));
}
