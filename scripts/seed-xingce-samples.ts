import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadEnv } from '@/config/env.js';
import { createDatabase } from '@/infrastructure/database.js';
import { importXingcePayload } from '@/modules/xingce/xingce-routes.js';

const fixtureRoot = path.resolve(
  import.meta.dirname,
  '../../xingce-superman/fixtures/import',
);

async function walk(dir: string): Promise<string[]> {
  const output: string[] = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, item.name);
    if (item.isDirectory()) {
      if (item.name === '待导入') continue;
      output.push(...(await walk(file)));
    } else if (item.name.endsWith('.json') && item.name !== 'manifest.json') {
      output.push(file);
    }
  }
  return output;
}

const env = loadEnv();
const db = createDatabase(env);
const files = (await walk(fixtureRoot)).sort();
let inserted = 0;
const skipped: string[] = [];
for (const file of files) {
  const payload = JSON.parse(await readFile(file, 'utf8'));
  const result = await importXingcePayload(db, payload);
  inserted += result.inserted;
  skipped.push(...result.skipped);
  console.log(`${path.relative(fixtureRoot, file)} ${result.kind} +${result.inserted}`);
}
console.log(JSON.stringify({ files: files.length, inserted, skipped }));
await db.destroy();
