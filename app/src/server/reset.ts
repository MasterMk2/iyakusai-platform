import { loadConfig } from './config.js';
import { createSeedState } from './domain/seed.js';
import { StateStore } from './domain/store.js';
import { createLineSeedState } from './line/seed.js';
import { LineStore } from './line/store.js';

// Overwrites the local demo data file with fresh synthetic sample data.
// Demo mode only: sample reset is disabled whenever trusted-proxy mode is configured.
const config = loadConfig();
if (config.auth.mode !== 'demo') {
  console.error('サンプルの初期化はデモモード専用です。trusted-proxy モードの設定では実行できません。');
  process.exit(1);
}
const store = new StateStore(await createSeedState(new Date().toISOString()), config.dataFile);
store.replace(store.current);
if (config.line.mode === 'mock') {
  const lineSeed = createLineSeedState(new Date().toISOString(), { replyGrants: true });
  new LineStore(lineSeed, config.line.dataFile).replace(lineSeed);
}
console.log('合成サンプルデータを初期化しました。');
