import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NameRoster } from '../../src/server/discord-auth/names.js';
import { StateStore } from '../../src/server/domain/store.js';
import { buildApp } from '../../src/server/http/app.js';
import { CommitteeAddresses } from '../../src/server/mailbox/addresses.js';
import { MailboxStore } from '../../src/server/mailbox/store.js';
import { seedState, TEST_HOST, TEST_PORT } from '../helpers.js';
import { setup } from '../discord-auth/helpers.js';
import { ADM, COLLECTOR, CONTACT, OUTSIDE, PERSONAL, rawMail, SPONSOR, testMailboxConfig } from './helpers.js';

// The collector script (deploy/unified/gas/send_mail_to_app.gs) run as written, against stand-ins for the
// Apps Script services, and its requests replayed into the app's ingest route.

const SCRIPT = readFileSync(path.join(__dirname, '../../deploy/unified/gas/send_mail_to_app.gs'), 'utf8');

type Signed = number[];
const toSigned = (buf: Buffer): Signed => [...buf].map((b) => (b > 127 ? b - 256 : b));
const toBuffer = (bytes: Signed) => Buffer.from(bytes.map((b) => (b < 0 ? b + 256 : b)));

interface FakeMessage {
  id: string;
  date: Date;
  raw: Buffer;
  from: string;
  to: string;
  cc: string;
  subject: string;
  listId: string;
}

class FakeGmail {
  threads: FakeMessage[][] = [];

  add(thread: FakeMessage[]) {
    this.threads.push(thread);
  }

  search(query: string, start: number, max: number) {
    const after = Number(/after:(\d+)/.exec(query)?.[1] ?? 0);
    const before = Number(/before:(\d+)/.exec(query)?.[1] ?? Infinity);
    // Gmail: a thread matches when one of its messages does; newest activity first.
    const hits = this.threads
      .filter((t) => t.some((m) => m.date.getTime() / 1000 > after && m.date.getTime() / 1000 < before))
      .sort((a, b) => Math.max(...b.map((m) => m.date.getTime())) - Math.max(...a.map((m) => m.date.getTime())));
    return hits.slice(start, start + max).map((t) => ({
      getMessages: () =>
        [...t]
          .sort((a, b) => a.date.getTime() - b.date.getTime())
          .map((m) => ({ getId: () => m.id, getDate: () => m.date, isDraft: () => false, getRawContent: () => m.raw.toString('latin1'), getFrom: () => m.from, getTo: () => m.to, getCc: () => m.cc, getSubject: () => m.subject, getHeader: (name: string) => (name === 'List-Id' ? m.listId : '') })),
    }));
  }
}

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Buffer;
}

function loadScript(gmail: FakeGmail, props: Map<string, string>, respond: (req: Captured) => number) {
  const sent: Captured[] = [];
  const Utilities = {
    DigestAlgorithm: { SHA_256: 'sha256' },
    MacAlgorithm: { HMAC_SHA_256: 'hmac-sha256' },
    // Apps Script blobs of strings are UTF-8; raw mail here is 7-bit, so latin1 and UTF-8 agree.
    newBlob: (value: string) => ({ getBytes: () => toSigned(Buffer.from(value, 'utf8')) }),
    computeDigest: (_alg: string, bytes: Signed) => toSigned(createHash('sha256').update(toBuffer(bytes)).digest()),
    computeHmacSignature: (_alg: string, value: Signed, key: Signed) => toSigned(createHmac('sha256', toBuffer(key)).update(toBuffer(value)).digest()),
    getUuid: () => randomUUID(),
  };
  const PropertiesService = { getScriptProperties: () => ({ getProperty: (k: string) => props.get(k) ?? null, setProperty: (k: string, v: string) => void props.set(k, v) }) };
  const UrlFetchApp = {
    fetch: (url: string, o: { headers: Record<string, string>; payload: Signed | string }) => {
      const req = { url, headers: o.headers, body: typeof o.payload === 'string' ? Buffer.from(o.payload) : toBuffer(o.payload) };
      const code = respond(req);
      if (code === 200) sent.push(req);
      return { getResponseCode: () => code };
    },
  };
  const LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) };
  const Logger = { log: () => {} };
  const factory = new Function('Utilities', 'PropertiesService', 'UrlFetchApp', 'LockService', 'Logger', 'GmailApp', 'ScriptApp', `${SCRIPT}\nreturn { run, CONFIG };`);
  const api = factory(Utilities, PropertiesService, UrlFetchApp, LockService, Logger, gmail, {}) as { run: () => void; CONFIG: Record<string, unknown> };
  return { ...api, sent };
}

let dir: string;
let mail: MailboxStore;
let app: FastifyInstance;
let key: Buffer;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'iyakusai-mailbox-gas-'));
  writeFileSync(path.join(dir, 'names.json'), JSON.stringify({ version: 1, names: {} }));
  key = randomBytes(32);
  const config = testMailboxConfig(path.join(dir, 'mail'), {}, key);
  mail = new MailboxStore(config.dataDir);
  const ctx = setup();
  app = await buildApp({
    store: new StateStore({ ...(await seedState()), users: [], grants: [] }, null),
    listenPort: TEST_PORT,
    auth: { mode: 'discord', publicOrigin: 'https://app.example.invalid', publicHost: 'app.example.invalid', trustedProxies: new Set() },
    discord: { service: ctx.service, store: ctx.store, config: ctx.config, names: new NameRoster(path.join(dir, 'names.json')), publicOrigin: null, publicHost: null, trustedProxies: new Set() },
    mailbox: { store: mail, config, addresses: new CommitteeAddresses(config.mailboxes, config.domainAliases) },
  });
});
afterEach(async () => {
  await app.close();
  mail.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Replays captured requests into the app exactly as they were signed. */
async function deliver(requests: Captured[]) {
  const out: { status: number; json: { status: string; mailboxes: string[] } }[] = [];
  for (const r of requests) {
    const url = new URL(r.url);
    const headers = Object.fromEntries(Object.entries(r.headers).map(([k, v]) => [k.toLowerCase(), v]));
    const res = await app.inject({ method: 'POST', url: url.pathname + url.search, headers: { host: TEST_HOST, 'content-type': 'message/rfc822', ...headers }, payload: r.body });
    out.push({ status: res.statusCode, json: res.json() });
  }
  return out;
}

const message = (id: string, iso: string, o: { from?: string; to: string; cc?: string; subject?: string; listId?: string }): FakeMessage => ({
  id,
  date: new Date(iso),
  raw: rawMail({ messageId: `${id}@partner.example`, from: o.from ?? OUTSIDE, to: o.to, cc: o.cc, date: new Date(iso).toUTCString(), subject: o.subject ?? '合成テストの件名', ...(o.listId ? { listId: o.listId } : {}) }),
  from: o.from ?? OUTSIDE,
  to: o.to,
  cc: o.cc ?? '',
  subject: o.subject ?? '合成テストの件名',
  listId: o.listId ?? '',
});

describe('the collector script', () => {
  it('sends only committee mail from a member account, signed so the app accepts it', async () => {
    const gmail = new FakeGmail();
    gmail.add([message('a1', '2025-09-01T03:00:00Z', { to: SPONSOR, cc: PERSONAL }), message('a2', '2025-09-02T03:00:00Z', { from: `委員長 <${PERSONAL}>`, to: OUTSIDE, cc: SPONSOR })]);
    gmail.add([message('b1', '2026-01-10T03:00:00Z', { to: PERSONAL })]);
    gmail.add([message('c1', '2026-03-05T03:00:00Z', { to: `Contact@committee-alias.example` })]);
    gmail.add([message('d1', '2025-07-20T03:00:00Z', { to: ADM })]);
    // Through a group without the group in To/Cc (Bcc): List-Id, or the group's tag at the start of the subject.
    gmail.add([message('e1', '2026-04-01T03:00:00Z', { to: PERSONAL, listId: `<contact.committee.example>` })]);
    gmail.add([message('e2', '2026-04-02T03:00:00Z', { to: PERSONAL, subject: '[adm] [sps] 協賛のご案内' })]);
    gmail.add([message('e3', '2026-04-03T03:00:00Z', { to: PERSONAL, subject: 'Re: [sps] 私信' })]);
    const props = new Map([['INGEST_KEY', key.toString('hex')]]);
    const gas = loadScript(gmail, props, () => 200);
    Object.assign(gas.CONFIG, {
      SOURCE: 'backfill',
      ENDPOINT: 'https://app.example.invalid/v1/mail/ingest',
      COMMITTEE_ADDRESSES: [CONTACT, SPONSOR, ADM, COLLECTOR],
      COMMITTEE_SUBJECT_TAGS: ['cnt', 'sps', 'adm'],
      DOMAIN_ALIASES: { 'committee-alias.example': 'committee.example' },
    });
    gas.run();

    // Personal-only mail (b1, e3) and mail before the start date (d1) never leave the account.
    expect(gas.sent.map((r) => new URL(r.url).searchParams.get('id')).sort()).toEqual(['a1', 'a2', 'c1', 'e1', 'e2']);
    expect(props.get('sendBackfillDone')).toBe('true');
    const results = await deliver(gas.sent);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(results.map((r) => r.json.status)).toEqual(['stored', 'stored', 'stored', 'stored', 'stored']);
    expect(mail.ingestSummary()).toMatchObject({ messages: 5, sources: { backfill: 5 } });
    // A replayed request is refused.
    expect((await deliver(gas.sent.slice(0, 1)))[0]!.status).toBe(401);
  });

  it('resumes after a failed send without losing or repeating mail, then follows new mail', async () => {
    const gmail = new FakeGmail();
    for (let i = 0; i < 6; i++) gmail.add([message(`old${i}`, new Date(Date.parse('2026-09-01T00:00:00Z') + i * 86_400_000 * 3).toISOString(), { to: i % 2 ? CONTACT : OUTSIDE })]);
    const props = new Map([['INGEST_KEY', key.toString('hex')]]);
    let calls = 0;
    const gas = loadScript(gmail, props, () => (++calls === 3 ? 503 : 200));
    Object.assign(gas.CONFIG, { SOURCE: 'collector', ENDPOINT: 'https://app.example.invalid/v1/mail/ingest' });

    gas.run(); // first run: sets the starting point, then walks back through the account's own mail and stops at the failure
    expect(gas.sent).toHaveLength(2);
    gas.run(); // resumes the same day
    expect(props.get('sendBackfillDone')).toBe('true');

    const now = Date.now();
    gmail.add([message('new1', new Date(now + 60_000).toISOString(), { to: SPONSOR }), message('new2', new Date(now + 120_000).toISOString(), { to: SPONSOR })]);
    gas.run();
    gas.run(); // nothing new: nothing sent again

    const ids = gas.sent.map((r) => new URL(r.url).searchParams.get('id'));
    expect([...ids].sort()).toEqual(['new1', 'new2', 'old0', 'old1', 'old2', 'old3', 'old4', 'old5']);
    const results = await deliver(gas.sent);
    expect(results.every((r) => r.status === 200 && r.json.status === 'stored')).toBe(true);
    // Mail naming no committee address goes to the collector account's own mailbox.
    const byId = Object.fromEntries(ids.map((id, i) => [id, results[i]!.json.mailboxes]));
    expect(byId.old0).toEqual(['taro']);
    expect(byId.old1).toEqual(['contact']);
    expect(byId.new1).toEqual(['sponsorship', 'adm']);
  });
});
