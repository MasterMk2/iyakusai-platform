/** Local, synthetic-only browser verification server. Never included in server runtime. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildApp } from '../src/server/http/app.js';
import { StateStore } from '../src/server/domain/store.js';
import { NameRoster } from '../src/server/discord-auth/names.js';
import { CHAIR, MEMBER, PASSWORD, register, setup } from '../tests/discord-auth/helpers.js';
import { seedState } from '../tests/helpers.js';

const ctx = setup();
ctx.clock.now = Date.now();
const admin = await register(ctx, CHAIR, '21110001');
const member = await register(ctx, MEMBER, '21110002');
const card = await ctx.service.issueLoginCard(admin.sessionToken, member.initialLoginId, '合成 太郎の委員カード');
await ctx.service.activateLoginCard(admin.sessionToken, card.id);
mkdirSync('verification', { recursive: true });
writeFileSync('verification/synthetic-names.json', JSON.stringify({ version: 1, names: { [MEMBER]: '合成 太郎', [CHAIR]: '合成 管理者' } }));
const seed = await seedState();
const port = 18749;
const app = await buildApp({ store: new StateStore({ ...seed, users: [], grants: [] }, null), listenPort: port, staticDir: resolve('dist/client'),
  auth: { mode: 'discord', publicOrigin: 'https://app.example.invalid', publicHost: 'app.example.invalid', trustedProxies: new Set() },
  discord: { service: ctx.service, store: ctx.store, config: ctx.config, names: new NameRoster(resolve('verification/synthetic-names.json')), audit: ctx.audit, publicOrigin: null, publicHost: null, trustedProxies: new Set() },
});
app.get('/api/card-demo/tap', async () => ({ url: `http://127.0.0.1:${port}/card#${card.secret}`, password: PASSWORD }));
await app.listen({ host: '127.0.0.1', port });
console.log('Synthetic card demo listening on 127.0.0.1:' + port);
