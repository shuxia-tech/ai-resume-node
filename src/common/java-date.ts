/**
 * mysql2 is configured with timezone "Z", so a DATETIME column is placed on the
 * Date's UTC fields. Java Jackson prints those same digits as
 * "yyyy-MM-dd HH:mm:ss" in GMT+8. Keep the wire format identical.
 */
export function formatJavaDate(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * User-entered application time. mysql2 stores DATETIME digits on the UTC
 * clock, so a valid Shanghai calendar value is kept as those same digits.
 * Overflow dates such as February 31 fail the round trip, matching Java's
 * non-lenient GMT+8 parser.
 */
export function parseApplicationDate(recordTime: string): Date | null {
  let text = recordTime.trim();
  if (text.length === 10) text = `${text} 00:00:00`;
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)) return null;
  const [year, month, day, hour, minute, second] = text.split(/[- :]/).map(Number);
  if ([year, month, day, hour, minute, second].some((part) => part == null)) return null;
  const date = new Date(Date.UTC(year!, month! - 1, day, hour, minute, second));
  return formatJavaDate(date) === text ? date : null;
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
