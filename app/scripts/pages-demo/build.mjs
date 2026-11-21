// 公開デモ（GitHub Pages）を組み立てる。サーバーの無い静的なページで、合成データの応答を録って載せる。
//
//   npm run build                         # 録画に使うサーバー（dist/server）を作る
//   node scripts/pages-demo/build.mjs     # dist/pages に書き出す
//
// 1. 画面を相対パス（base: './'）でビルドし、プロジェクトサイトの /<リポジトリ名>/ の下でも開けるようにする。
// 2. index.html に起動用スクリプト（web/demo-boot.js）と「公開デモ」の注記を入れる。
// 3. 合成データのサーバーを一時フォルダで起動し、応答を demo-data/ に録る（record.mjs）。
// 4. 録ったものに合成データ以外が混じっていないかを見る（screen.mjs）。混じっていたら失敗で終える。
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { record } from './record.mjs';
import { screen } from './screen.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(HERE, '../..');
process.chdir(APP_DIR);

const outArg = process.argv.indexOf('--out');
const OUT = path.resolve(APP_DIR, outArg >= 0 ? process.argv[outArg + 1] : 'dist/pages');

await build({
  configFile: path.join(APP_DIR, 'vite.config.ts'),
  base: './',
  logLevel: 'warn',
  build: { outDir: OUT, emptyOutDir: true },
});

const summary = await record({ outDir: path.join(OUT, 'demo-data') });
for (const s of summary) console.log(`録画 ${s.persona}: 画面 ${s.visited}・GET ${s.get}・待ちきれず ${s.timeouts}・自動の書き込み ${s.write.length}`);

// 録画が薄いまま公開しない歯止め。2026-11-21 の手元の録画は、ペルソナごとの GET が 47〜180 件、
// 待ちきれなかった回数は 0 だった。遅い環境で要求を取りこぼすと、件数が減るか待ちきれない回数が増える。
const MIN_GETS_PER_PERSONA = 35;
const MAX_TIMEOUTS_PER_PERSONA = 5;
const thin = summary.filter((s) => s.get < MIN_GETS_PER_PERSONA || s.timeouts > MAX_TIMEOUTS_PER_PERSONA);
if (summary.length === 0 || thin.length > 0) {
  for (const s of thin) console.error(`録画が薄い: ${s.persona}（GET ${s.get} 件・待ちきれず ${s.timeouts} 回）`);
  console.error('録画を確かめてください。公開しません。');
  process.exit(1);
}

const today = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'long', day: 'numeric' }).format(new Date());
const htmlPath = path.join(OUT, 'index.html');
let html = await readFile(htmlPath, 'utf8');
if (!/<script type="module"/.test(html) || !/<body[^>]*>/.test(html)) throw new Error('index.html の形が想定と違います（起動用スクリプトを入れられません）。');
html = html.replace(/<script type="module"/, '<script src="./demo-boot.js"></script>\n    <script type="module"');
const note = [
  '<div class="pages-demo-note" role="note" style="padding:6px 16px;background:#fff4d6;color:#3d2e00;border-bottom:1px solid #e6cf8f;font:13px/1.6 system-ui,sans-serif">',
  `公開デモ：${today}時点の合成データを表示しています。保存・送信・ダウンロードはできません。`,
  '</div>',
].join('');
html = html.replace(/<body([^>]*)>/, (m) => `${m}\n    ${note}`);
await writeFile(htmlPath, html);
await copyFile(path.join(HERE, 'web/demo-boot.js'), path.join(OUT, 'demo-boot.js'));

const problems = await screen(OUT);
if (problems.length > 0) {
  for (const p of problems) console.error(p);
  console.error(`合成データ以外の疑いが ${problems.length} 件あります。公開しないでください。`);
  process.exit(1);
}
console.log(`書き出し先: ${OUT}`);
