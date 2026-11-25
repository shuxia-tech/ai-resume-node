/* eslint-disable @typescript-eslint/no-explicit-any */
import type { FastifyInstance } from 'fastify';
import { randomBytes, randomUUID } from 'node:crypto';
import { AppError } from '@/common/errors.js';
import { ok } from '@/common/http-response.js';
import {
  deleteClientToken,
  readAuthCache,
  requireUser,
  requestToken,
  saveClientToken,
} from '@/auth/request-user.js';
import type { AppEnv } from '@/config/env.js';
import type { Database } from '@/infrastructure/database.js';
import type { Kysely } from 'kysely';
import { fetchJson } from '@/common/http-client.js';

type WechatTokenResponse = {
  access_token?: string;
  openid?: string;
  unionid?: string;
  errcode?: number;
  errmsg?: string;
};

type WechatUserResponse = WechatTokenResponse & {
  nickname?: string;
  headimgurl?: string;
  sex?: number;
  privilege?: string[];
};

type WechatProfile = Omit<WechatUserResponse, 'unionid'> & { unionid: string | null };
type WechatChannel = 'open' | 'mp';

function isWeChatBrowser(request: { headers: { 'user-agent'?: string | string[] | undefined } }) {
  const header = request.headers['user-agent'];
  const userAgent = Array.isArray(header) ? header.join(' ') : (header ?? '');
  return /MicroMessenger/i.test(userAgent);
}

function connectUrl(appId: string, redirectUri: string, scope: 'snsapi_login' | 'snsapi_userinfo') {
  const params = new URLSearchParams({
    appid: appId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope,
    state: randomUUID(),
  });
  const endpoint =
    scope === 'snsapi_login'
      ? 'https://open.weixin.qq.com/connect/qrconnect'
      : 'https://open.weixin.qq.com/connect/oauth2/authorize';
  return `${endpoint}?${params.toString()}#wechat_redirect`;
}

function authorizeUrl(env: AppEnv, webName?: string) {
  const redirectUri = redirectUriFor(env, webName);
  if (!env.WECHAT_APP_ID || !redirectUri) throw new AppError(503, '微信登录未配置');
  const redirect = redirectUri.includes('webName=')
    ? redirectUri
    : `${redirectUri}${redirectUri.includes('?') ? '&' : '?'}webName=${encodeURIComponent(webName ?? 'resume')}`;
  return connectUrl(env.WECHAT_APP_ID, redirect, 'snsapi_login');
}

function mpRedirectFor(env: AppEnv, webName?: string) {
  const explicit =
    webName === 'offer'
      ? env.WECHAT_MP_REDIRECT_URI_OFFER
      : webName === 'photo'
        ? env.WECHAT_MP_REDIRECT_URI_PHOTO
        : webName === 'campus'
          ? env.WECHAT_MP_REDIRECT_URI_CAMPUS
          : webName === 'jisu'
            ? env.WECHAT_MP_REDIRECT_URI_JISU
            : webName === 'xingce'
              ? env.WECHAT_MP_REDIRECT_URI_XINGCE
              : env.WECHAT_MP_REDIRECT_URI;
  if (explicit) return explicit;
  const template =
    env.WECHAT_REDIRECT_URI ?? env.WECHAT_REDIRECT_URI_OFFER ?? env.WECHAT_REDIRECT_URI_JISU;
  if (!template) return undefined;
  const url = new URL(template);
  if (!url.pathname.endsWith('/callback/wechat')) return undefined;
  const suffix = !webName || webName === 'resume' ? '' : `/${webName}`;
  url.pathname = url.pathname.replace(/\/callback\/wechat$/, `/wx/getOpenId${suffix}`);
  url.search = '';
  url.hash = '';
  return url.toString();
}

function mpAuthorizeUrl(env: AppEnv, webName?: string) {
  const redirectUri = mpRedirectFor(env, webName);
  if (!env.WECHAT_MP_APP_ID || !env.WECHAT_MP_APP_SECRET || !redirectUri) {
    throw new AppError(503, '微信公众号网页授权未配置');
  }
  if (webName === 'campus' && !env.FRONT_REDIRECT_URI_CAMPUS) {
    throw new AppError(503, '缺少校园市场圈微信公众号或前台回调配置');
  }
  if (webName === 'jisu' && !env.FRONT_REDIRECT_URI_JISU) {
    throw new AppError(503, '缺少极速海投前台登录回调配置');
  }
  return connectUrl(env.WECHAT_MP_APP_ID, redirectUri, 'snsapi_userinfo');
}

function redirectUriFor(env: AppEnv, webName?: string) {
  if (webName === 'offer') return env.WECHAT_REDIRECT_URI_OFFER ?? env.WECHAT_REDIRECT_URI;
  if (webName === 'photo') return env.WECHAT_REDIRECT_URI_PHOTO ?? env.WECHAT_REDIRECT_URI;
  if (webName === 'campus') return env.WECHAT_REDIRECT_URI_CAMPUS ?? env.WECHAT_REDIRECT_URI;
  if (webName === 'jisu') {
    if (!env.WECHAT_REDIRECT_URI_JISU || !env.FRONT_REDIRECT_URI_JISU) {
      throw new AppError(503, '缺少极速海投微信开放平台或前台回调配置');
    }
    return env.WECHAT_REDIRECT_URI_JISU;
  }
  return env.WECHAT_REDIRECT_URI;
}

function frontRedirectFor(env: AppEnv, webName?: string) {
  if (webName === 'offer') return env.FRONT_REDIRECT_URI_OFFER;
  if (webName === 'photo') return env.FRONT_REDIRECT_URI_PHOTO;
  if (webName === 'campus') return env.FRONT_REDIRECT_URI_CAMPUS;
  if (webName === 'jisu') return env.FRONT_REDIRECT_URI_JISU;
  if (webName === 'xingce') return env.FRONT_REDIRECT_URI_XINGCE;
  return env.FRONT_REDIRECT_URI;
}

function throwWechatError(payload: WechatTokenResponse): never {
  throw new AppError(502, `微信授权失败${payload.errmsg ? `：${payload.errmsg}` : ''}`);
}

async function loadWechatUser(
  env: AppEnv,
  code: string,
  channel: WechatChannel = 'open',
): Promise<WechatProfile> {
  const appId = channel === 'mp' ? env.WECHAT_MP_APP_ID : env.WECHAT_APP_ID;
  const secret = channel === 'mp' ? env.WECHAT_MP_APP_SECRET : env.WECHAT_APP_SECRET;
  if (!appId || !secret) {
    throw new AppError(503, channel === 'mp' ? '微信公众号网页授权未配置' : '微信登录未配置');
  }
  const tokenUrl = new URL('https://api.weixin.qq.com/sns/oauth2/access_token');
  tokenUrl.search = new URLSearchParams({
    appid: appId,
    secret,
    code,
    grant_type: 'authorization_code',
  }).toString();
  let token: WechatTokenResponse;
  try {
    token = await fetchJson<WechatTokenResponse>(tokenUrl, {}, env.AI_REQUEST_TIMEOUT_MS);
  } catch (error) {
    throw new AppError(
      error instanceof Error && error.message.includes('超时') ? 504 : 502,
      '微信授权服务不可用',
    );
  }
  if (!token.access_token || !token.openid) throwWechatError(token);
  const userUrl = new URL('https://api.weixin.qq.com/sns/userinfo');
  userUrl.search = new URLSearchParams({
    access_token: token.access_token,
    openid: token.openid,
    lang: 'zh_CN',
  }).toString();
  let profile: WechatUserResponse;
  try {
    profile = await fetchJson<WechatUserResponse>(userUrl, {}, env.AI_REQUEST_TIMEOUT_MS);
  } catch (error) {
    throw new AppError(
      error instanceof Error && error.message.includes('超时') ? 504 : 502,
      '微信用户信息服务不可用',
    );
  }
  if (!profile.openid || profile.errcode) throwWechatError(profile);
  return { ...profile, unionid: profile.unionid ?? token.unionid ?? null } as WechatProfile;
}

async function findOrCreateWechatUser(db: Kysely<Database>, profile: WechatProfile) {
  const account = profile.unionid ?? profile.openid!;
  const existing = await db
    .selectFrom('client_user')
    .selectAll()
    .where((eb) =>
      eb.or([
        ...(profile.unionid ? [eb('union_id', '=', profile.unionid)] : []),
        eb('wechat_openid', '=', profile.openid!),
        eb('ACCOUNT', '=', account),
      ]),
    )
    .where('DELETE_FLAG', '=', 'NOT_DELETE')
    .executeTakeFirst();
  if (existing) {
    await db
      .updateTable('client_user')
      .set({
        union_id: profile.unionid ?? existing.union_id,
        wechat_openid: profile.openid,
        NICKNAME: profile.nickname ?? existing.NICKNAME,
        AVATAR: profile.headimgurl ?? existing.AVATAR,
      } as any)
      .where('ID', '=', existing.ID)
      .execute();
    return existing.ID;
  }
  const id = randomUUID().replaceAll('-', '').slice(0, 20);
  await db
    .insertInto('client_user')
    .values({
      ID: id,
      ACCOUNT: account,
      NICKNAME: profile.nickname ?? null,
      AVATAR: profile.headimgurl ?? null,
      union_id: profile.unionid ?? null,
      wechat_openid: profile.openid,
      DELETE_FLAG: 'NOT_DELETE',
      user_status: 'ENABLE',
      create_time: new Date(),
    } as any)
    .execute();
  return id;
}

function flag(value: unknown): boolean {
  if (Buffer.isBuffer(value)) return value.length > 0 && value[0] !== 0;
  return value === true || value === 1 || value === '1';
}

function decimalOrNull(value: unknown): number | null {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function flagOrNull(value: unknown): boolean | null {
  if (value == null || value === '') return null;
  return flag(value);
}

function numberOrNull(value: unknown): number | null {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function column(user: Record<string, unknown>, ...names: string[]) {
  for (const name of names) {
    if (user[name] !== undefined) return user[name];
  }
  return undefined;
}

function extJsonObject(value: unknown) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function shanghaiDay(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function mapUser(
  user: Record<string, unknown>,
  flags: { hasSignedIn: boolean; weeklyQuestionnaireFlag: boolean },
) {
  const extJson = column(user, 'EXT_JSON', 'ext_json') ?? null;
  const userStatus = column(user, 'USER_STATUS', 'user_status') ?? null;
  return {
    id: column(user, 'ID', 'id'),
    avatar: column(user, 'AVATAR', 'avatar') ?? null,
    signature: column(user, 'SIGNATURE', 'signature') ?? null,
    account: column(user, 'ACCOUNT', 'account') ?? null,
    name: column(user, 'NAME', 'name') ?? null,
    nickname: column(user, 'NICKNAME', 'nickname') ?? null,
    phone: column(user, 'PHONE', 'phone') ?? null,
    email: column(user, 'EMAIL', 'email') ?? null,
    lastLoginIp: column(user, 'LAST_LOGIN_IP', 'last_login_ip') ?? null,
    lastLoginAddress: column(user, 'LAST_LOGIN_ADDRESS', 'last_login_address') ?? null,
    lastLoginTime: column(user, 'LAST_LOGIN_TIME', 'last_login_time') ?? null,
    lastLoginDevice: column(user, 'LAST_LOGIN_DEVICE', 'last_login_device') ?? null,
    latestLoginIp: column(user, 'LATEST_LOGIN_IP', 'latest_login_ip') ?? null,
    latestLoginAddress: column(user, 'LATEST_LOGIN_ADDRESS', 'latest_login_address') ?? null,
    latestLoginTime: column(user, 'LATEST_LOGIN_TIME', 'latest_login_time') ?? null,
    latestLoginDevice: column(user, 'LATEST_LOGIN_DEVICE', 'latest_login_device') ?? null,
    consumeMagic: null,
    residualMagic: null,
    dayMagic: null,
    invitationCode: column(user, 'invitation_code') ?? null,
    memberLevel: column(user, 'member_level') ?? null,
    memberExpirationTime: column(user, 'member_expiration_time') ?? null,
    userStatus,
    sortCode: numberOrNull(column(user, 'SORT_CODE', 'sort_code')),
    extJson,
    extJsonObj: extJsonObject(extJson),
    buttonCodeList: null,
    mobileButtonCodeList: null,
    permissionCodeList: null,
    roleCodeList: null,
    password: null,
    hasSignedIn: flags.hasSignedIn,
    firstQuestionnaireFlag: flagOrNull(column(user, 'first_questionnaire_flag')),
    invitationRebateRate: decimalOrNull(column(user, 'invitation_rebate_rate')),
    weeklyQuestionnaireFlag: flags.weeklyQuestionnaireFlag,
    createTime: column(user, 'CREATE_TIME', 'create_time') ?? null,
    hasUseInvitationCode: null,
    hasDistributionPromoCode: flag(column(user, 'has_distribution_promo_code')),
    hasPublishCases: flag(column(user, 'has_publish_cases')),
    shareFreeMember: numberOrNull(column(user, 'share_free_member')),
    unionId: column(user, 'union_id') ?? null,
    offerMemberExpirationTime: column(user, 'offer_member_expiration_time') ?? null,
    photoMemberExpirationTime: column(user, 'photo_member_expiration_time') ?? null,
    withdrawnRebateAmount: decimalOrNull(column(user, 'withdrawn_rebate_amount')),
    hasOfferDistributionRebate: flag(column(user, 'has_offer_distribution_rebate')),
    wechatOpenid: column(user, 'wechat_openid') ?? null,
    enabled: userStatus === 'ENABLE',
  };
}

export function registerAuthRoutes(app: FastifyInstance, env: AppEnv, db: Kysely<Database>) {
  const authenticate = requireUser(env);
  function loginUrl(request: {
    headers: { 'user-agent'?: string | string[] | undefined };
    query: unknown;
  }) {
    const webName = String((request.query as any).webName ?? 'resume');
    return isWeChatBrowser(request) ? mpAuthorizeUrl(env, webName) : authorizeUrl(env, webName);
  }
  app.post('/oauth/resume/render/wechat', async (request) => ok(loginUrl(request)));
  app.get('/oauth/resume/render/wechat', async (request) => ok(loginUrl(request)));
  app.get('/oauth/resume/wx/getCode', async (request) =>
    ok(mpAuthorizeUrl(env, String((request.query as any).webName ?? 'resume'))),
  );
  app.get('/oauth/resume/wx/getCode/offer', async () => ok(mpAuthorizeUrl(env, 'offer')));
  app.get('/oauth/resume/wx/getCode/photo', async () => ok(mpAuthorizeUrl(env, 'photo')));
  app.get('/oauth/resume/wx/getCode/campus', async () => ok(mpAuthorizeUrl(env, 'campus')));
  app.get('/oauth/resume/wx/getCode/jisu', async () => ok(mpAuthorizeUrl(env, 'jisu')));
  async function completeWechatCallback(
    request: any,
    reply: any,
    webName?: string,
    channel: WechatChannel = 'open',
  ) {
    const { code } = request.query as { code?: string };
    if (!code) throw new AppError(400, '微信授权 code 不能为空');
    const profile = await loadWechatUser(env, code, channel);
    const userId = await findOrCreateWechatUser(db, profile);
    const token = randomBytes(32).toString('hex');
    await saveClientToken(env, token, userId);
    const redirect = frontRedirectFor(env, webName);
    if (webName === 'jisu' && !redirect) {
      throw new AppError(503, '缺少极速海投前台登录回调配置');
    }
    if (!redirect) return ok({ token, userId });
    const separator = redirect.includes('?') ? (redirect.endsWith('=') ? '' : '&') : '?';
    return reply.redirect(
      `${redirect}${separator}${redirect.endsWith('=') ? '' : 'token='}${encodeURIComponent(token)}`,
    );
  }
  app.get('/oauth/resume/wx/getOpenId', (request, reply) =>
    completeWechatCallback(request, reply, undefined, 'mp'),
  );
  app.get('/oauth/resume/wx/getOpenId/offer', (request, reply) =>
    completeWechatCallback(request, reply, 'offer', 'mp'),
  );
  app.get('/oauth/resume/wx/getOpenId/photo', (request, reply) =>
    completeWechatCallback(request, reply, 'photo', 'mp'),
  );
  app.get('/oauth/resume/wx/getOpenId/campus', (request, reply) =>
    completeWechatCallback(request, reply, 'campus', 'mp'),
  );
  app.get('/oauth/resume/wx/getOpenId/jisu', (request, reply) =>
    completeWechatCallback(request, reply, 'jisu', 'mp'),
  );
  app.get('/oauth/resume/wx/getOpenId/xingce', (request, reply) =>
    completeWechatCallback(request, reply, 'xingce', 'mp'),
  );
  app.get('/oauth/resume/callback/wechat', (request, reply) =>
    completeWechatCallback(
      request,
      reply,
      String((request.query as { webName?: string }).webName ?? 'resume'),
    ),
  );

  async function currentUser(request: any) {
    await authenticate(request);
    const user = await db
      .selectFrom('client_user')
      .selectAll()
      .where('ID', '=', request.userId!)
      .where('DELETE_FLAG', '=', 'NOT_DELETE')
      .executeTakeFirst();
    if (!user) throw new AppError(404, '用户不存在');
    const userId = request.userId as string;
    const [signedIn, weeklyQuestionnaire] = await Promise.all([
      readAuthCache(env, `HasSignedIn_${shanghaiDay()}_${userId}`),
      readAuthCache(env, `WeeklyQuestionnaireFlag_${userId}`),
    ]);
    return ok(
      mapUser(user as Record<string, unknown>, {
        hasSignedIn: signedIn !== null,
        weeklyQuestionnaireFlag: weeklyQuestionnaire !== null,
      }),
    );
  }
  app.get('/auth/c/getLoginUser', { preHandler: authenticate }, currentUser);
  app.get('/auth/c/getLoginUser/offer', { preHandler: authenticate }, currentUser);
  app.get('/auth/c/getLoginUser/photo', { preHandler: authenticate }, currentUser);
  app.get('/auth/c/doLogout', { preHandler: authenticate }, async (request) => {
    const token = requestToken(request);
    if (token) await deleteClientToken(env, token);
    return ok(null);
  });
}
