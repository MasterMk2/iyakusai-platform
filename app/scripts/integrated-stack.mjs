// Loopback-only SYNTHETIC integration stack: the real Task service (discord-task-manager, protected
// mode) plus this app as the common Web entry with the signed Task gateway. Keys are generated per
// run into the git-ignored work directory; nothing is downloaded and no real account is contacted.
//
//   SMM_TASK_SERVICE_DIR=<path to a built discord-task-manager checkout> node scripts/integrated-stack.mjs [options]
//
// Options: --name <dir under .tmp>  --task-port <n>  --mail-port <n>  [--account-port <n>]
//          [--unavailable-port <n>]  [--fresh]
// --account-port also starts the account-login MOCK composition against the same Task service;
// --unavailable-port starts a demo instance whose Task gateway points at a closed port.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const name = opt('name', 'integrated');
if (!/^[a-z0-9-]{1,40}$/.test(name)) throw new Error('--name must be a short lower-case name');
const ports = { task: Number(opt('task-port', '17631')), mail: Number(opt('mail-port', '17632')) };
const accountPort = opt('account-port');
const unavailablePort = opt('unavailable-port');
const taskDir = process.env.SMM_TASK_SERVICE_DIR;
if (!taskDir || !existsSync(join(taskDir, 'dist', 'server', 'index.js'))) {
  console.error('SMM_TASK_SERVICE_DIR must name a built discord-task-manager checkout (npm run build there first).');
  process.exit(2);
}
const work = resolve('.tmp', name);
if (args.includes('--fresh')) rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

const keyFile = (file) => {
  const path = join(work, file);
  if (!existsSync(path)) writeFileSync(path, randomBytes(32).toString('base64url'), { mode: 0o600 });
  return path;
};
const gatewayKey = keyFile('task-gateway.key');
const bridgeKey = keyFile('discord-bridge.key');
const taskState = join(work, 'task-state.json');
if (!existsSync(taskState)) {
  const init = spawnSync(process.execPath, [join(taskDir, 'dist', 'server', 'tools', 'initSyntheticState.js'), taskState], { stdio: 'inherit' });
  if (init.status !== 0) process.exit(init.status ?? 1);
}

const children = [];
const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('SMM_') && !k.startsWith('DTM_') && k !== 'HOST' && k !== 'PORT'));
function start(label, script, cwd, env) {
  const child = spawn(process.execPath, [script], { cwd, env: { ...clean, ...env }, stdio: ['ignore', 'inherit', 'inherit'] });
  child.on('exit', (code) => {
    console.error(`integrated stack: ${label} exited (${code})`);
    shutdown(code ?? 1);
  });
  children.push(child);
}
function shutdown(code) {
  for (const c of children) if (c.exitCode === null) c.kill();
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

start('task service', join(taskDir, 'dist', 'server', 'index.js'), taskDir, {
  DTM_MODE: 'protected',
  HOST: '127.0.0.1',
  PORT: String(ports.task),
  DTM_DATA_FILE: taskState,
  DTM_TRUSTED_CLIENT_ADDRESSES: '127.0.0.1',
  DTM_GATEWAY_KEY_FILE: gatewayKey,
  DTM_DISCORD_BRIDGE_KEY_FILE: bridgeKey,
  DTM_DISCORD_BINDINGS_FILE: join(taskDir, 'deploy', 'discord-bindings.synthetic.json'),
});

const mailEnv = (port, extra) => ({
  SMM_PORT: String(port),
  SMM_DATA_FILE: join(work, `mail-${port}.json`),
  SMM_TASK_SERVICE_URL: `http://127.0.0.1:${ports.task}`,
  SMM_TASK_GATEWAY_KEY_FILE: gatewayKey,
  ...extra,
});
start('common web (demo personas)', 'dist/server/main.js', process.cwd(), mailEnv(ports.mail, {}));
if (accountPort) start('common web (account mock)', 'dist/server/main.js', process.cwd(), mailEnv(Number(accountPort), { SMM_AUTH_MODE: 'account-mock' }));
if (unavailablePort) {
  // A closed loopback port: the Task gateway is configured but the service never answers.
  start('common web (task service unavailable)', 'dist/server/main.js', process.cwd(), mailEnv(Number(unavailablePort), { SMM_TASK_SERVICE_URL: 'http://127.0.0.1:9' }));
}
console.log(`統合試用（合成データ・ループバックのみ）: 共通 Web http://127.0.0.1:${ports.mail}/${accountPort ? ` ／ 模擬ログイン構成 http://127.0.0.1:${accountPort}/` : ''}`);
console.log(`タスクサービス（保護モード・内部 API）: 127.0.0.1:${ports.task}。模擬 Discord 送信の鍵: .tmp/${name}/discord-bridge.key`);
