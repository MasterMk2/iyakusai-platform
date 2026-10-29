import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterAll, describe, expect, it } from 'vitest';
import { createShutdown, installSignalHandlers } from '../../src/server/lifecycle.js';
import { FileLoginPersistence, LoginService, LOW_COST_TEST_ONLY, PasswordHasher, type DeliveryAck } from '../../src/server/login/index.js';
import { CLIENT, makeLogin, P } from '../login-fixtures.js';

// Orderly shutdown with synthetic, injected DM work (no real messages, no service restarts):
// stop accepting -> drain the acknowledged DM dispatch -> flush the durable login state -> exit code.

const TMP = join('.tmp', 'api-lifecycle');
mkdirSync(TMP, { recursive: true });
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

interface Gate {
  release: () => void;
  wait: Promise<void>;
}
const gate = (): Gate => {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => (release = resolve));
  return { release, wait };
};

async function serverWithLogin(file: string) {
  const storePepper = randomBytes(32);
  const f = makeLogin({}, { stateStore: new FileLoginPersistence(file, storePepper), passwords: new PasswordHasher({ lowCostTestProfile: LOW_COST_TEST_ONLY }) });
  const app = Fastify({ logger: false });
  app.post('/request', async () => {
    const outcome = f.service.requestChallenge({ email: P.editorA.email, clientKey: CLIENT, purpose: 'password_setup' });
    return outcome.ok ? { challengeId: outcome.challengeId, browserSecret: outcome.browserSecret } : { error: outcome.error };
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  const url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  return { f, app, url, storePepper };
}

describe('orderly shutdown', () => {
  it('stops accepting, waits for the in-flight DM acknowledgement, flushes state and exits 0', async () => {
    const file = join(TMP, `drain-${randomBytes(4).toString('hex')}.json`);
    const { f, app, url, storePepper } = await serverWithLogin(file);
    const dm = gate();
    f.setDelivery(async (e): Promise<DeliveryAck> => {
      await dm.wait;
      return { deliveryId: e.deliveryId, status: 'delivered' };
    });
    const started = (await (await fetch(`${url}/request`, { method: 'POST' })).json()) as { challengeId: string; browserSecret: string };
    const logs: string[] = [];
    const shutdown = createShutdown({ app, account: { service: f.service } }, { timeoutMs: 5_000, log: (m) => logs.push(m) });
    let settled = false;
    const first = shutdown('SIGTERM');
    // Idempotent: a second request returns the same shutdown.
    expect(shutdown('SIGINT')).toBe(first);
    const done = first.then((code) => {
      settled = true;
      return code;
    });
    // The listener is closed while the DM is still pending.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(fetch(`${url}/request`, { method: 'POST' })).rejects.toThrow();
    expect(settled).toBe(false);
    dm.release();
    expect(await done).toBe(0);
    expect(logs.at(-1)).toBe('終了処理が完了しました。');

    // After a restart from the flushed file, the acknowledged code is usable exactly as before.
    const restarted = new LoginService({ ...f.options, stateStore: new FileLoginPersistence(file, storePepper) });
    const verify = await restarted.verifySetupCode({ challengeId: started.challengeId, browserSecret: started.browserSecret, code: f.sent.at(-1)!.code, clientKey: CLIENT });
    expect(verify.ok).toBe(true);
  });

  it('is bounded: an unacknowledged DM does not block exit and its code stays unusable after restart', async () => {
    const file = join(TMP, `timeout-${randomBytes(4).toString('hex')}.json`);
    const { f, app, url, storePepper } = await serverWithLogin(file);
    f.setDelivery(() => new Promise<DeliveryAck>(() => undefined));
    const started = (await (await fetch(`${url}/request`, { method: 'POST' })).json()) as { challengeId: string; browserSecret: string };
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(f.sent).toHaveLength(1);
    const logs: string[] = [];
    const t0 = Date.now();
    const code = await createShutdown({ app, account: { service: f.service } }, { timeoutMs: 300, log: (m) => logs.push(m) })('SIGTERM');
    expect(code).toBe(1);
    expect(Date.now() - t0).toBeLessThan(3_000);
    // Sanitized: fixed messages only, no email, path, code or error text.
    const text = logs.join('\n');
    for (const secret of [P.editorA.email, file, f.sent[0]!.code, TMP]) expect(text).not.toContain(secret);
    expect(text).toContain('未確認の DM コードは使えない');

    const restarted = new LoginService({ ...f.options, stateStore: new FileLoginPersistence(file, storePepper) });
    const verify = await restarted.verifySetupCode({ challengeId: started.challengeId, browserSecret: started.browserSecret, code: f.sent[0]!.code, clientKey: CLIENT });
    expect(verify.ok).toBe(false);
  });

  it('reports a failed final flush as exit 1 without details', async () => {
    let fail = false;
    const f = makeLogin({}, { stateStore: { kind: 'durable', load: () => null, save: () => {
      if (fail) throw new Error('disk full at /secret/path');
    } } });
    const app = Fastify({ logger: false });
    await app.ready();
    fail = true;
    const logs: string[] = [];
    expect(await createShutdown({ app, account: { service: f.service } }, { log: (m) => logs.push(m) })('SIGINT')).toBe(1);
    expect(logs.join('\n')).not.toContain('/secret/path');
    expect(logs.join('\n')).toContain('ログイン状態を保存できませんでした');
  });

  it('handles SIGTERM and SIGINT once, however often they arrive', async () => {
    const emitter = new EventEmitter();
    const calls: string[] = [];
    const exits: number[] = [];
    const finished = gate();
    installSignalHandlers(
      emitter,
      async (reason) => {
        calls.push(reason);
        return 0;
      },
      (code) => {
        exits.push(code);
        finished.release();
      },
    );
    emitter.emit('SIGTERM');
    emitter.emit('SIGINT');
    emitter.emit('SIGTERM');
    await finished.wait;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls).toEqual(['SIGTERM']);
    expect(exits).toEqual([0]);
  });
});
