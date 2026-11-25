import { randomInt } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { requireAdmin } from '@/modules/admin/admin-auth-routes.js';
import { AppError } from '@/common/errors.js';
import { ok } from '@/common/http-response.js';
import type { AppEnv } from '@/config/env.js';
import type { Database } from '@/infrastructure/database.js';
import { registerGaCollectRoutes } from '@/modules/admin/ga-collect.js';

const DEFAULT_MEASUREMENT_ID = 'G-SCTLNG6CV3';
const DEFAULT_SITE_NAME = 'offer星球';
const DEFAULT_DOMAIN = 'offer.gfjianli.com';
const DEFAULT_PROPERTY_ID = '493507078';
const SCRIPT_URL = 'https://api.gfjianli.com/api/ga/t.js';
const COLLECT_ENDPOINT = 'https://api.gfjianli.com/api/c/ga/collect';
const ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

const DEVICE_LABELS: Record<string, string> = {
  mobile: '移动端',
  desktop: '桌面端',
  tablet: '平板',
};
const SOURCE_LABELS: Record<string, string> = {
  'Organic Search': '自然搜索',
  Direct: '直接访问',
  Referral: '引荐',
  'Organic Social': '社交媒体',
  'Paid Search': '付费搜索',
  'Paid Social': '付费社交',
  Email: '邮件',
  Display: '展示广告',
  Unassigned: '未分配',
};

type DashboardQuery = { rangeKey?: string; measurementId?: string; refresh?: string };
type StreamBody = { siteName?: string; domain?: string };
type MetricRow = {
  uv?: number | string | null;
  pv?: number | string | null;
  sessions?: number | string | null;
  newUsers?: number | string | null;
  engagementSec?: number | string | null;
  bouncedSessions?: number | string | null;
  avgDuration?: number | string | null;
};
type DimRow = MetricRow & {
  date?: string | null;
  hour?: number | string | null;
  name?: string | null;
  extra?: string | null;
  bounceRate?: number | string | null;
};
type StreamRow = {
  measurement_id: string;
  site_name: string | null;
  domain: string | null;
  enabled: number | null;
};

type Delta = { value: number; text: string; up: boolean; good: boolean };
type TrendPoint = { date: string; uv: number; pv: number; sessions: number; newUsers: number; bounceRate: number; avgDuration: number };

const dashboardCache = new Map<string, { expiresAt: number; value: unknown }>();

function num(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function shanghaiParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  return { year: pick('year'), month: pick('month'), day: pick('day'), hour: pick('hour'), minute: pick('minute') };
}

function todayKey(): string {
  const parts = shanghaiParts();
  return `${parts.year}${parts.month}${parts.day}`;
}

function shiftKey(ymd: string, days: number): string {
  const year = Number(ymd.slice(0, 4));
  const month = Number(ymd.slice(4, 6));
  const day = Number(ymd.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day + days));
  const nextMonth = String(date.getUTCMonth() + 1).padStart(2, '0');
  const nextDay = String(date.getUTCDate()).padStart(2, '0');
  return `${date.getUTCFullYear()}${nextMonth}${nextDay}`;
}

function showDate(ymd: string): string {
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
}

function normalizeRange(rangeKey: string | undefined): string {
  const value = rangeKey?.trim() || 'today';
  if (value === 'today' || value === 'yesterday' || value === '7d' || value === '30d') return value;
  throw new AppError(400, `不支持的时间范围：${value}`);
}

function dateWindow(rangeKey: string) {
  const today = todayKey();
  if (rangeKey === 'today') {
    const yesterday = shiftKey(today, -1);
    return { currentStart: today, currentEnd: today, previousStart: yesterday, previousEnd: yesterday };
  }
  if (rangeKey === 'yesterday') {
    return {
      currentStart: shiftKey(today, -1),
      currentEnd: shiftKey(today, -1),
      previousStart: shiftKey(today, -2),
      previousEnd: shiftKey(today, -2),
    };
  }
  if (rangeKey === '30d') {
    return {
      currentStart: shiftKey(today, -29),
      currentEnd: today,
      previousStart: shiftKey(today, -59),
      previousEnd: shiftKey(today, -30),
    };
  }
  return {
    currentStart: shiftKey(today, -6),
    currentEnd: today,
    previousStart: shiftKey(today, -13),
    previousEnd: shiftKey(today, -7),
  };
}

function delta(current: number, previous: number, invert: boolean): Delta {
  if (previous === 0) return { value: 0, text: '0.0%', up: true, good: !invert };
  const value = ((current - previous) / previous) * 100;
  const up = value >= 0;
  return { value, text: `${up ? '+' : ''}${value.toFixed(1)}%`, up, good: invert ? !up : up };
}

function divide(left: number, right: number): number {
  return right === 0 ? 0 : left / right;
}

function labelOf(type: string, name: string): string {
  if (type === 'device') return DEVICE_LABELS[name.toLowerCase()] ?? name;
  if (type === 'source') return SOURCE_LABELS[name] ?? name;
  return name;
}

function snippet(measurementId: string): string {
  return `<script defer src="${SCRIPT_URL}" data-mid="${measurementId}" data-endpoint="${COLLECT_ENDPOINT}"></script>`;
}

function normalizeDomain(domain: string): string {
  let value = domain.trim().toLowerCase().replace('https://', '').replace('http://', '');
  const slash = value.indexOf('/');
  if (slash >= 0) value = value.slice(0, slash);
  return value;
}

async function one<T>(db: Kysely<Database>, query: ReturnType<typeof sql>): Promise<T | undefined> {
  const result = await query.execute(db);
  return result.rows[0] as T | undefined;
}

async function many<T>(db: Kysely<Database>, query: ReturnType<typeof sql>): Promise<T[]> {
  const result = await query.execute(db);
  return result.rows as T[];
}

export function registerGaAdminRoutes(app: FastifyInstance, env: AppEnv, db: Kysely<Database>) {
  registerGaCollectRoutes(app, db);
  const adminGuard = requireAdmin(env, db);

  async function dashboard(request: FastifyRequest<{ Querystring: DashboardQuery }>) {
    const rangeKey = normalizeRange(request.query.rangeKey);
    const requestedId = request.query.measurementId?.trim() ?? '';
    const stream = await resolveStream(db, requestedId);
    const cacheKey = `${stream.measurementId}:${rangeKey}`;
    const refresh = request.query.refresh === 'true' || request.query.refresh === '1';
    const cached = dashboardCache.get(cacheKey);
    if (!refresh && cached && cached.expiresAt > Date.now()) {
      return ok({ ...(cached.value as object), fromCache: true });
    }
    const value = await buildDashboard(db, rangeKey, stream);
    const ttl = rangeKey === 'today' || rangeKey === 'yesterday' ? 60_000 : 600_000;
    dashboardCache.set(cacheKey, { expiresAt: Date.now() + ttl, value });
    return ok({ ...value, fromCache: false });
  }

  async function streamList() {
    await ensureDefaultStream(db);
    const rows = await many<StreamRow>(
      db,
      sql`SELECT measurement_id, site_name, domain, enabled FROM t_ga_stream WHERE enabled = 1 ORDER BY create_time ASC`,
    );
    return ok(
      rows.map((row) => ({
        measurementId: row.measurement_id,
        siteName: row.site_name,
        domain: row.domain,
        snippet: snippet(row.measurement_id),
      })),
    );
  }

  async function createStream(request: FastifyRequest<{ Body: StreamBody }>) {
    const siteName = request.body?.siteName?.trim() ?? '';
    const domain = normalizeDomain(request.body?.domain ?? '');
    if (!siteName) throw new AppError(400, '站点名称不能为空');
    if (!domain) throw new AppError(400, '站点域名不能为空');
    const existing = await one<StreamRow>(
      db,
      sql`SELECT measurement_id, site_name, domain, enabled FROM t_ga_stream WHERE domain = ${domain} LIMIT 1`,
    );
    if (existing) throw new AppError(400, `该域名已存在站点：${existing.measurement_id}`);
    const measurementId = await nextMeasurementId(db);
    const now = new Date();
    await sql`
      INSERT INTO t_ga_stream (measurement_id, site_name, domain, property_id, enabled, create_time, update_time)
      VALUES (${measurementId}, ${siteName}, ${domain}, ${DEFAULT_PROPERTY_ID}, 1, ${now}, ${now})
    `.execute(db);
    return ok({ measurementId, siteName, domain, snippet: snippet(measurementId) });
  }

  for (const prefix of ['/app/ga', '/api/app/ga']) {
    app.get<{ Querystring: DashboardQuery }>(`${prefix}/dashboard`, { preHandler: adminGuard }, dashboard);
    app.get(`${prefix}/stream/list`, { preHandler: adminGuard }, streamList);
    app.post<{ Body: StreamBody }>(`${prefix}/stream`, { preHandler: adminGuard }, createStream);
  }
}

async function resolveStream(db: Kysely<Database>, measurementId: string) {
  const mid = measurementId || DEFAULT_MEASUREMENT_ID;
  const row = await one<StreamRow>(
    db,
    sql`SELECT measurement_id, site_name, domain, enabled FROM t_ga_stream WHERE measurement_id = ${mid} LIMIT 1`,
  );
  if (row && row.enabled === 1) {
    return {
      measurementId: row.measurement_id,
      siteName: row.site_name || DEFAULT_SITE_NAME,
      domain: row.domain || DEFAULT_DOMAIN,
    };
  }
  if (measurementId && measurementId !== DEFAULT_MEASUREMENT_ID) {
    throw new AppError(400, `站点不存在或未启用：${measurementId}`);
  }
  return { measurementId: DEFAULT_MEASUREMENT_ID, siteName: DEFAULT_SITE_NAME, domain: DEFAULT_DOMAIN };
}

async function ensureDefaultStream(db: Kysely<Database>) {
  const existing = await one<{ measurement_id: string }>(
    db,
    sql`SELECT measurement_id FROM t_ga_stream WHERE measurement_id = ${DEFAULT_MEASUREMENT_ID} LIMIT 1`,
  );
  if (existing) return;
  const now = new Date();
  await sql`
    INSERT INTO t_ga_stream (measurement_id, site_name, domain, property_id, enabled, create_time, update_time)
    VALUES (${DEFAULT_MEASUREMENT_ID}, ${DEFAULT_SITE_NAME}, ${DEFAULT_DOMAIN}, ${DEFAULT_PROPERTY_ID}, 1, ${now}, ${now})
  `.execute(db);
}

async function nextMeasurementId(db: Kysely<Database>): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    let id = 'G-';
    for (let index = 0; index < 10; index += 1) id += ID_CHARS[randomInt(ID_CHARS.length)];
    const existing = await one(
      db,
      sql`SELECT measurement_id FROM t_ga_stream WHERE measurement_id = ${id} LIMIT 1`,
    );
    if (!existing) return id;
  }
  throw new AppError(400, '生成 data-mid 失败，请重试');
}

async function buildDashboard(
  db: Kysely<Database>,
  rangeKey: string,
  stream: { measurementId: string; siteName: string; domain: string },
) {
  const window = dateWindow(rangeKey);
  const streamId = stream.measurementId;
  const [totals, sessions, trendRows, hourlyRows, devices, sources, cities, pages, realtime] = await Promise.all([
    one<MetricRow>(db, sql`
      SELECT
        COUNT(DISTINCT CASE WHEN event_name = 'page_view' THEN user_pseudo_id END) AS uv,
        SUM(CASE WHEN event_name = 'page_view' THEN 1 ELSE 0 END) AS pv,
        COUNT(DISTINCT CASE WHEN ga_session_id IS NOT NULL AND ga_session_id != '' THEN CONCAT(user_pseudo_id, '#', ga_session_id) END) AS sessions,
        SUM(CASE WHEN event_name = 'first_visit' THEN 1 ELSE 0 END) AS newUsers,
        SUM(IFNULL(engagement_time_msec, 0)) / 1000.0 AS engagementSec
      FROM t_ga_event
      WHERE stream_id = ${streamId} AND event_date BETWEEN ${window.currentStart} AND ${window.currentEnd}
    `),
    one<MetricRow>(db, sessionQuery(streamId, window.currentStart, window.currentEnd)),
    many<DimRow>(db, sql`
      SELECT event_date AS date,
        COUNT(DISTINCT CASE WHEN event_name = 'page_view' THEN user_pseudo_id END) AS uv,
        SUM(CASE WHEN event_name = 'page_view' THEN 1 ELSE 0 END) AS pv,
        COUNT(DISTINCT CASE WHEN ga_session_id IS NOT NULL AND ga_session_id != '' THEN CONCAT(user_pseudo_id, '#', ga_session_id) END) AS sessions,
        SUM(CASE WHEN event_name = 'first_visit' THEN 1 ELSE 0 END) AS newUsers
      FROM t_ga_event
      WHERE stream_id = ${streamId} AND event_date BETWEEN ${window.currentStart} AND ${window.currentEnd}
      GROUP BY event_date
      ORDER BY event_date
    `),
    rangeKey === 'today' || rangeKey === 'yesterday'
      ? many<DimRow>(db, sql`
          SELECT event_hour AS hour,
            COUNT(DISTINCT CASE WHEN event_name = 'page_view' THEN user_pseudo_id END) AS uv,
            SUM(CASE WHEN event_name = 'page_view' THEN 1 ELSE 0 END) AS pv
          FROM t_ga_event
          WHERE stream_id = ${streamId} AND event_date = ${window.currentStart}
          GROUP BY event_hour
          ORDER BY event_hour
        `)
      : Promise.resolve([]),
    many<DimRow>(db, dimensionQuery('device', streamId, window.currentStart, window.currentEnd)),
    many<DimRow>(db, dimensionQuery('source', streamId, window.currentStart, window.currentEnd)),
    many<DimRow>(db, dimensionQuery('city', streamId, window.currentStart, window.currentEnd)),
    many<DimRow>(db, pageQuery(streamId, window.currentStart, window.currentEnd)),
    one<{ realtime: number | string | null }>(db, sql`
      SELECT COUNT(DISTINCT user_pseudo_id) AS realtime
      FROM t_ga_event
      WHERE stream_id = ${streamId}
        AND event_timestamp >= ${Date.now() * 1000 - 5 * 60 * 1000 * 1000}
    `),
  ]);
  const previousTotals = await one<MetricRow>(db, sql`
    SELECT
      COUNT(DISTINCT CASE WHEN event_name = 'page_view' THEN user_pseudo_id END) AS uv,
      SUM(CASE WHEN event_name = 'page_view' THEN 1 ELSE 0 END) AS pv,
      COUNT(DISTINCT CASE WHEN ga_session_id IS NOT NULL AND ga_session_id != '' THEN CONCAT(user_pseudo_id, '#', ga_session_id) END) AS sessions,
      SUM(CASE WHEN event_name = 'first_visit' THEN 1 ELSE 0 END) AS newUsers,
      SUM(IFNULL(engagement_time_msec, 0)) / 1000.0 AS engagementSec
    FROM t_ga_event
    WHERE stream_id = ${streamId} AND event_date BETWEEN ${window.previousStart} AND ${window.previousEnd}
  `);
  const previousSessions = await one<MetricRow>(
    db,
    sessionQuery(streamId, window.previousStart, window.previousEnd),
  );
  const current = merge(totals, sessions);
  const previous = merge(previousTotals, previousSessions);
  const trend = buildTrend(trendRows, window.currentStart, window.currentEnd);
  const hourly = rangeKey === 'today' || rangeKey === 'yesterday' ? buildHourly(hourlyRows) : [];
  const clock = shanghaiParts();
  return {
    siteName: stream.siteName,
    domain: stream.domain,
    measurementId: stream.measurementId,
    updatedAt: `${clock.year}-${clock.month}-${clock.day} ${clock.hour}:${clock.minute}`,
    realtime: num(realtime?.realtime),
    avgDuration: current.avgDuration,
    avgDurationDelta: delta(current.avgDuration, previous.avgDuration, false),
    trend,
    hourly,
    devices: toNamed(devices, 'device', current.uv),
    sources: toNamed(sources, 'source', current.sessions),
    cities: toNamed(cities, 'city', current.uv),
    pages: toPages(pages, current.pv),
    kpis: buildKpis(current, previous, trend, hourly, rangeKey),
  };
}

function sessionQuery(streamId: string, start: string, end: string) {
  return sql`
    SELECT COUNT(*) AS sessions,
      SUM(CASE WHEN pv_cnt = 1 THEN 1 ELSE 0 END) AS bouncedSessions,
      AVG(duration_sec) AS avgDuration
    FROM (
      SELECT user_pseudo_id, ga_session_id,
        SUM(CASE WHEN event_name = 'page_view' THEN 1 ELSE 0 END) AS pv_cnt,
        GREATEST(0, (MAX(event_timestamp) - MIN(event_timestamp)) / 1000000.0) AS duration_sec
      FROM t_ga_event
      WHERE stream_id = ${streamId} AND event_date BETWEEN ${start} AND ${end}
      GROUP BY user_pseudo_id, ga_session_id
    ) t
  `;
}

function dimensionQuery(kind: 'device' | 'source' | 'city', streamId: string, start: string, end: string) {
  if (kind === 'device') {
    return sql`
      SELECT IFNULL(NULLIF(device_category, ''), 'desktop') AS name,
        COUNT(DISTINCT user_pseudo_id) AS uv, COUNT(*) AS pv,
        COUNT(DISTINCT CASE WHEN ga_session_id IS NOT NULL AND ga_session_id != '' THEN CONCAT(user_pseudo_id, '#', ga_session_id) END) AS sessions
      FROM t_ga_event
      WHERE stream_id = ${streamId} AND event_date BETWEEN ${start} AND ${end} AND event_name = 'page_view'
      GROUP BY IFNULL(NULLIF(device_category, ''), 'desktop')
      ORDER BY uv DESC
    `;
  }
  if (kind === 'source') {
    return sql`
      SELECT IFNULL(NULLIF(session_default_channel_group, ''), 'Direct') AS name,
        COUNT(DISTINCT user_pseudo_id) AS uv, COUNT(*) AS pv,
        COUNT(DISTINCT CASE WHEN ga_session_id IS NOT NULL AND ga_session_id != '' THEN CONCAT(user_pseudo_id, '#', ga_session_id) END) AS sessions
      FROM t_ga_event
      WHERE stream_id = ${streamId} AND event_date BETWEEN ${start} AND ${end} AND event_name = 'page_view'
      GROUP BY IFNULL(NULLIF(session_default_channel_group, ''), 'Direct')
      ORDER BY sessions DESC
      LIMIT 10
    `;
  }
  return sql`
    SELECT IFNULL(NULLIF(geo_city, ''), '其他') AS name,
      COUNT(DISTINCT user_pseudo_id) AS uv, COUNT(*) AS pv,
      COUNT(DISTINCT CASE WHEN ga_session_id IS NOT NULL AND ga_session_id != '' THEN CONCAT(user_pseudo_id, '#', ga_session_id) END) AS sessions
    FROM t_ga_event
    WHERE stream_id = ${streamId} AND event_date BETWEEN ${start} AND ${end} AND event_name = 'page_view'
    GROUP BY IFNULL(NULLIF(geo_city, ''), '其他')
    ORDER BY uv DESC
    LIMIT 10
  `;
}

function pageQuery(streamId: string, start: string, end: string) {
  return sql`
    SELECT p.page_path AS name, p.page_title AS extra, p.pv, p.uv, p.sessions,
      IFNULL(b.bounced, 0) / NULLIF(p.sessions, 0) AS bounceRate
    FROM (
      SELECT IFNULL(NULLIF(page_path, ''), '/') AS page_path, MAX(page_title) AS page_title,
        COUNT(*) AS pv, COUNT(DISTINCT user_pseudo_id) AS uv,
        COUNT(DISTINCT CASE WHEN ga_session_id IS NOT NULL AND ga_session_id != '' THEN CONCAT(user_pseudo_id, '#', ga_session_id) END) AS sessions
      FROM t_ga_event
      WHERE stream_id = ${streamId} AND event_date BETWEEN ${start} AND ${end} AND event_name = 'page_view'
      GROUP BY IFNULL(NULLIF(page_path, ''), '/')
    ) p
    LEFT JOIN (
      SELECT page_path, COUNT(*) AS bounced
      FROM (
        SELECT MIN(IFNULL(NULLIF(page_path, ''), '/')) AS page_path
        FROM t_ga_event
        WHERE stream_id = ${streamId} AND event_date BETWEEN ${start} AND ${end} AND event_name = 'page_view'
        GROUP BY user_pseudo_id, ga_session_id
        HAVING COUNT(*) = 1
      ) x
      GROUP BY page_path
    ) b ON p.page_path = b.page_path
    ORDER BY p.pv DESC
    LIMIT 15
  `;
}

function merge(totals: MetricRow | undefined, sessions: MetricRow | undefined) {
  const uv = num(totals?.uv);
  const pv = num(totals?.pv);
  const newUsers = num(totals?.newUsers);
  const engagementSec = num(totals?.engagementSec);
  const sessionCount = sessions ? num(sessions.sessions) : num(totals?.sessions);
  const bouncedSessions = num(sessions?.bouncedSessions);
  const clockDuration = num(sessions?.avgDuration);
  return {
    uv,
    pv,
    newUsers,
    sessions: sessionCount,
    bouncedSessions,
    avgDuration: sessionCount > 0 && engagementSec > 0 ? engagementSec / sessionCount : clockDuration,
  };
}

function buildTrend(rows: DimRow[], start: string, end: string): TrendPoint[] {
  const byDate = new Map(rows.map((row) => [String(row.date), row]));
  const list: TrendPoint[] = [];
  let cursor = start;
  while (cursor <= end) {
    const row = byDate.get(cursor);
    list.push({
      date: showDate(cursor),
      uv: num(row?.uv),
      pv: num(row?.pv),
      sessions: num(row?.sessions),
      newUsers: num(row?.newUsers),
      bounceRate: 0,
      avgDuration: 0,
    });
    cursor = shiftKey(cursor, 1);
  }
  return list;
}

function buildHourly(rows: DimRow[]) {
  const byHour = new Map(rows.map((row) => [num(row.hour), row]));
  return Array.from({ length: 24 }, (_, hour) => {
    const row = byHour.get(hour);
    return { hour, label: `${String(hour).padStart(2, '0')}:00`, uv: num(row?.uv), pv: num(row?.pv) };
  });
}

function toNamed(rows: DimRow[], type: string, total: number) {
  return rows.map((row) => {
    const name = row.name || '其他';
    const uv = num(row.uv);
    const sessions = num(row.sessions);
    const base = type === 'source' ? sessions : uv;
    return { name, label: labelOf(type, name), uv, pv: num(row.pv), sessions, share: total <= 0 ? 0 : base / total };
  });
}

function toPages(rows: DimRow[], totalPv: number) {
  return rows.map((row) => {
    const path = row.name || '/';
    const pv = num(row.pv);
    return {
      path,
      title: row.extra || path,
      pv,
      uv: num(row.uv),
      sessions: num(row.sessions),
      bounceRate: num(row.bounceRate),
      share: totalPv <= 0 ? 0 : pv / totalPv,
    };
  });
}

function bounceRate(agg: { sessions: number; bouncedSessions: number }): number {
  return agg.sessions === 0 ? 0 : agg.bouncedSessions / agg.sessions;
}

function buildKpis(
  current: ReturnType<typeof merge>,
  previous: ReturnType<typeof merge>,
  trend: TrendPoint[],
  hourly: { uv: number; pv: number }[],
  rangeKey: string,
) {
  const sparkUv: number[] = [];
  const sparkPv: number[] = [];
  const sparkSessions: number[] = [];
  const sparkNewUsers: number[] = [];
  const sparkBounce: number[] = [];
  const sparkPvPerUser: number[] = [];
  if ((rangeKey === 'today' || rangeKey === 'yesterday') && hourly.length > 0) {
    for (const point of hourly) {
      sparkUv.push(point.uv);
      sparkPv.push(point.pv);
    }
    sparkSessions.push(...sparkUv);
    sparkNewUsers.push(...sparkUv);
    sparkBounce.push(bounceRate(current));
    sparkPvPerUser.push(divide(current.pv, current.uv));
  } else {
    for (const point of trend) {
      sparkUv.push(point.uv);
      sparkPv.push(point.pv);
      sparkSessions.push(point.sessions);
      sparkNewUsers.push(point.newUsers);
      sparkBounce.push(point.bounceRate);
      sparkPvPerUser.push(divide(point.pv, point.uv));
    }
  }
  const kpi = (key: string, title: string, value: number, isPercent: boolean, precision: number | null, change: Delta, spark: number[]) => ({
    key,
    title,
    value,
    isPercent,
    precision,
    delta: change,
    spark,
  });
  return [
    kpi('uv', 'UV 独立访客', current.uv, false, null, delta(current.uv, previous.uv, false), sparkUv),
    kpi('pv', 'PV 浏览量', current.pv, false, null, delta(current.pv, previous.pv, false), sparkPv),
    kpi('sessions', '会话', current.sessions, false, null, delta(current.sessions, previous.sessions, false), sparkSessions),
    kpi('newUsers', '新用户', current.newUsers, false, null, delta(current.newUsers, previous.newUsers, false), sparkNewUsers),
    kpi('bounceRate', '跳出率', bounceRate(current), true, null, delta(bounceRate(current), bounceRate(previous), true), sparkBounce),
    kpi('pvPerUser', '人均浏览', divide(current.pv, current.uv), false, 2, delta(divide(current.pv, current.uv), divide(previous.pv, previous.uv), false), sparkPvPerUser),
  ];
}
