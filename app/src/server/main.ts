import { ConfigError } from './auth.js';
import { loadConfig, type ServerConfig } from './config.js';
import { createShutdown, installSignalHandlers } from './lifecycle.js';
import { composeServer, StartupRefusal, type ServerRuntime } from './runtime.js';

function refuse(message: string): never {
  // Diagnostics only: never secrets, paths, identities or file contents.
  console.error(`起動を中止しました: ${message}`);
  process.exit(1);
}

let config: ServerConfig;
try {
  config = loadConfig();
} catch (err) {
  refuse(err instanceof ConfigError ? err.message : '設定を読み込めませんでした。');
}

let runtime: ServerRuntime;
try {
  runtime = await composeServer(config);
} catch (err) {
  refuse(err instanceof StartupRefusal ? err.message : '起動の準備に失敗しました。');
}
const { app, hosted } = runtime;
const synthetic = !hosted;

await app.listen({ host: config.host, port: config.port });
// SIGTERM / SIGINT: stop accepting, drain DM work, flush state, exit (bounded; see lifecycle.ts).
installSignalHandlers(process, createShutdown(runtime), (code) => process.exit(code));

const taskLine = config.tasks.mode === 'on' ? 'タスク: 連携先のタスクサービスへ署名付きで接続します。' : 'タスク: 未設定（受信箱だけで動作）。';
if (config.auth.mode === 'trusted-proxy') {
  console.log(`共有メール管理（テスト版・合成データのみ）: 信頼済みリバースプロキシ認証モードでポート ${config.port} を待ち受け中`);
  console.log('モック受信の合成データだけを扱います。実メール接続・送信は未実装で、本番運用は承認されていません。');
  console.log(config.line.mode === 'mock' ? 'LINE: 模擬モード（合成データ・模擬送信のみ。実際の LINE には接続しません）。' : 'LINE: 無効。');
} else if (config.auth.mode === 'account' && config.auth.composition === 'production') {
  const direct = config.account?.composition === 'production' && config.account.provider === 'direct' ? config.account : null;
  console.log(
    direct
      ? `共有受信・タスク（account モード・direct 構成）: ポート ${config.port} を待ち受け中。本人確認は Directory 読み取りと本人紐付けレジストリで行います。`
      : `共有受信・タスク（account モード）: ポート ${config.port} を待ち受け中。本人確認は運用者の本人 bridge 経由です。`,
  );
  if (direct?.dm.transport === 'unavailable') console.log('DM 送信: 未提供（コードは送信されません。初回設定・再設定はできず、既存のパスワードだけが使えます）。');
} else if (config.auth.mode === 'discord') {
  console.log(`医薬祭 統合アプリ（Discord アカウントでログイン）: ポート ${config.port} を待ち受け中。公開 URL ${config.auth.publicOrigin}`);
  console.log(config.rental.mode === 'on' ? `物品貸出: 有効${config.rental.driveSyncKey ? '（Google ドライブへの複製: 有効）' : ''}。` : '物品貸出: 未設定。');
} else if (config.auth.mode === 'account') {
  console.log(`共有受信・タスク（模擬ログイン構成・合成データのみ）: http://${config.host}:${config.port}/`);
  console.log('本人紐付け・Group 会員・Discord DM はすべて模擬です。実際の Discord には送信しません。');
} else {
  console.log(`共有メール管理（テスト版・合成データのみ）: http://${config.host}:${config.port}/`);
  console.log('デモ用モック認証です。本番の認証・保存ではありません。');
}
console.log(synthetic ? `${taskLine}（合成データ）` : taskLine);
console.log(config.assistant.mode === 'on' ? 'Bot（アシスタント）: 有効。連携先の Bot ホストへ署名付きで接続します。' : 'Bot（アシスタント）: 無効（SMM_ASSISTANT_MODE=off）。');
