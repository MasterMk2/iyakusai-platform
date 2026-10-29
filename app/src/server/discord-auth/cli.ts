import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { writeFileDurable } from '../durable-file.js';
import { emptyAccountState, mergeWithTrial, migrateFromMinimum, validateAccountState, type MergeOutcome } from './store.js';

// Account file maintenance for the Discord login (run on the server, as the service user):
//   node dist/server/discord-auth/cli.js migrate <minimum accounts.json> <new state file>
//     Converts the production minimal runtime's discord-accounts/v1 file. The source is only read.
//   node dist/server/discord-auth/cli.js merge <minimum accounts.json> <unified app accounts.json> <new state file>
//     At the switch: converts the production file again and keeps what was done in the unified app during the
//     trial (student IDs, sign-ins, password changes). Both sources are only read.
//   node dist/server/discord-auth/cli.js init <new state file>
//     Creates an empty account file (a fresh installation without existing accounts).
//   node dist/server/discord-auth/cli.js check <state file>
//     Validates a state file and prints only counts.
// The target must not exist: an account file is never overwritten. Output never contains IDs or hashes.

function writeNew(target: string, text: string): void {
  if (existsSync(target)) throw new Error('出力先のファイルが既にあります。上書きはしません。');
  writeFileDurable(target, text);
  chmodSync(target, 0o600);
}

function counts(state: { accounts: Record<string, { status: string; studentId: string | null }> }): string {
  const accounts = Object.values(state.accounts);
  const by = (status: string) => accounts.filter((a) => a.status === status).length;
  return `アカウント ${accounts.length} 件（有効 ${by('active')}・登録途中 ${by('pending')}・退会 ${by('retired')}・学籍番号あり ${accounts.filter((a) => a.studentId).length}）`;
}

const OUTCOMES: Record<MergeOutcome, string> = {
  'trial-kept': '統合アプリ側をそのまま（学籍番号・ログイン状態を維持）',
  'trial-newer': '統合アプリ側（パスワードを変更済み。ログイン状態を維持）',
  'production-newer': '旧ログイン側（再登録・再設定済み。学籍番号は引継ぎ、統合アプリは再ログイン）',
  'production-only': '旧ログインで新しく登録（学籍番号は名簿または本人が設定）',
};

const [command, a, b, c] = process.argv.slice(2);
try {
  if (command === 'migrate' && a && b) {
    const state = migrateFromMinimum(JSON.parse(readFileSync(resolve(a), 'utf8')));
    writeNew(resolve(b), `${JSON.stringify(state)}\n`);
    console.log(`移行しました。${counts(state)}。ログイン中の状態（セッション）は移していません。`);
  } else if (command === 'merge' && a && b && c) {
    const { state, report } = mergeWithTrial(JSON.parse(readFileSync(resolve(a), 'utf8')), JSON.parse(readFileSync(resolve(b), 'utf8')));
    writeNew(resolve(c), `${JSON.stringify(state)}\n`);
    for (const line of report) console.log(`${line.initialLoginId}: ${OUTCOMES[line.outcome]}`);
    console.log(`統合しました。${counts(state)}。引き継いだログイン状態 ${Object.keys(state.sessions).length} 件。`);
  } else if (command === 'init' && a) {
    const state = emptyAccountState();
    writeNew(resolve(a), `${JSON.stringify(state)}\n`);
    console.log('空のアカウントファイルを作りました。');
  } else if (command === 'check' && a) {
    const state: unknown = JSON.parse(readFileSync(resolve(a), 'utf8'));
    validateAccountState(state);
    console.log(`形式は正しいです。${counts(state)}。`);
  } else {
    console.error('使い方: cli.js migrate <元の accounts.json> <新しい保存先> | merge <元の accounts.json> <統合アプリの accounts.json> <新しい保存先> | init <新しい保存先> | check <保存先>');
    process.exitCode = 2;
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : '処理できませんでした。');
  process.exitCode = 1;
}
