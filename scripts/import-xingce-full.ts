import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadEnv } from '@/config/env.js';
import { createDatabase } from '@/infrastructure/database.js';
import {
  bindCosConfigDatabase,
  cosObjectExists,
  cosPublicUrl,
  uploadToCosKey,
} from '@/modules/storage/cos-service.js';
import { importXingcePayload, upsertXingcePaper } from '@/modules/xingce/xingce-routes.js';

const COPY_PUBLIC = path.resolve(import.meta.dirname, '../../xingce-superman copy/public');
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.jfif', '.bmp']);
const SKIP_ASSET_DIRS = new Set(['brand', 'invite']);
const CONCURRENCY = 8;
const MAX_RECORDS = 100_000;
const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.jfif': 'image/jpeg',
  '.bmp': 'image/bmp',
};

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const BANKS = [
  'zhiding-bank.json',
  'zhiding-six-bank.json',
  'beisen-bank.json',
  'nowcoder-2026-bank.json',
  'saima-2026-bank.json',
  'beisen-2026-latest-bank.json',
  'personality-bank.json',
  'graphics-expansion-bank.json',
];

function log(message: string) {
  console.log(`[xingce-import] ${message}`);
}

async function walkFiles(dir: string): Promise<string[]> {
  const output: string[] = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    if (SKIP_ASSET_DIRS.has(item.name)) continue;
    const file = path.join(dir, item.name);
    if (item.isDirectory()) output.push(...(await walkFiles(file)));
    else output.push(file);
  }
  return output;
}

async function mapPool<T>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<void>) {
  let cursor = 0;
  async function run() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      await worker(items[index]!, index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(items.length, 1)) }, run));
}

function localAssetPath(value: string) {
  const trimmed = value.trim().replace(/^\.\//, '').replace(/^\//, '');
  if (!trimmed.startsWith('assets/')) return '';
  if (trimmed.includes('..') || trimmed.includes('\\')) return '';
  return trimmed;
}

function rewriteJson(value: Json, urls: Map<string, string>): Json {
  if (typeof value === 'string') {
    const local = localAssetPath(value);
    if (local && urls.has(local)) return urls.get(local) as string;
    return value.replace(/(src=["'])(assets\/[^"']+)/g, (_match, prefix: string, asset: string) => {
      const mapped = urls.get(asset);
      return mapped ? `${prefix}${mapped}` : `${prefix}${asset}`;
    });
  }
  if (Array.isArray(value)) return value.map((item) => rewriteJson(item, urls));
  if (value && typeof value === 'object') {
    const next: { [key: string]: Json } = {};
    for (const [key, item] of Object.entries(value)) next[key] = rewriteJson(item, urls);
    return next;
  }
  return value;
}

function applyRedraws(
  question: Record<string, Json>,
  redraws: Map<string, Record<string, Json>>,
  urls: Map<string, string>,
) {
  const entry = redraws.get(String(question.id || ''));
  if (!entry || entry.status !== 'source_checked') return question;
  const next = { ...question };
  const stem = typeof entry.stem === 'string' ? urls.get(localAssetPath(entry.stem)) : undefined;
  if (stem) next.stemImage = stem;
  if (entry.options && typeof entry.options === 'object' && !Array.isArray(entry.options)) {
    const options: { [key: string]: Json } = {};
    for (const [key, value] of Object.entries(entry.options)) {
      const mapped = typeof value === 'string' ? urls.get(localAssetPath(value)) : undefined;
      options[key] = mapped || value;
    }
    next.optionImages = options;
    next.vectorAssets = { stem: stem || '', options };
  }
  return next;
}

function applyHygiene(question: Record<string, Json>, replacements: Record<string, string>) {
  const next = { ...question };
  for (const key of ['stemImage', 'sourceImage'] as const) {
    const current = next[key];
    if (typeof current === 'string' && replacements[current]) next[key] = replacements[current];
  }
  if (Array.isArray(next.sourceImages)) {
    next.sourceImages = next.sourceImages.map((item) =>
      typeof item === 'string' && replacements[item] ? replacements[item] : item,
    );
  }
  return next;
}

async function readJson(file: string) {
  return JSON.parse(await readFile(file, 'utf8')) as Record<string, Json>;
}

function prepareQuestion(
  raw: Record<string, Json>,
  urls: Map<string, string>,
  redraws: Map<string, Record<string, Json>>,
  replacements: Record<string, string>,
) {
  return applyRedraws(rewriteJson(applyHygiene(raw, replacements), urls) as Record<string, Json>, redraws, urls);
}

function preparePayload(payload: Record<string, Json>, urls: Map<string, string>) {
  return rewriteJson(payload, urls) as Record<string, Json>;
}

const env = loadEnv();
const db = createDatabase(env);
bindCosConfigDatabase(db);

log(`source ${COPY_PUBLIC}`);

const hygiene = await readJson(path.join(COPY_PUBLIC, 'content-hygiene.json')).catch(() => ({}) as Record<string, Json>);
const replacements =
  hygiene.imageReplacements && typeof hygiene.imageReplacements === 'object' && !Array.isArray(hygiene.imageReplacements)
    ? (hygiene.imageReplacements as Record<string, string>)
    : {};

const redrawFile = await readJson(path.join(COPY_PUBLIC, 'figure-redraws.json')).catch(() => ({ entries: [] }));
const redraws = new Map<string, Record<string, Json>>();
if (Array.isArray(redrawFile.entries)) {
  for (const entry of redrawFile.entries) {
    if (entry && typeof entry === 'object' && !Array.isArray(entry) && typeof entry.id === 'string') {
      redraws.set(entry.id, entry);
    }
  }
}

const imageFiles = (await walkFiles(path.join(COPY_PUBLIC, 'assets'))).filter((file) =>
  IMAGE_EXT.has(path.extname(file).toLowerCase()),
);
log(`images to upload ${imageFiles.length}`);

const urlByAsset = new Map<string, string>();
let uploaded = 0;
let existed = 0;
let failed = 0;

await mapPool(imageFiles, CONCURRENCY, async (file, index) => {
  const relative = path.relative(COPY_PUBLIC, file).split(path.sep).join('/');
  const key = `xingce/${relative}`;
  try {
    if (await cosObjectExists(env, key)) {
      urlByAsset.set(relative, await cosPublicUrl(env, key));
      existed += 1;
    } else {
      const body = await readFile(file);
      urlByAsset.set(relative, await uploadToCosKey(env, body, MIME[path.extname(file).toLowerCase()], key));
      uploaded += 1;
    }
  } catch (error) {
    failed += 1;
    log(`image fail ${relative}: ${error instanceof Error ? error.message : error}`);
  }
  if ((index + 1) % 200 === 0 || index + 1 === imageFiles.length) {
    log(`images ${index + 1}/${imageFiles.length} uploaded=${uploaded} existed=${existed} failed=${failed}`);
  }
});

for (const [from, to] of Object.entries(replacements)) {
  const mapped = urlByAsset.get(to) || urlByAsset.get(from);
  if (mapped) urlByAsset.set(from, mapped);
}

const totals = { inserted: 0, updated: 0, skipped: 0, files: 0 };

async function importPayload(label: string, payload: unknown) {
  const result = await importXingcePayload(db, payload, { maxRecords: MAX_RECORDS });
  totals.inserted += result.inserted;
  totals.updated += result.updated;
  totals.skipped += result.skipped.length;
  totals.files += 1;
  log(
    `${label} ${result.kind}/${result.batchId} +${result.inserted} ~${result.updated} skip ${result.skipped.length}`,
  );
}

for (const name of BANKS) {
  const raw = await readJson(path.join(COPY_PUBLIC, name));
  const payload = preparePayload(raw, urlByAsset);
  for (const key of ['questions', 'drafts', 'references'] as const) {
    const list = payload[key];
    if (!Array.isArray(list)) continue;
    payload[key] = list.map((item) =>
      item && typeof item === 'object' && !Array.isArray(item)
        ? prepareQuestion(item, urlByAsset, redraws, replacements)
        : item,
    );
  }
  if (
    (Array.isArray(payload.questions) && payload.questions.length) ||
    (Array.isArray(payload.drafts) && payload.drafts.length) ||
    (Array.isArray(payload.references) && payload.references.length)
  ) {
    await importPayload(name, payload);
  } else {
    log(`${name} empty, skip`);
  }
}

const paperDir = path.join(COPY_PUBLIC, 'civil-papers');
const paperFiles = (await readdir(paperDir)).filter((name) => name.endsWith('.json')).sort();
log(`civil papers ${paperFiles.length}`);
for (const [index, name] of paperFiles.entries()) {
  const raw = await readJson(path.join(paperDir, name));
  const questions = Array.isArray(raw.questions) ? raw.questions : [];
  const prepared = questions
    .filter((item): item is Record<string, Json> => Boolean(item && typeof item === 'object' && !Array.isArray(item)))
    .map((item) => prepareQuestion(item, urlByAsset, redraws, replacements));
  if (!prepared.length) continue;
  await importPayload(name, {
    batch: { id: 'civil-service-2016-2026' },
    questions: prepared.filter((item) => item.status === 'published' || !item.status),
    drafts: prepared.filter((item) => item.status && item.status !== 'published' && item.status !== 'reference'),
    references: prepared.filter((item) => item.status === 'reference'),
  });
  if ((index + 1) % 20 === 0 || index + 1 === paperFiles.length) {
    log(`civil papers ${index + 1}/${paperFiles.length}`);
  }
}

const civilIndex = await readJson(path.join(COPY_PUBLIC, 'civil-index.json'));
if (Array.isArray(civilIndex.papers)) {
  let papers = 0;
  for (const item of civilIndex.papers) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const id = String(item.id || '');
    if (!id) continue;
    await upsertXingcePaper(db, {
      id,
      title: String(item.title || id),
      year: String(item.year || ''),
      region: String(item.region || ''),
      payloadJson: JSON.stringify(item),
    });
    papers += 1;
  }
  log(`civil paper rows ${papers}`);
}

for (const name of ['interviews.json', 'zhijihua-interviews.json']) {
  const payload = preparePayload(await readJson(path.join(COPY_PUBLIC, name)), urlByAsset);
  await importPayload(name, payload);
}

await importPayload(
  'daily-questions.json',
  preparePayload(await readJson(path.join(COPY_PUBLIC, 'daily-questions.json')), urlByAsset),
);

log(
  JSON.stringify({
    images: { uploaded, existed, failed, mapped: urlByAsset.size },
    records: totals,
  }),
);

await db.destroy();
