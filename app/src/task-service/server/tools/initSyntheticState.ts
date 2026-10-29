import { existsSync } from 'node:fs';
import path from 'node:path';
import { createSeedState } from '../domain/seed.js';
import { FileStore } from '../storage/fileStore.js';

// 保護モードを「架空データで」試すための初期データ作成ツール。指定したファイルが既にあれば何もしない
// （既存データを上書き・初期化しない）。本番の初期データは運用者が別途用意する。
// 使い方: node dist/server/tools/initSyntheticState.js <保存先.json>

async function main(): Promise<void> {
  const target = process.argv[2];
  if (!target) throw new Error('保存先のファイルを指定してください。');
  const file = path.resolve(target);
  if (existsSync(file)) {
    console.info('保存先は既に存在するため変更しません。');
    return;
  }
  // 読み込んで「無い」ことを確かめたストアだけが保存できる（その間に作られたファイルは上書きしない）。
  const store = new FileStore(file);
  await store.load();
  await store.save(createSeedState(new Date()));
  console.info('架空のサンプルデータを作成しました（試用専用）。');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : '作成できませんでした。');
  process.exit(1);
});
