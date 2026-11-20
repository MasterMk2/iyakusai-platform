// 公開デモに載せる録画（demo-data/）と index.html に、合成データ以外のものが混じっていないかを見る。
//   node scripts/pages-demo/screen.mjs [dist/pages]
// 見つけたら一覧を出して終了コード 1。合成データの約束（.example などの予約ドメイン）から外れたものを止める。
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// 合成データで使ってよいメールのドメイン（RFC 2606 の予約名と、空き具合の合成のサービスアカウント）
const ALLOWED_MAIL = [/\.example$/, /^example\.(com|net|org)$/, /\.test$/, /\.invalid$/, /\.localhost$/, /^demo-project\.iam\.gserviceaccount\.com$/];
const ALLOWED_URL_HOST = [/(^|\.)example$/, /^example\.(com|net|org)$/, /\.test$/, /\.invalid$/, /^localhost$/, /^127\.0\.0\.1$/];

const CHECKS = [
  {
    what: 'メールアドレス',
    re: /[A-Za-z0-9._%+-]+@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})/g,
    ok: (m) => ALLOWED_MAIL.some((re) => re.test(m[1].toLowerCase())),
  },
  {
    what: 'URL',
    re: /https?:\/\/([A-Za-z0-9.-]+)/g,
    ok: (m) => ALLOWED_URL_HOST.some((re) => re.test(m[1].toLowerCase())) || /^(www\.)?w3\.org$/.test(m[1]),
  },
  {
    what: 'プライベートの IP アドレス',
    re: /\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01])|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7]))\.\d{1,3}\.\d{1,3}\b/g,
    ok: () => false,
  },
  { what: '個人のフォルダのパス', re: /[A-Za-z]:\\\\?Users\\|\/Users\/[^/\s"]+|\/home\/[^/\s"]+/g, ok: () => false },
];

/** dir の demo-data/*.json と index.html を調べ、問題の一覧を返す。 */
export async function screen(dir) {
  const files = [path.join(dir, 'index.html')];
  for (const name of await readdir(path.join(dir, 'demo-data'))) if (name.endsWith('.json')) files.push(path.join(dir, 'demo-data', name));
  const problems = [];
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    for (const check of CHECKS) {
      for (const m of text.matchAll(check.re)) {
        if (!check.ok(m)) problems.push(`${path.relative(dir, file)}: ${check.what}「${m[0]}」`);
      }
    }
  }
  return [...new Set(problems)];
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = path.resolve(APP_DIR, process.argv[2] ?? 'dist/pages');
  const problems = await screen(dir);
  for (const p of problems) console.error(p);
  if (problems.length > 0) {
    console.error(`合成データ以外の疑いが ${problems.length} 件あります。公開しないでください。`);
    process.exitCode = 1;
  } else {
    console.log('合成データ以外の疑いはありませんでした。');
  }
}
