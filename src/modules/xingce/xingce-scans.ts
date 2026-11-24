import { sql, type Kysely } from 'kysely';
import type { Database } from '@/infrastructure/database.js';

const scanRows = (batchId: string) => sql`
  FROM t_xingce_question
  WHERE batch_id = ${batchId} AND delete_flag = 'NOT_DELETE'
    AND status IN ('published', 'reference')
    AND (
      JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.sourceImage'))
        REGEXP '^(https?://|([.]/|/)?assets/)'
      OR JSON_SEARCH(payload_json, 'one', 'http%', NULL, '$.sourceImages[*]') IS NOT NULL
      OR JSON_SEARCH(payload_json, 'one', '%assets/%', NULL, '$.sourceImages[*]') IS NOT NULL
    )
`;

export async function hasCollectionScans(db: Kysely<Database>, batchId: string) {
  const result = await sql<{ found: number }>`SELECT 1 AS found ${scanRows(batchId)} LIMIT 1`.execute(db);
  return result.rows.length > 0;
}

type ScanRow = {
  source: string;
  book: string | null;
  page: string | null;
  image: string | null;
  images: string | null;
  extracted_text: string | null;
  stem: string;
};

type ScanPage = {
  book: string;
  page: number | null;
  image: string;
  text: string;
  imageWithheld: boolean;
};

function imageList(row: ScanRow) {
  const images: unknown = JSON.parse(row.images ?? 'null');
  const candidates = [row.image, ...(Array.isArray(images) ? images : [])];
  return [...new Set(candidates.flatMap((candidate) => {
    if (typeof candidate !== 'string') return [];
    const image = candidate.trim().replace(/^\.\//, '');
    if (/^\/?assets\/[^\s]+$/i.test(image)) return [image];
    if (!/^https?:\/\//i.test(image)) return [];
    try {
      return [new URL(image).href];
    } catch {
      return [];
    }
  }))];
}

function pageNumber(value: string | null | undefined) {
  if (!value || !/^\d+$/.test(value)) return null;
  const page = Number(value);
  return Number.isSafeInteger(page) && page > 0 ? page : null;
}

export function collectionScanIndex(rows: ScanRow[]) {
  const sources = new Map<string, { id: string; name: string; pages: number }>();
  const scans = new Map<string, { page: ScanPage; texts: Set<string> }>();

  for (const row of rows) {
    const images = imageList(row);
    if (!images.length) continue;
    const name = row.source || row.book || '题目原页';
    const book = row.book || name;
    const source = sources.get(book) ?? { id: book, name, pages: 0 };
    sources.set(book, source);

    const extracted = row.extracted_text?.trim() || row.stem.trim();
    images.forEach((image, index) => {
      const filePage = image.match(/\/page-(\d+)\.[a-z]+(?:[?#]|$)/i)?.[1];
      const page = pageNumber(filePage) ?? (index === 0 ? pageNumber(row.page) : null);
      if (page !== null) source.pages = Math.max(source.pages, page);
      const key = JSON.stringify([book, page, image]);
      let scan = scans.get(key);
      if (!scan) {
        scan = {
          page: { book, page, image, text: '', imageWithheld: /\/content-withheld\.svg(?:[?#]|$)/i.test(image) },
          texts: new Set(),
        };
        scans.set(key, scan);
      }
      if (extracted && scan.texts.size < 20) scan.texts.add(extracted.slice(0, 2000));
    });
  }

  const pages = [...scans.values()].map(({ page, texts }) => ({
    ...page,
    text: [...texts].join('\n\n').slice(0, 8000),
  })).sort((left, right) =>
    left.book.localeCompare(right.book, 'zh') ||
    (left.page ?? Infinity) - (right.page ?? Infinity),
  );

  return { sources: [...sources.values()], pages };
}

export async function loadCollectionScans(db: Kysely<Database>, batchId: string) {
  const result = await sql<ScanRow>`
    SELECT source, LEFT(stem, 2000) AS stem,
      NULLIF(JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.sourceBookId')), 'null') AS book,
      JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.page')) AS page,
      JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.sourceImage')) AS image,
      CAST(JSON_EXTRACT(payload_json, '$.sourceImages') AS CHAR CHARACTER SET utf8mb4) AS images,
      LEFT(COALESCE(
        NULLIF(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.ocrText')), 'null'), ''),
        NULLIF(JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.transcript')), 'null')
      ), 2000) AS extracted_text
    ${scanRows(batchId)}
    ORDER BY id ASC
  `.execute(db);
  return collectionScanIndex(result.rows);
}
