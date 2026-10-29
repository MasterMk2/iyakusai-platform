import { readFileSync } from 'node:fs';
import { INTEGRATION_PREFIX } from '../integration/app.js';
import { parseKeyMaterial, signedHeaders } from '../integration/signing.js';

// 模擬 Discord 送信（MOCK TRANSPORT）。実際の Discord には接続せず、Bot トークンも使わない。
// 連携 Bot が Discord で検証済みの interaction を送る代わりに、架空の guild/channel/利用者 ID と
// 明示コマンドを署名付きで保護モードの Task API へ送る。試用とテストのためだけの道具。
// 使い方: node dist/server/tools/mockDiscord.js <Task API の URL> <連携鍵ファイル> '<コマンド JSON>'

async function main(): Promise<void> {
  const [baseUrl, keyFile, json] = process.argv.slice(2);
  if (!baseUrl || !keyFile || !json) throw new Error('URL・鍵ファイル・コマンド JSON を指定してください。');
  const url = new URL(baseUrl);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('模擬送信はループバックの Task API にだけ送れます。');
  }
  const key = parseKeyMaterial(readFileSync(keyFile, 'utf8'));
  if (!key) throw new Error('鍵ファイルの内容が正しくありません。');
  const body = JSON.stringify(JSON.parse(json));
  const path = `${INTEGRATION_PREFIX}/discord/commands`;
  const response = await fetch(new URL(path, url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...signedHeaders(key, { client: 'discord-bridge', method: 'POST', path, body }) },
    body,
  });
  const result = (await response.json()) as { reply?: string; error?: { message?: string } };
  console.info(`[模擬 Discord] HTTP ${response.status}`);
  console.info(result.reply ?? result.error?.message ?? '');
  if (!response.ok) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : '送信できませんでした。');
  process.exit(1);
});
