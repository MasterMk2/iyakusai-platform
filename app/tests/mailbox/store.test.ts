import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommitteeAddresses } from '../../src/server/mailbox/addresses.js';
import { validateMailboxConfig } from '../../src/server/mailbox/config.js';
import { routeMailboxes } from '../../src/server/mailbox/ingest.js';
import { MailParseError, parseRawMail } from '../../src/server/mailbox/parse.js';
import { MailboxStore, threadIdFor } from '../../src/server/mailbox/store.js';
import { ADM, ALIAS_DOMAIN, COLLECTOR, CONTACT, DOMAIN, OUTSIDE, PERSONAL, rawMail, SPONSOR, testMailboxConfig } from './helpers.js';

let dir: string;
let store: MailboxStore;
const NOW = '2026-10-13T01:00:00.000Z';

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'iyakusai-mailbox-'));
  store = new MailboxStore(path.join(dir, 'mail'));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function put(raw: Buffer, mailboxIds: string[], o: { source?: 'collector' | 'backfill'; id?: string; at?: string } = {}) {
  return store.store({ source: o.source ?? 'collector', providerId: o.id ?? Math.random().toString(16).slice(2), receivedAt: o.at ?? NOW, parsed: await parseRawMail(raw), mailboxIds, now: NOW });
}

describe('parsing raw mail', () => {
  it('decodes ISO-2022-JP subjects and bodies, addresses, references and List-Id', async () => {
    const parsed = await parseRawMail(
      rawMail({
        messageId: 'm1@partner.example',
        // "テスト" in JIS: ESC $ B %F%9%H ESC ( B
        subjectJis: '\x1b$B%F%9%H\x1b(B',
        textJis: '\x1b$B%F%9%H\x1b(B\r\n',
        to: `"協賛窓口" <${SPONSOR}>, ${PERSONAL}`,
        cc: CONTACT.toUpperCase(),
        references: ['root@partner.example', 'parent@partner.example'],
        inReplyTo: 'parent@partner.example',
        listId: `"協賛" <sponsorship.${DOMAIN}>`,
        deliveredTo: COLLECTOR,
      }),
    );
    expect(parsed.subject).toBe('テスト');
    expect(parsed.text.trim()).toBe('テスト');
    expect(parsed.messageId).toBe('m1@partner.example');
    expect(parsed.to).toEqual([{ name: '協賛窓口', address: SPONSOR }, { name: null, address: PERSONAL }]);
    expect(parsed.cc).toEqual([{ name: null, address: CONTACT }]);
    expect(parsed.references).toEqual(['root@partner.example', 'parent@partner.example']);
    expect(parsed.inReplyTo).toBe('parent@partner.example');
    expect(parsed.listIds).toEqual([`"協賛" <sponsorship.${DOMAIN}>`]);
    expect(parsed.deliveredTo).toEqual([COLLECTOR]);
  });

  it('keeps attachments as bytes with their decoded file names, and refuses empty input', async () => {
    const pdf = Buffer.from('%PDF-1.4 synthetic');
    const parsed = await parseRawMail(rawMail({ attachments: [{ filename: '見積書.pdf', contentType: 'application/pdf', content: pdf }] }));
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]).toMatchObject({ filename: '見積書.pdf', contentType: 'application/pdf' });
    expect(parsed.attachments[0]!.content.equals(pdf)).toBe(true);
    await expect(parseRawMail(Buffer.alloc(0))).rejects.toBeInstanceOf(MailParseError);
  });

  it('reads HTML-only mail as text for search and the text view', async () => {
    const raw = Buffer.from(['From: a@partner.example', 'To: ' + CONTACT, 'Subject: html', 'Message-ID: <h@partner.example>', 'Content-Type: text/html; charset=UTF-8', '', '<p>本文<b>太字</b></p><script>x()</script>', ''].join('\r\n'));
    const parsed = await parseRawMail(raw);
    expect(parsed.html).toContain('<b>');
    expect(parsed.text).toContain('本文太字');
    expect(parsed.text).not.toContain('x()');
  });
});

describe('committee addresses', () => {
  const config = testMailboxConfig('unused');
  const addresses = new CommitteeAddresses(config.mailboxes, config.domainAliases);

  it('matches the other domain, upper case and +tags; never personal addresses', () => {
    expect(addresses.ofAddress(`Sponsorship@${ALIAS_DOMAIN}`)?.id).toBe('sponsorship');
    expect(addresses.ofAddress(`contact+managers@${DOMAIN}`)?.id).toBe('contact');
    expect(addresses.ofAddress(PERSONAL)).toBeUndefined();
    expect(addresses.ofAddress('contact@partner.example')).toBeUndefined();
    expect(addresses.ofListId(`<adm.${ALIAS_DOMAIN}>`)?.id).toBe('adm');
  });

  it('routes collector mail by address, group or forwarding, and the rest to the collector mailbox', async () => {
    const route = async (o: Parameters<typeof rawMail>[0], source: 'collector' | 'backfill' = 'collector', cfg = config) =>
      routeMailboxes(addresses, cfg, source, await parseRawMail(rawMail(o))).map((m) => m.id);
    expect(await route({ to: SPONSOR, cc: ADM, deliveredTo: COLLECTOR })).toEqual(['sponsorship', 'adm']);
    // Forwarded: sponsorship@ mail shows in adm@ too.
    expect(await route({ to: SPONSOR, deliveredTo: COLLECTOR })).toEqual(['sponsorship', 'adm']);
    // The group tags at the start of the subject name the groups it came through.
    expect(await route({ to: OUTSIDE, subject: '[adm] [sps] ご案内', deliveredTo: COLLECTOR })).toEqual(['sponsorship', 'adm']);
    expect(await route({ to: OUTSIDE, subject: '[cnt] お問い合わせ' })).toEqual(['contact']);
    // Tags are compared without case and may hold dots (e.g. [ac.MW], [IT]).
    const dotted = testMailboxConfig('unused', { mailboxes: [{ id: 'acc', name: '会計', address: 'accounting@committee.example', subjectTag: 'ac.MW' }, { id: 'taro', name: '共用', address: COLLECTOR, catchAll: true }] });
    expect(routeMailboxes(new CommitteeAddresses(dotted.mailboxes, {}), dotted, 'collector', await parseRawMail(rawMail({ to: OUTSIDE, subject: '[AC.mw] ご請求' }))).map((m) => m.id)).toEqual(['acc']);
    // Bcc to a group: only List-Id names it.
    expect(await route({ to: OUTSIDE, listId: `<contact.${DOMAIN}>`, deliveredTo: COLLECTOR })).toEqual(['contact']);
    // Addressed to nobody listed (e.g. Bcc straight to the collector account).
    expect(await route({ to: OUTSIDE, deliveredTo: COLLECTOR })).toEqual(['taro']);
    expect(await route({ to: COLLECTOR, cc: CONTACT })).toEqual(['contact', 'taro']);
    // Past mail from one member's account: a committee address, or delivery through a committee group.
    expect(await route({ to: PERSONAL }, 'backfill')).toEqual([]);
    expect(await route({ to: SPONSOR, cc: PERSONAL }, 'backfill')).toEqual(['sponsorship', 'adm']);
    expect(await route({ from: `<${ADM}>`, to: OUTSIDE }, 'backfill')).toEqual(['adm']);
    expect(await route({ to: PERSONAL, listId: `<contact.${DOMAIN}>` }, 'backfill')).toEqual(['contact']);
    expect(await route({ to: PERSONAL, subject: '[adm] [sps] ご協賛について' }, 'backfill')).toEqual(['sponsorship', 'adm']);
    // A tag left behind a "Re:" is not proof of delivery through the group.
    expect(await route({ to: PERSONAL, subject: 'Re: [sps] ご協賛について' }, 'backfill')).toEqual([]);
    const toCcFromOnly = testMailboxConfig('unused', { backfillUseGroupDelivery: false });
    expect(await route({ to: PERSONAL, listId: `<contact.${DOMAIN}>` }, 'backfill', toCcFromOnly)).toEqual([]);
  });

  it('accepts the example configuration in deploy/unified', () => {
    const example = JSON.parse(readFileSync(path.join(__dirname, '../../deploy/unified/mailbox.example.json'), 'utf8')) as Record<string, unknown>;
    const config = validateMailboxConfig(example, '.', Buffer.alloc(32, 7));
    expect(config.mailboxes.filter((m) => m.catchAll).map((m) => m.id)).toEqual(['taro']);
    expect(config.idleHours).toBe(12);
    expect(config.draftBccAddress).toBe(`archive@${DOMAIN}`);
  });

  it('reads the mail-draft BCC address only when it is a lowercase address', () => {
    expect(testMailboxConfig('unused').draftBccAddress).toBeNull();
    expect(testMailboxConfig('unused', { draftBccAddress: `archive@${DOMAIN}` }).draftBccAddress).toBe(`archive@${DOMAIN}`);
    expect(() => testMailboxConfig('unused', { draftBccAddress: 'Archive@x' })).toThrow(/draftBccAddress/);
    expect(() => testMailboxConfig('unused', { draftBccAddress: 1 })).toThrow(/draftBccAddress/);
  });

  it('refuses configurations that would be ambiguous', () => {
    const base = { version: 1, mailboxes: [{ id: 'a', name: 'A', address: `a@${DOMAIN}`, catchAll: true }] as Record<string, unknown>[] };
    const key = Buffer.alloc(32, 7);
    expect(() => validateMailboxConfig({ ...base, mailboxes: [...base.mailboxes, { id: 'a', name: 'B', address: `b@${DOMAIN}` }] }, '.', key)).toThrow(/id/);
    expect(() => validateMailboxConfig({ ...base, mailboxes: [{ ...base.mailboxes[0], catchAll: false }] }, '.', key)).toThrow(/catchAll/);
    expect(() => validateMailboxConfig({ ...base, mailboxes: [{ ...base.mailboxes[0], address: `A+x@${DOMAIN}` }] }, '.', key)).toThrow(/address/);
    expect(() => validateMailboxConfig({ ...base, extra: true }, '.', key)).toThrow(/不明な項目/);
    expect(() => validateMailboxConfig({ ...base, mailboxes: [{ ...base.mailboxes[0], forwardsTo: ['nowhere'] }] }, '.', key)).toThrow(/forwardsTo/);
    expect(() => validateMailboxConfig({ ...base, mailboxes: [{ ...base.mailboxes[0], forwardsTo: ['a'] }] }, '.', key)).toThrow(/forwardsTo/);
    expect(() =>
      validateMailboxConfig({ ...base, mailboxes: [{ ...base.mailboxes[0], subjectTag: 'x' }, { id: 'b', name: 'B', address: `b@${DOMAIN}`, subjectTag: 'x' }] }, '.', key),
    ).toThrow(/subjectTag/);
  });
});

describe('the mailbox store', () => {
  it('stores a message once, links it to more mailboxes later, and is idempotent per source message', async () => {
    const raw = rawMail({ messageId: 'same@partner.example', to: SPONSOR });
    const first = await put(raw, ['sponsorship'], { source: 'collector', id: 'g1' });
    expect(first.status).toBe('stored');
    expect((await put(raw, ['sponsorship'], { source: 'collector', id: 'g1' })).status).toBe('duplicate');
    const again = await put(raw, ['adm'], { source: 'backfill', id: 'n1' });
    expect(again).toEqual({ status: 'linked', id: first.id });
    expect(store.links([first.id]).get(first.id)?.sort()).toEqual(['adm', 'sponsorship']);
    expect(store.ingestSummary()).toMatchObject({ messages: 1, sources: { collector: 1, backfill: 1 } });
  });

  it('threads replies by References and In-Reply-To in any arrival order', async () => {
    // The reply with only In-Reply-To arrives before its parent, which arrives before the root.
    const reply = await put(rawMail({ messageId: 'c@x.example', inReplyTo: 'b@x.example' }), ['contact']);
    const parent = await put(rawMail({ messageId: 'b@x.example', inReplyTo: 'a@x.example', references: ['a@x.example'] }), ['contact']);
    const root = await put(rawMail({ messageId: 'a@x.example' }), ['contact']);
    const thread = threadIdFor('a@x.example');
    for (const r of [reply, parent, root]) expect(store.message(r.id)?.thread_id).toBe(thread);
    const other = await put(rawMail({ messageId: 'z@x.example' }), ['contact']);
    expect(store.message(other.id)?.thread_id).not.toBe(thread);
  });

  it('keeps each attachment once on disk and checks it when read', async () => {
    const content = Buffer.from('synthetic attachment body');
    const a = await put(rawMail({ attachments: [{ filename: 'a.txt', contentType: 'text/plain', content }] }), ['contact']);
    const b = await put(rawMail({ attachments: [{ filename: 'b.txt', contentType: 'text/plain', content }] }), ['contact']);
    const [rowA] = store.attachments(a.id);
    const [rowB] = store.attachments(b.id);
    expect(rowA!.sha256).toBe(rowB!.sha256);
    expect(store.attachmentFiles()).toHaveLength(1);
    expect(store.readAttachment(rowA!).equals(content)).toBe(true);
    const file = path.join(dir, 'mail', store.attachmentFiles()[0]!.relative);
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file).equals(content)).toBe(true);
  });

  it('rejects a stale handling update and records history', async () => {
    const { id } = await put(rawMail({}), ['contact']);
    expect(store.updateTriage(id, 1, { status: 'in_progress', assigneeId: null, labels: ['見積'] }, [{ action: 'status', from: '未対応', to: '対応中' }], 'iy-00000001', NOW)).toBe(true);
    expect(store.updateTriage(id, 1, { status: 'done', assigneeId: null, labels: [] }, [], 'iy-00000001', NOW)).toBe(false);
    expect(store.message(id)).toMatchObject({ status: 'in_progress', version: 2, labels_json: '["見積"]' });
    expect(store.history(id)).toHaveLength(1);
  });

  it('accepts a nonce once and records mail use per session', () => {
    expect(store.acceptNonce('d'.repeat(64), 2000, 1000)).toBe(true);
    expect(store.acceptNonce('d'.repeat(64), 2000, 1500)).toBe(false);
    expect(store.acceptNonce('d'.repeat(64), 4000, 2500)).toBe(true);
    store.recordUse('s1', 10_000, 0);
    expect(store.lastUse('s1')).toBe(10_000);
    store.recordUse('s2', 20_000, 15_000);
    expect(store.lastUse('s1')).toBeNull();
  });

  it('reopens the same file and refuses a different schema version', () => {
    store.close();
    store = new MailboxStore(path.join(dir, 'mail'));
    store.db.prepare("UPDATE meta SET value='999' WHERE key='schema'").run();
    store.close();
    expect(() => new MailboxStore(path.join(dir, 'mail'))).toThrow();
    store = { close() {} } as unknown as MailboxStore;
  });
});
