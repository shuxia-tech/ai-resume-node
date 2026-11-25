import { randomInt } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sql, type Kysely } from 'kysely';
import type { Database } from '@/infrastructure/database.js';
import { GA_TRACKER_SOURCE } from '@/modules/admin/ga-tracker.js';

export const XINGCE_MEASUREMENT_ID = 'G-XINGCE0001';

const STREAM_ID = /^[A-Za-z0-9._-]{2,64}$/;
const MAX_EVENTS = 20;

type JsonRecord = Record<string, unknown>;

let streamReady: Promise<void> | null = null;

function ensureXingceStream(db: Kysely<Database>) {
  streamReady ??= sql`
    INSERT INTO t_ga_stream (measurement_id, site_name, domain, property_id, enabled, create_time, update_time)
    SELECT ${XINGCE_MEASUREMENT_ID}, '行测超人', 'xingce.gfjianli.com', NULL, 1, NOW(), NOW()
    WHERE NOT EXISTS (
      SELECT 1 FROM t_ga_stream WHERE measurement_id = ${XINGCE_MEASUREMENT_ID}
    )
  `
    .execute(db)
    .then(() => undefined)
    .catch((error: unknown) => {
      streamReady = null;
      throw error;
    });
  return streamReady;
}

function text(value: unknown, max = 512) {
  const raw = value == null ? '' : String(value).trim();
  if (!raw) return null;
  return raw.length <= max ? raw : raw.slice(0, max);
}

function numberOf(source: JsonRecord | undefined, ...keys: string[]) {
  if (!source) return null;
  for (const key of keys) {
    const value = source[key];
    if (value == null || value === '') continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function field(source: JsonRecord | undefined, ...keys: string[]) {
  if (!source) return '';
  for (const key of keys) {
    const value = source[key];
    if (value != null && String(value).trim()) return String(value).trim();
  }
  return '';
}

function clientIp(request: FastifyRequest) {
  const real = request.headers['x-real-ip'];
  if (typeof real === 'string' && real.trim()) return real.trim();
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) return forwarded.split(',')[0]?.trim() ?? '';
  return request.ip;
}

function deviceCategory(userAgent: string) {
  if (/iPad|Tablet/i.test(userAgent)) return 'tablet';
  if (/Mobile|Android|iPhone/i.test(userAgent)) return 'mobile';
  return 'desktop';
}

function channelGroup(source: string, referrer: string, host: string) {
  const medium = source.toLowerCase();
  if (medium.includes('cpc') || medium.includes('paid')) return 'Paid Search';
  if (source) return 'Referral';
  if (!referrer) return 'Direct';
  try {
    const referrerHost = new URL(referrer).hostname;
    if (!referrerHost || referrerHost === host) return 'Direct';
    if (/google|baidu|bing|sogou|so\.com|sm\.cn/i.test(referrerHost)) return 'Organic Search';
    return 'Referral';
  } catch {
    return 'Direct';
  }
}

function pageOf(params: JsonRecord) {
  const location = field(params, 'page_location', 'pageLocation');
  let path = field(params, 'page_path', 'pagePath');
  let host = field(params, 'hostname', 'host');
  if (location && (!path || !host)) {
    try {
      const uri = new URL(location);
      host = host || uri.hostname;
      path = path || `${uri.pathname}${uri.search}`;
    } catch {
      path = path || '/';
    }
  }
  return { location, path: path || '/', host };
}

function payloadOf(body: unknown) {
  if (body && typeof body === 'object') return body as JsonRecord;
  if (typeof body !== 'string' || !body.trim()) return null;
  try {
    const parsed = JSON.parse(body) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as JsonRecord) : null;
  } catch {
    return null;
  }
}

async function ingest(
  db: Kysely<Database>,
  measurementId: string | undefined,
  body: unknown,
  request: FastifyRequest,
) {
  const payload = payloadOf(body);
  if (!payload) return;
  const streamId = field({ measurementId }, 'measurementId') || field(payload, 'measurement_id', 'measurementId');
  if (!STREAM_ID.test(streamId)) return;
  await ensureXingceStream(db);
  const enabled = await sql<{ measurement_id: string }>`
    SELECT measurement_id FROM t_ga_stream
    WHERE measurement_id = ${streamId} AND enabled = 1 LIMIT 1
  `.execute(db);
  if (!enabled.rows[0]) return;
  const clientId = field(payload, 'client_id', 'clientId');
  if (!clientId) return;
  const events = Array.isArray(payload.events) ? payload.events.slice(0, MAX_EVENTS) : [];
  const userAgent = text(request.headers['user-agent'], 512) ?? '';
  const ip = text(clientIp(request), 64);
  const nowMicros = Date.now() * 1000;
  for (const item of events) {
    if (!item || typeof item !== 'object') continue;
    const event = item as JsonRecord;
    const name = field(event, 'name', 'event_name');
    if (!name) continue;
    const params = event.params && typeof event.params === 'object' ? (event.params as JsonRecord) : {};
    const timestamp = numberOf(event, 'timestamp_micros', 'timestampMicros') ?? numberOf(payload, 'timestamp_micros', 'timestampMicros') ?? nowMicros;
    const when = new Date(timestamp / 1000);
    const shanghai = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(when);
    const part = (type: string) => shanghai.find((item) => item.type === type)?.value ?? '';
    const page = pageOf(params);
    const source = field(params, 'source', 'traffic_source');
    const referrer = field(params, 'page_referrer', 'pageReferrer');
    await sql`
      INSERT INTO t_ga_event (
        id, event_date, event_hour, event_timestamp, event_name, user_pseudo_id, user_id,
        stream_id, platform, hostname, page_location, page_referrer, page_title, page_path,
        ga_session_id, ga_session_number, engagement_time_msec, device_category,
        session_default_channel_group, client_ip, user_agent, create_time
      ) VALUES (
        ${`${Date.now()}${randomInt(0, 1000).toString().padStart(3, '0')}`},
        ${`${part('year')}${part('month')}${part('day')}`},
        ${Number(part('hour')) || 0},
        ${timestamp},
        ${text(name, 64)},
        ${text(clientId, 64)},
        ${text(field(payload, 'user_id', 'userId'), 64)},
        ${text(streamId, 64)},
        'WEB',
        ${text(page.host, 255)},
        ${text(page.location, 2048)},
        ${text(referrer, 2048)},
        ${text(field(params, 'page_title', 'pageTitle'), 512)},
        ${text(page.path, 512)},
        ${text(field(params, 'ga_session_id', 'session_id'), 64)},
        ${numberOf(params, 'ga_session_number', 'session_number')},
        ${numberOf(params, 'engagement_time_msec', 'engagementTimeMsec')},
        ${deviceCategory(userAgent)},
        ${channelGroup(source, referrer, page.host)},
        ${ip},
        ${text(userAgent, 512)},
        NOW()
      )
    `.execute(db);
  }
}

export function registerGaCollectRoutes(app: FastifyInstance, db: Kysely<Database>) {
  void ensureXingceStream(db).catch((error: unknown) => {
    app.log.warn({ error }, '行测流量站点初始化失败');
  });
  try {
    app.addContentTypeParser('text/plain', { parseAs: 'string' }, (_request, payload, done) => {
      done(null, payload);
    });
  } catch {
    // Another route already accepts the beacon content type.
  }

  app.get('/ga/t.js', async (_request, reply) => {
    return reply.type('application/javascript; charset=utf-8').send(GA_TRACKER_SOURCE);
  });

  app.post<{ Querystring: { measurement_id?: string } }>('/c/ga/collect', async (request, reply) => {
    try {
      await ingest(db, request.query.measurement_id, request.body, request);
    } catch (error) {
      request.log.warn({ error }, '流量采集入库失败');
    }
    return reply.code(204).send();
  });

  app.get<{
    Querystring: {
      measurement_id?: string;
      client_id?: string;
      en?: string;
      dl?: string;
      dt?: string;
      dr?: string;
      dp?: string;
      sid?: string;
      snum?: string;
    };
  }>('/c/ga/collect', async (request, reply) => {
    const query = request.query;
    if (query.client_id && query.en) {
      const body = {
        client_id: query.client_id,
        events: [
          {
            name: query.en,
            params: {
              page_location: query.dl ?? '',
              page_title: query.dt ?? '',
              page_referrer: query.dr ?? '',
              page_path: query.dp ?? '',
              ga_session_id: query.sid ?? '',
              ga_session_number: query.snum ?? '',
            },
          },
        ],
      };
      try {
        await ingest(db, query.measurement_id, body, request);
      } catch (error) {
        request.log.warn({ error }, '流量采集入库失败');
      }
    }
    return reply.code(204).send();
  });
}
