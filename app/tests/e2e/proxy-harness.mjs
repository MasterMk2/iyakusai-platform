// TEST-ONLY local stand-in for an authenticated, TLS-terminating reverse proxy.
// It starts the built server in trusted-proxy mode on loopback and forwards
// browser requests to it the way the proposed proxy would:
//  - Host is overwritten with the public host; Origin of this harness is
//    presented as the public https origin (what the browser would send there);
//  - any client X-Mail-User, Authorization, Cookie and forwarded headers are dropped;
//  - the "authenticated" identity comes from the test-only X-Harness-User header,
//    standing in for the proxy's own login. No real credentials or network.
// Never use this as a deployment component.
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { createServer, request } from 'node:http';

const PORT = 5181;
const BACKEND_PORT = 5180;
const PUBLIC_ORIGIN = 'https://mail.example.invalid';
const PUBLIC_HOST = 'mail.example.invalid';
const SELF_ORIGIN = `http://127.0.0.1:${PORT}`;
const DATA_DIR = '.tmp/e2e-proxy';
const DROP = ['x-harness-user', 'x-mail-user', 'authorization', 'cookie', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip'];

rmSync(DATA_DIR, { recursive: true, force: true });
mkdirSync(DATA_DIR, { recursive: true });

const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('SMM_')));
const backend = spawn(process.execPath, ['dist/server/main.js'], {
  stdio: 'inherit',
  env: {
    ...env,
    SMM_AUTH_MODE: 'trusted-proxy',
    SMM_HOST: '127.0.0.1',
    SMM_PORT: String(BACKEND_PORT),
    SMM_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
    SMM_TRUSTED_PROXY_ADDRESSES: '127.0.0.1',
    SMM_USER_MAP_FILE: 'tests/e2e/proxy-user-map.json',
    SMM_DATA_FILE: `${DATA_DIR}/state.json`,
  },
});
backend.on('exit', (code) => {
  console.error(`proxy harness: backend exited (${code})`);
  process.exit(code ?? 1);
});
const stop = () => {
  backend.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
process.on('exit', () => backend.kill());

const server = createServer((req, res) => {
  const identity = req.headers['x-harness-user'];
  const headers = { ...req.headers };
  for (const name of DROP) delete headers[name];
  headers.host = PUBLIC_HOST;
  if (headers.origin === SELF_ORIGIN) headers.origin = PUBLIC_ORIGIN;
  if (typeof identity === 'string' && identity !== '') headers['x-mail-user'] = identity;
  const upstream = request({ host: '127.0.0.1', port: BACKEND_PORT, method: req.method, path: req.url, headers }, (up) => {
    res.writeHead(up.statusCode ?? 502, up.headers);
    up.pipe(res);
  });
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  req.pipe(upstream);
});
server.listen(PORT, '127.0.0.1');
