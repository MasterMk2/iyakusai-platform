import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { orgNameKey, type OrgInput } from '../../shared/organizations.js';
import { depositKey, normalizePayerName, tokyoDate } from '../../shared/payments.js';
import type { ContactInput } from '../../shared/contacts.js';
import { registerContactRoutes, type ContactRouteDeps } from '../contacts/routes.js';
import { ContactsStore } from '../contacts/store.js';
import { DomainError, type User } from '../domain/types.js';
import { registerOrganizationRoutes } from '../organizations/routes.js';
import { OrganizationsStore } from '../organizations/store.js';
import { accountingPermissionsOf, registerPaymentRoutes } from './routes.js';
import { PaymentsStore } from './store.js';

// The contacts, the organizations and the payments on synthetic data in the demo (SMM_AUTH_MODE=demo, 2026-11-03), so
// 連絡先 → 団体 → 会計 can be tried without the committee mailbox. The files sit next to the demo data file and start
// with synthetic rows (reserved .example addresses, made-up names). The persona chosen on the demo bar stands for the
// signed-in member; mail is off (no sending, no mail list). Opt-in: the app registers these only when the runtime
// hands it the stores, so the other demo builds (tests) are unchanged.

export interface DemoBooks {
  contacts: ContactsStore;
  organizations: OrganizationsStore;
  payments: PaymentsStore;
}

export interface DemoBooksDeps {
  requireUser: (request: FastifyRequest) => User;
  lookupUser: (userId: string) => User | undefined;
  listUsers: () => User[];
  clock: () => string;
  parse: <T>(schema: z.ZodType<T>, value: unknown) => T;
}

/** Opens the three files in `dir` and adds the synthetic rows to empty ones. Null when a file cannot be opened. */
export function openDemoBooks(dir: string, users: User[], now: string): DemoBooks | null {
  const opened: { close(): void }[] = [];
  try {
    const contacts = new ContactsStore(dir);
    opened.push(contacts);
    const organizations = new OrganizationsStore(dir);
    opened.push(organizations);
    const payments = new PaymentsStore(dir);
    opened.push(payments);
    const books = { contacts, organizations, payments };
    seedDemoBooks(books, users, now);
    return books;
  } catch {
    for (const store of opened) store.close();
    return null;
  }
}

export function registerDemoBooks(app: FastifyInstance, books: DemoBooks, deps: DemoBooksDeps): void {
  const now = () => Date.parse(deps.clock());
  const base: ContactRouteDeps = {
    requireUser: deps.requireUser,
    // The demo has no sign-in session: the persona on the demo bar stands for one.
    session: (request) => {
      const user = deps.requireUser(request);
      return { sessionKey: `demo:${user.id}`, passwordAt: now(), discordUserId: `demo:${user.id}` };
    },
    people: { lookup: deps.lookupUser, list: deps.listUsers },
    discordUserIdOf: (userId) => `demo:${userId}`,
    clock: deps.clock,
    parse: deps.parse,
  };
  const noMail = (): never => {
    throw new DomainError('forbidden', 'デモではメールを使えません。');
  };
  // The personas' role labels describe their mail access (編集者（請求）・閲覧者（営業）), not departments: for the
  // accounting each label is one name, so 部局ごと shows it whole instead of split at the '・'.
  const whole = (u: User): User => ({ ...u, roleLabel: u.roleLabel.replaceAll('・', '／') });
  registerContactRoutes(app, books.contacts, base);
  registerOrganizationRoutes(app, books.organizations, {
    ...base,
    contacts: books.contacts,
    sender: null,
    mailGate: noMail,
    mailPeek: noMail,
    mail: { listThreads: noMail },
    attachmentBytes: 0,
    now,
    paymentsVisible: (user) => accountingPermissionsOf(books.payments, whole(user)).includes('accounting.view'),
  });
  registerPaymentRoutes(app, books.payments, {
    ...base,
    requireUser: (request) => whole(deps.requireUser(request)),
    people: {
      lookup: (userId) => {
        const u = deps.lookupUser(userId);
        return u && whole(u);
      },
      list: () => deps.listUsers().map(whole),
    },
    organizations: books.organizations,
    contacts: books.contacts,
    now,
  });
  app.addHook('onClose', async () => {
    books.payments.close();
    books.organizations.close();
    books.contacts.close();
  });
}

const contact = (organization: string, name: string, nameKana: string, address: string): ContactInput => ({
  category: 'external',
  organization,
  section: '',
  name,
  nameKana,
  emails: [{ label: '', address }],
  phones: [],
  postalCode: '',
  address: '',
  tags: ['協賛'],
  notes: '',
});

/**
 * Synthetic rows for the demo, each store only when it is empty: two contacts, four organizations of this year, two
 * invoices, one statement (a full payment, a part of one, one less a transfer fee and interest), and the accounting
 * permissions of two personas (請求の編集担当 confirms, 閲覧担当 only views). Nothing is confirmed: that is for the demo.
 */
export function seedDemoBooks(books: DemoBooks, users: User[], now: string): void {
  const actor = users.find((u) => u.canManageAccess)?.id ?? users[0]?.id ?? 'system';
  const year = Number(tokyoDate(now).slice(0, 4));
  const day = (md: string) => `${year}-${md}`;
  let ichiro: string | null = null;
  if (books.contacts.count() === 0) {
    ichiro = books.contacts.create(contact('合成商事株式会社', '合成 一郎', 'ごうせい いちろう', 'ichiro@sponsor.example'), actor, now).id;
    books.contacts.create(contact('合成サークル「テスト」', '合成 花子', 'ごうせい はなこ', 'circle@club.example'), actor, now);
  }
  const ids = new Map<string, string>();
  if (books.organizations.page({ terms: [] }, 1, 0).total === 0) {
    const orgs: OrgInput[] = [
      { kind: 'sponsor', fiscalYear: year, name: '合成商事株式会社', department: '渉外課', ownerId: null, contactId: ichiro, status: '請求済み', amountYen: 300_000, content: '広告（大）', nextAction: '入金の確認', nextDue: day('11-15'), notes: '' },
      { kind: 'sponsor', fiscalYear: year, name: '合成食品工業', department: '渉外課', ownerId: null, contactId: null, status: '申込を受けた', amountYen: 100_000, content: '広告（中）', nextAction: '請求書を送る', nextDue: day('11-20'), notes: '' },
      { kind: 'exhibitor', fiscalYear: year, name: '合成サークル「テスト」', department: '企画部', ownerId: null, contactId: null, status: '請求済み', amountYen: 5_000, content: '', nextAction: '出展料の入金の確認', nextDue: day('10-31'), notes: '' },
      { kind: 'donor', fiscalYear: year, name: '合成後援会', department: '', ownerId: null, contactId: null, status: '未対応', amountYen: null, content: '', nextAction: '', nextDue: null, notes: '' },
    ];
    for (const data of orgs) ids.set(data.name, books.organizations.create(data, actor, now, 'imported').id);
  }
  const p = books.payments;
  if (ids.size > 0 && p.invoicesOfOrg(ids.get('合成商事株式会社')!).length === 0) {
    const invoice = (name: string, amountYen: number, issuedOn: string, dueOn: string, payerKana: string, token: string) =>
      p.createInvoice({ orgId: ids.get(name)!, number: '', amountYen, issuedOn, dueOn, payerKana, memo: '' }, { name, nameKey: orgNameKey(name), fiscalYear: year }, token, actor, now);
    invoice('合成商事株式会社', 300_000, day('10-20'), day('11-15'), 'ゴウセイシヨウジ', 'demo-invoice-000000001');
    invoice('合成サークル「テスト」', 5_000, day('10-01'), day('10-31'), 'ゴウセイサークル', 'demo-invoice-000000002');
    const rows = [
      { line: 2, bookedOn: day('09-30'), description: 'ﾘｿｸ', amountYen: 12, balanceYen: 897_940 },
      { line: 3, bookedOn: day('10-28'), description: 'ｺﾞｳｾｲｼﾖｸﾋﾝｺｳｷﾞﾖｳ', amountYen: 99_560, balanceYen: 997_500 },
      { line: 4, bookedOn: day('11-01'), description: 'ｺﾞｳｾｲｻ-ｸﾙ ﾃｽﾄ', amountYen: 2_500, balanceYen: 1_000_000 },
      { line: 5, bookedOn: day('11-02'), description: 'ﾌﾘｺﾐ ｺﾞｳｾｲｼﾖｳｼﾞ(ｶ', amountYen: 300_000, balanceYen: 1_300_000 },
    ];
    // The same form as an import keeps (NFKC), so importing the same rows again finds them as duplicates.
    const kept = rows.map((r) => ({ ...r, description: r.description.normalize('NFKC') }));
    p.addImport('合成の入出金明細（デモ）', kept.map((r) => ({ ...r, payerKey: normalizePayerName(r.description), dupKey: depositKey(r) })), actor, now);
  }
  if (p.accessRevision() === 0) {
    let revision = 0;
    const give = (userId: string, permission: 'accounting.view' | 'accounting.confirm') => {
      if (!users.some((u) => u.id === userId)) return;
      const next = p.setAccess(revision, { kind: 'user', id: userId }, permission, true, actor, now);
      if (next !== 'conflict') revision = next;
    };
    give('u-editor-c', 'accounting.confirm');
    give('u-viewer-b', 'accounting.view');
  }
}
