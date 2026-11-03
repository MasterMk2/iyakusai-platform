// Compares a vitest JSON report with tests/known-failures.json.
// Fails on any failure that is not listed, and on a test file that failed to load.
// A listed test that now passes only prints a notice: remove it from the list in the same change.
// Usage: node scripts/check-test-baseline.mjs <vitest-report.json>
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const reportPath = process.argv[2];
if (!reportPath) {
  console.error('usage: node scripts/check-test-baseline.mjs <vitest-report.json>');
  process.exit(2);
}

const appDir = resolve(import.meta.dirname, '..');
const report = JSON.parse(readFileSync(reportPath, 'utf8'));
const known = new Set(JSON.parse(readFileSync(resolve(appDir, 'tests/known-failures.json'), 'utf8')).failures);

const failed = new Set();
const brokenFiles = [];
for (const file of report.testResults) {
  const name = relative(appDir, file.name).replaceAll('\\', '/');
  if (file.status !== 'passed' && file.assertionResults.length === 0) {
    brokenFiles.push(`${name}: ${(file.message ?? '').split('\n')[0]}`);
  }
  for (const test of file.assertionResults) {
    if (test.status === 'failed') failed.add(`${name} > ${test.fullName}`);
  }
}

const unexpected = [...failed].filter((key) => !known.has(key)).sort();
const nowPassing = [...known].filter((key) => !failed.has(key)).sort();

for (const key of nowPassing) console.log(`::notice::既知の失敗が通るようになった（tests/known-failures.json から消す）: ${key}`);
for (const line of brokenFiles) console.log(`::error::試験のファイルを読み込めない: ${line}`);
for (const key of unexpected) console.log(`::error::新しい失敗: ${key}`);

console.log(`失敗 ${failed.size} 件（既知 ${failed.size - unexpected.length}・新しい ${unexpected.length}）、読み込めないファイル ${brokenFiles.length} 件、通るようになった既知 ${nowPassing.length} 件`);
process.exit(unexpected.length > 0 || brokenFiles.length > 0 ? 1 : 0);
