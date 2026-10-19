/**
 * mysql2 is configured with timezone "Z", so a DATETIME column is placed on the
 * Date's UTC fields. Java Jackson prints those same digits as
 * "yyyy-MM-dd HH:mm:ss" in GMT+8. Keep the wire format identical.
 */
export function formatJavaDate(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * Membership expiry is stored as Shanghai wall-clock digits. With timezone "Z"
 * those digits sit on the UTC clock, eight hours later than the real instant.
 */
export function isActiveShanghaiWallClock(
  value: Date | string | null | undefined,
  now = Date.now(),
): boolean {
  if (value == null || value === '') return false;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  return date.getTime() - SHANGHAI_OFFSET_MS > now;
}

function isBinary(value: object): boolean {
  return Buffer.isBuffer(value) || value instanceof Uint8Array;
}

export function formatPayloadDates<T>(value: T): T {
  if (value instanceof Date) return formatJavaDate(value) as T;
  if (value == null || typeof value !== 'object') return value;
  if (isBinary(value) || typeof (value as { pipe?: unknown }).pipe === 'function') return value;
  if (Array.isArray(value)) return value.map((item) => formatPayloadDates(item)) as T;
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    copy[key] = formatPayloadDates(item);
  }
  return copy as T;
}
