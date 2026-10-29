// TEST-ONLY (and the screen preview harness). A stateful fake of the app API with data at production scale:
// 18 committee mailboxes, about 60 mail threads, about 50 tasks in 3 parts / 6 sections, rental and Bot.
// Every name, address and text is synthetic.
import type { Page, Route } from '@playwright/test';
import type { HandlingStatus, ReceiptView, TriageView } from '../../src/shared/api.js';
import type { TaskStatus, TaskView } from '../../src/shared/tasks.js';
import { installBotFake } from './assistant-fake.js';

export const TODAY = '2026-10-25';
export const NOW = '2026-10-25T01:00:00Z'; // 10:00 JST

const MAILBOXES = [
  ['contact', '問い合わせ', 'contact'], ['sponsorship', '協賛', 'sponsorship'], ['pr', '広報', 'pr'], ['planning', '企画', 'planning'],
  ['venue', '会場', 'venue'], ['info', 'インフォメーション', 'info'], ['adm', 'adm（大学・業者・委員会全体の窓口）', 'adm'], ['agreement', '契約', 'agreement'],
  ['accounting', '会計', 'accounting'], ['goods', '物品', 'goods'], ['ml-goods', '物品 ML', 'ml-goods'], ['accounts', 'accounts', 'accounts'],
  ['common', 'サービス登録', 'common'], ['system', 'システム', 'system'], ['archive', '送信控え', 'archive'], ['everyone', '全体', 'everyone'],
  ['test', 'テスト', 'test'], ['iyakusai', '共用アカウント', 'iyakusai'],
].map(([id, name, local]) => ({ id: id!, name: name!, address: `${local}@committee.example` }));

const PEOPLE = [
  ['iy-000001', '合成 太郎'], ['iy-000002', '合成 花子'], ['iy-000003', '試験 一郎'], ['iy-000004', '見本 さくら'],
  ['iy-000005', '仮名 次郎'], ['iy-000006', '例示 美咲'], ['iy-000007', '架空 健太'], ['iy-000008', '模擬 結衣'],
].map(([id, displayName]) => ({ id: id!, displayName: displayName! }));

// The Task service knows people by its own IDs (production: discord-<Discord user ID>), not by the app's
// login IDs, so "my tasks" must come from /api/tasks/context (self), never from the session's user ID.
const TASK_PEOPLE = PEOPLE.map((p, i) => ({ id: `discord-90000000000000000${i + 1}`, displayName: p.displayName }));
const taskIdOf = (person: { displayName: string }) => TASK_PEOPLE.find((p) => p.displayName === person.displayName)!.id;

const DEPARTMENTS = [
  { id: 'dept-somu', name: '総務部', parent: null }, { id: 'dept-kaikei', name: '会計課', parent: 'dept-somu' }, { id: 'dept-system', name: 'システム課', parent: 'dept-somu' },
  { id: 'dept-naimu', name: '内務部', parent: null }, { id: 'dept-kikaku', name: '企画課', parent: 'dept-naimu' }, { id: 'dept-kaijo', name: '会場課', parent: 'dept-naimu' },
  { id: 'dept-gaimu', name: '外務部', parent: null }, { id: 'dept-shogai', name: '渉外課', parent: 'dept-gaimu' }, { id: 'dept-koho', name: '広報課', parent: 'dept-gaimu' },
  { id: 'dept-yakuin', name: '役員会', parent: null },
];
const deptKey = (id: string) => id.slice(5);
const deptName = (key: string) => DEPARTMENTS.find((d) => deptKey(d.id) === key)!.name;

const SENDERS = ['サンプル商事 営業部', '見本印刷 担当', '架空大学 学生支援課', 'サンプル協力団体', '例示ホール 予約係', '模擬運輸 配車担当', '試験薬局 店長', 'サンプル製薬 広報室', '仮想レンタル 受付', '見本信用金庫 法人窓口'];
const SUBJECTS = [
  '【御礼】医薬祭へのご協賛ありがとうございました', '協賛金の振込完了のご連絡', '領収書の宛名変更のお願い', '撤収時の備品返却について', '来年度の協賛継続についてのご相談',
  '施設使用報告書の提出期限について', 'パンフレット掲載広告の請求書送付', 'Re: 当日写真の共有方法', '機材レンタル料金のご請求', '落とし物のお問い合わせ（黒い折りたたみ傘）',
  'アンケート集計結果の共有', '【要返信】会場原状回復の確認日程', 'Re: Re: 搬出トラックの手配', 'ご寄付の受領証発行について', '来場者からのご意見（駐車場の案内）',
  'Googleアカウントのセキュリティ通知', '出展団体の精算書類の提出', '模擬店の衛生報告書', 'ステージ音響の延長料金', '次年度委員会への引継ぎ会議の日程',
];

function addDaysIso(day: string, n: number) { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

interface Thread { id: string; receipts: ReceiptView[]; }

function buildThreads(): Thread[] {
  const threads: Thread[] = [];
  const statuses: HandlingStatus[] = ['unhandled', 'unhandled', 'in_progress', 'on_hold', 'done', 'done', 'done'];
  const labelPool = ['協賛', '会計', '要返信', '物品', '大学', '広報', '引継ぎ'];
  for (let i = 0; i < 62; i++) {
    const box = MAILBOXES[(i * 7) % MAILBOXES.length]!;
    const second = i % 3 === 0 ? MAILBOXES.find((m) => m.id === 'adm')! : null;
    const mailboxes = second && second.id !== box.id ? [box, second] : [box];
    const count = i % 5 === 0 ? 3 : i % 4 === 0 ? 2 : 1;
    const subject = SUBJECTS[i % SUBJECTS.length]! + (i >= SUBJECTS.length ? (i >= SUBJECTS.length * 2 ? '（再送）' : '') : '');
    const status = i < 4 ? 'unhandled' : statuses[i % statuses.length]!;
    const assignee = status === 'unhandled' && i % 2 === 0 ? null : i % 3 === 0 ? PEOPLE[0]! : i % 3 === 1 ? PEOPLE[1]! : null;
    const labels = i % 4 === 3 ? [] : [labelPool[i % labelPool.length]!, ...(i % 6 === 0 ? ['要返信'] : [])].filter((v, k, a) => a.indexOf(v) === k);
    const threadId = `th_${String(i + 1).padStart(16, '0')}`;
    const receipts: ReceiptView[] = [];
    for (let r = 0; r < count; r++) {
      const minutes = i * 173 + (count - 1 - r) * 47;
      const at = new Date(Date.parse(NOW) - minutes * 60_000).toISOString();
      const sender = SENDERS[(i + r) % SENDERS.length]!;
      const triage: TriageView = { version: 1, status: r === 0 ? status : 'done', assignee: assignee ? { ...assignee, hasMailboxAccess: true } : null, labels };
      receipts.push({
        receiptId: `rc_${String(i + 1).padStart(10, '0')}${r}`, threadId, mailbox: box, mailboxes, access: 'edit', canEditAssignmentAndLabels: true, canEditStatus: true,
        receivedAt: at, subject: r === 0 ? subject : `Re: ${subject}`, from: { name: sender, address: `contact${(i + r) % 10}@partner.example` },
        to: [{ name: '医薬祭実行委員会', address: box.address }], cc: r === 1 ? [{ name: null, address: 'adm@committee.example' }] : [],
        text: `医薬祭実行委員会 ご担当者さま\n\nいつもお世話になっております。${sender}です。\n${subject.replace(/^(Re: )+/, '')}の件でご連絡いたしました。\n\n先日はありがとうございました。つきましては、下記の点についてご確認をお願いいたします。\n\n1. 日程：11月上旬\n2. 必要な書類：領収書・報告書\n3. ご不明点はこのメールにご返信ください。\n\nどうぞよろしくお願いいたします。\n${sender}`,
        hasHtml: false, sanitizedHtml: null, blockedRemoteResources: 0,
        attachments: i % 6 === 1 && r === 0 ? [{ id: 'at1', filename: '請求書_2026-10.pdf', contentType: 'application/pdf', size: 184_221 }] : [],
        triage,
        notes: i === 0 ? [{ id: 'n1', authorName: '合成 花子', createdAt: new Date(Date.parse(NOW) - 3_600_000).toISOString(), body: '先方には電話で一次回答済み。正式な回答はメールで送る。' }] : [],
        history: i === 0 ? [{ id: 'h1', at: new Date(Date.parse(NOW) - 7_200_000).toISOString(), actorName: '合成 花子', action: 'labels', from: null, to: labels.join(', ') }] : [],
      });
    }
    threads.push({ id: threadId, receipts });
  }
  return threads;
}

const TASK_TITLES = [
  ['協賛企業へのお礼状を送る', ['shogai']], ['協賛金の入金を台帳と照合する', ['kaikei', 'shogai']], ['会計報告書の下書きを作る', ['kaikei']], ['大学への施設使用報告書を提出する', ['somu']],
  ['物品の返却状況を確認する', ['kaijo']], ['破損物品の弁償額をまとめる', ['kaijo', 'kaikei']], ['出展団体の精算書類を回収する', ['kikaku']], ['当日写真をドライブに整理する', ['koho']],
  ['来場者アンケートを集計する', ['kikaku']], ['公式SNSで御礼投稿をする', ['koho']], ['次年度への引継ぎ資料をまとめる', ['yakuin']], ['委員会アカウントの権限を棚卸しする', ['system']],
  ['ステージ音響の延長料金を確認する', ['kikaku', 'kaikei']], ['落とし物の保管期限を案内する', ['somu']], ['会場の原状回復を確認する', ['kaijo']], ['パンフレット広告の請求書を発行する', ['shogai', 'kaikei']],
  ['寄付金の受領証を発行する', ['kaikei']], ['反省会の日程を調整する', ['yakuin']], ['臨時スタッフのアカウントを停止する', ['system']], ['備品購入の領収書を回収する', ['kaikei']],
  ['ポスター掲示の撤去を確認する', ['koho']], ['近隣への御礼を送付する', ['somu', 'shogai']], ['模擬店の衛生報告書を保健所へ提出する', ['kikaku']], ['駐車場案内の改善点をまとめる', ['kaijo']],
  ['協賛社ロゴの掲載期間を確認する', ['koho', 'shogai']], ['会計監査の資料を準備する', ['kaikei']], ['次年度予算の素案を作る', ['yakuin', 'kaikei']], ['Discordのチャンネルを整理する', ['system']],
];

function buildTasks(): TaskView[] {
  const tasks: TaskView[] = [];
  const statuses: TaskStatus[] = ['todo', 'in_progress', 'in_progress', 'blocked', 'todo', 'done'];
  const deadlines = [-3, -1, 0, 0, 1, 2, 4, 6, 9, 14, null, 21, null, -6];
  for (let i = 0; i < 52; i++) {
    const [title, tags] = TASK_TITLES[i % TASK_TITLES.length]! as [string, string[]];
    const d = deadlines[i % deadlines.length]!;
    const deadline = d === null ? null : addDaysIso(TODAY, d);
    const status = i < 3 ? (i === 2 ? 'blocked' : 'in_progress') : statuses[i % statuses.length]!;
    const assignee = i % 7 === 6 ? null : TASK_PEOPLE[i % 5 === 0 ? 0 : (i % TASK_PEOPLE.length)]!;
    const reqs = { purpose: i % 3 === 0 ? '' : '関係者への説明と記録を残すため。', deliverable: i % 4 === 1 ? '' : '提出済みの書類とその控え', completionCriteria: '担当者と役員が確認済みになっている。', openQuestions: i % 5 === 2 ? '提出先の担当者名が未確認' : '' };
    const missing = (['purpose', 'deliverable', 'completionCriteria', 'openQuestions'] as const).filter((f) => f !== 'openQuestions' && reqs[f] === '');
    const updated = new Date(Date.parse(NOW) - (i * 5 + 1) * 3_600_000).toISOString();
    tasks.push({
      id: `T-${String(101 + i)}`, workspaceId: `dept-${tags[0]}`, title: i >= TASK_TITLES.length ? `${title}（第${Math.floor(i / TASK_TITLES.length) + 1}回）` : title,
      description: '', assigneeId: assignee?.id ?? null, deadline, status, requirements: reqs, version: 1 + (i % 4),
      createdAt: new Date(Date.parse(NOW) - 20 * 86_400_000).toISOString(), createdBy: 'iy-000001', updatedAt: updated, updatedBy: assignee?.id ?? 'iy-000001',
      assignee: assignee ? { ...assignee, active: true } : null, overdue: deadline !== null && deadline < TODAY && status !== 'done',
      missingRequirements: [...missing], tags, tagLabels: tags.map(deptName),
    });
  }
  // A very long title, to see how rows truncate.
  tasks[5]!.title = '協賛企業30社へのお礼状と活動報告書（写真付き）を、担当ごとに宛名を確認したうえで郵送とメールの両方で送る';
  return tasks;
}

export interface WorldOptions {
  persona?: 'member' | 'officer';
  /** Opened with an empty mailbox list or empty tasks, for the empty states. */
  empty?: boolean;
  /** Slow every API answer by this many ms (loading states). */
  delayMs?: number;
  /** A server from before 2026-10-25: /api/tasks/context has no `self`. */
  oldServer?: boolean;
  /** A Task API before several departments at once: no part of a section (parentId) and no /api/tasks/all. */
  noParts?: boolean;
  /** Parent tasks (2026-10-25): every task has parentId, and two projects have children. */
  nested?: boolean;
  /** Helpers (2026-10-28): every task has helperIds, and a few have helpers (the member helps on T-104). */
  helping?: boolean;
}

// Projects in the nested world: 協賛企業へのお礼状 (渉外課) with three children, one of them done, and
// 施設使用報告書 (総務部) with one child that is also tagged 渉外課 (seen from 外務部 without its project).
const CHILDREN: Record<string, string> = { 'T-108': 'T-101', 'T-110': 'T-101', 'T-130': 'T-101', 'T-122': 'T-104' };

/** Why a task cannot go under a parent, as the Task API refuses it; null when it can. */
function parentRefusal(tasks: TaskView[], taskId: string | null, parentId: string | null): string | null {
  if (parentId === null) return null;
  const parent = tasks.find((t) => t.id === parentId);
  if (!parent || parent.parentId || parentId === taskId) return 'INVALID_PARENT';
  if (taskId && tasks.some((t) => t.parentId === taskId)) return 'INVALID_PARENT';
  return null;
}

/** helperIds and helpers of a task, from user IDs (the assignee among them dropped, as the Bot does). */
function withHelpers(ids: string[]): Pick<TaskView, 'helperIds' | 'helpers'> {
  const people = ids.map((id) => TASK_PEOPLE.find((p) => p.id === id)!);
  return { helperIds: people.map((p) => p.id), helpers: people.map((p) => ({ ...p, active: true })) };
}

/** The Bot's rule: helpers only with an assignee, and never the assignee. */
const badAssignees = (assigneeId: string | null, helperIds: string[]) => helperIds.length > 0 && (assigneeId === null || helperIds.includes(assigneeId));

export interface World { calls: string[]; threads: Thread[]; tasks: TaskView[] }

export async function installWorld(page: Page, options: WorldOptions = {}): Promise<World> {
  const officer = options.persona === 'officer';
  const me = officer ? PEOPLE[0]! : PEOPLE[1]!;
  const role = officer ? 'admin' : 'editor';
  const threads = options.empty ? [] : buildThreads();
  const tasks = options.empty ? [] : buildTasks();
  if (options.nested) for (const t of tasks) t.parentId = CHILDREN[t.id] ?? null;
  if (options.helping) {
    for (const t of tasks) Object.assign(t, withHelpers([]));
    const others = (t: TaskView) => TASK_PEOPLE.filter((p) => p.id !== t.assigneeId).map((p) => p.id);
    const helped = (id: string, pick: (ids: string[]) => string[]) => { const t = tasks.find((x) => x.id === id); if (t?.assigneeId) Object.assign(t, withHelpers(pick(others(t)))); };
    helped('T-101', (ids) => ids.slice(0, 3));
    helped('T-104', (ids) => [taskIdOf(me), ...ids.filter((x) => x !== taskIdOf(me)).slice(0, 1)]);
  }
  const calls: string[] = [];
  await page.clock.install({ time: new Date(NOW) });
  await installBotFake(page, { summary: { pendingCandidates: 3, reminders: { overdue: 1, today: 2, upcoming7d: 4 } } });

  const allReceipts = () => threads.flatMap((t) => t.receipts);
  const threadOf = (receiptId: string) => threads.find((t) => t.receipts.some((r) => r.receiptId === receiptId))!;
  const listItem = (t: Thread) => {
    const first = t.receipts[0]!, last = t.receipts[t.receipts.length - 1]!;
    return {
      source: 'email' as const, threadId: t.id, mailbox: first.mailbox, mailboxes: first.mailboxes, subject: first.subject, latestReceivedAt: last.receivedAt,
      receiptCount: t.receipts.length, matchCount: t.receipts.length, snippet: first.text.split('\n').slice(3, 5).join(' '),
      senders: [...new Set(t.receipts.map((r) => r.from.name ?? r.from.address))], statuses: [...new Set(t.receipts.map((r) => r.triage.status))],
      labels: [...new Set(t.receipts.flatMap((r) => r.triage.labels))], assignees: [...new Set(t.receipts.flatMap((r) => (r.triage.assignee ? [r.triage.assignee.displayName] : [])))], canSetStatus: true,
    };
  };
  const latest = (t: Thread) => t.receipts[t.receipts.length - 1]!.receivedAt;

  const handler = async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (path.startsWith('/api/assistant/')) return route.fallback();
    calls.push(`${method} ${path}${url.search}`);
    if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
    const respond = (json: unknown, status = 200) => route.fulfill({ status, json });
    const q = url.searchParams;

    if (path === '/api/session') return respond({ demoAuthentication: false, authMode: 'discord', user: { id: me.id, displayName: me.displayName, roleLabel: officer ? '委員長' : '委員', canManageAccess: officer }, account: { initialLoginId: me.id, studentId: '21000001', departments: [], signIn: { previousLoginAt: null, failedSince: 0 } }, degraded: false, passwordPolicy: { minLength: 12, maxLength: 128 }, sessionDays: 14 });
    if (path === '/api/mail/status') return respond({ enabled: true, canOpen: true, reauthRequired: false, idleHours: 12, unhandledTotal: threads.filter((t) => t.receipts.some((r) => r.triage.status === 'unhandled')).length });
    // Sending is not set up in this world (no reply or new-mail buttons).
    if (path === '/api/mail/send/options') return respond({ enabled: false, from: [], fromName: '', bcc: null, maxAttachmentBytes: 0, maxRecipients: 0, senderName: me.displayName });
    // Committee contacts (2026-10-26): the thread asks once which senders are contacts; none in this world.
    if (path === '/api/contacts/by-address') return respond([]);
    if (path === '/api/mailboxes') return respond(MAILBOXES.map((b) => {
      const mine = threads.filter((t) => t.receipts.some((r) => (r.mailboxes ?? [r.mailbox]).some((m) => m.id === b.id)));
      return { ...b, access: officer ? 'edit' : 'read', threadCount: mine.length, unhandledCount: mine.filter((t) => t.receipts.some((r) => r.triage.status === 'unhandled')).length };
    }));
    if (path === '/api/line/accounts') return respond([]);
    if (path === '/api/rental/me') return respond({ permissions: ['rental.loan'] });
    if (path === '/api/rental/summary') return respond({ total: 214, counts: { ready: 171, loaned: 31, review: 2 }, planned: 6, loanedByGroup: [
      { borrower: 'サンプル模擬店A（長い団体名の例：医薬祭を盛り上げる会 有志一同）', loaned: 12, since: '2026-10-16T05:00:00Z' }, { borrower: 'バンドサークル見本', loaned: 9, since: '2026-10-16T06:30:00Z' }, { borrower: '会場課（委員会）', loaned: 6, since: '2026-10-17T00:10:00Z' }, { borrower: '写真部サンプル', loaned: 4, since: '2026-10-17T01:00:00Z' },
    ], review: [{ code: 'IY-TENT-0007', name: 'テント 3.6m（脚1本曲がり）' }, { code: 'IY-EXT-0021', name: '延長コード 10m' }] });
    if (path === '/api/inbox/labels') return respond(['協賛', '会計', '要返信', '物品', '大学', '広報', '引継ぎ'].map((label) => ({ label, count: threads.filter((t) => t.receipts.some((r) => r.triage.labels.includes(label))).length })));
    if (path === '/api/inbox') {
      let list = [...threads].sort((a, b) => latest(b).localeCompare(latest(a)));
      const mb = q.get('mailboxId'); if (mb) list = list.filter((t) => t.receipts.some((r) => (r.mailboxes ?? [r.mailbox]).some((m) => m.id === mb)));
      const st = q.get('status'); if (st) list = list.filter((t) => t.receipts.some((r) => r.triage.status === st));
      const lb = q.get('label'); if (lb) list = list.filter((t) => t.receipts.some((r) => r.triage.labels.includes(lb)));
      const as = q.get('assignee'); if (as) list = list.filter((t) => t.receipts.some((r) => (as === 'none' ? r.triage.assignee === null : r.triage.assignee?.id === me.id)));
      const kw = q.get('q'); if (kw) list = list.filter((t) => t.receipts.some((r) => `${r.subject} ${r.from.name} ${r.text}`.includes(kw)));
      const page = Number(q.get('page') ?? 1), pageSize = Number(q.get('pageSize') ?? 5);
      return respond({ items: list.slice((page - 1) * pageSize, page * pageSize).map(listItem), total: list.length, page, pageSize, counts: { email: list.length, line: 0 }, lineEnabled: false });
    }
    let m = /^\/api\/threads\/([^/]+)$/.exec(path);
    if (m) { const t = threads.find((x) => x.id === m![1]); return t ? respond({ threadId: t.id, mailbox: t.receipts[0]!.mailbox, mailboxes: t.receipts[0]!.mailboxes, subject: t.receipts[0]!.subject, receipts: t.receipts }) : respond({ error: 'not_found', message: '見つかりません。' }, 404); }
    m = /^\/api\/threads\/([^/]+)\/status$/.exec(path);
    if (m && method === 'PATCH') {
      const t = threads.find((x) => x.id === m![1])!; const { status } = request.postDataJSON() as { status: HandlingStatus };
      let changed = 0; for (const r of t.receipts) if (r.triage.status !== status) { r.triage = { ...r.triage, status, version: r.triage.version + 1 }; changed++; }
      return respond({ threadId: t.id, statuses: [status], changed });
    }
    m = /^\/api\/receipts\/([^/]+)\/assignees$/.exec(path);
    if (m) return respond(PEOPLE.map(({ id, displayName }) => ({ id, displayName })));
    m = /^\/api\/receipts\/([^/]+)\/triage$/.exec(path);
    if (m && method === 'PATCH') {
      const r = allReceipts().find((x) => x.receiptId === m![1])!; const body = request.postDataJSON() as { expectedVersion: number; status?: HandlingStatus; assigneeId?: string | null; labels?: string[] };
      if (body.expectedVersion !== r.triage.version) return respond({ error: 'conflict', message: '他の委員が先に更新しました。', current: r.triage }, 409);
      const person = 'assigneeId' in body ? PEOPLE.find((p) => p.id === body.assigneeId) ?? null : undefined;
      r.triage = { ...r.triage, version: r.triage.version + 1, ...(body.status ? { status: body.status } : {}), ...(body.labels ? { labels: body.labels } : {}), ...(person !== undefined ? { assignee: person ? { ...person, hasMailboxAccess: true } : null } : {}) };
      r.history.push({ id: `h${Date.now()}`, at: new Date().toISOString(), actorName: me.displayName, action: body.labels ? 'labels' : 'assignee', from: null, to: body.labels?.join(', ') ?? person?.displayName ?? 'なし' });
      return respond(r.triage);
    }
    m = /^\/api\/receipts\/([^/]+)\/notes$/.exec(path);
    if (m && method === 'POST') { const r = allReceipts().find((x) => x.receiptId === m![1])!; const { body } = request.postDataJSON() as { body: string }; r.notes.push({ id: `n${Date.now()}`, authorName: me.displayName, createdAt: new Date().toISOString(), body }); return respond({ ok: true }, 201); }
    m = /^\/api\/cases\/mail\/([^/]+)\/tasks$/.exec(path);
    if (m) { const t = threadOf(m[1]!); const linked = t.id === threads[0]?.id ? [tasks[0]!] : []; return respond({ canCreate: true, tasks: linked.map((x) => ({ id: x.id, title: x.title, status: x.status, workspaceId: x.workspaceId })), pending: [], unavailable: false }); }

    const visible = officer ? DEPARTMENTS : DEPARTMENTS.filter((d) => ['dept-gaimu', 'dept-shogai', 'dept-koho'].includes(d.id));
    if (path === '/api/tasks/context') return respond({ enabled: true, bound: true, tagging: true, ...(options.oldServer ? {} : { self: taskIdOf(me) }), memberships: visible.map((d) => ({ workspace: { id: d.id, name: d.name, description: '', ...(options.noParts ? {} : { parentId: d.parent }) }, role })) });
    // Every task of the departments this person sees, in one read (2026-10-25).
    if (path === '/api/tasks/all' && method === 'GET' && !options.noParts) return respond(tasks.filter((t) => (t.tags ?? []).some((k) => visible.some((d) => deptKey(d.id) === k))));
    if (path === '/api/tasks/summary') {
      const open = tasks.filter((t) => t.status !== 'done');
      const bucket = (t: TaskView) => t.deadline === null ? 'none' : t.deadline < TODAY ? 'overdue' : t.deadline === TODAY ? 'today' : t.deadline === addDaysIso(TODAY, 1) ? 'tomorrow' : t.deadline <= addDaysIso(TODAY, 7) ? 'upcoming' : 'later';
      const deadlines = { overdue: 0, today: 0, tomorrow: 0, upcoming: 0, later: 0, none: 0 } as Record<string, number>;
      for (const t of open) deadlines[bucket(t)]!++;
      const inDept = (d: (typeof DEPARTMENTS)[number], t: TaskView) => (t.tags ?? []).some((k) => k === deptKey(d.id) || DEPARTMENTS.find((x) => deptKey(x.id) === k)?.parent === d.id);
      const dates = new Map<string, number>(); for (const t of open) if (t.deadline) dates.set(t.deadline, (dates.get(t.deadline) ?? 0) + 1);
      return respond({ today: TODAY, generatedAt: NOW, total: open.length, deadlines, departments: DEPARTMENTS.map((d) => { const l = open.filter((t) => inDept(d, t)); return { workspaceId: d.id, name: d.name, parentId: d.parent, remaining: l.length, overdue: l.filter((t) => t.deadline !== null && t.deadline < TODAY).length, today: l.filter((t) => t.deadline === TODAY).length }; }), byDate: [...dates].sort().map(([deadline, remaining]) => ({ deadline, remaining })) });
    }
    m = /^\/api\/tasks\/workspaces\/([^/]+)\/members$/.exec(path);
    if (m) return respond(TASK_PEOPLE.map((p) => ({ userId: p.id, displayName: p.displayName, role: 'editor', active: true })));
    m = /^\/api\/tasks\/workspaces\/([^/]+)\/tasks$/.exec(path);
    if (m && method === 'GET') {
      const d = DEPARTMENTS.find((x) => x.id === m![1])!;
      let list = tasks.filter((t) => (t.tags ?? []).some((k) => k === deptKey(d.id) || DEPARTMENTS.find((x) => deptKey(x.id) === k)?.parent === d.id));
      const as = q.get('assignee'); if (as) list = list.filter((t) => (as === 'none' ? t.assigneeId === null : t.assigneeId === as || (t.helperIds ?? []).includes(as)));
      const dl = q.get('deadline'); if (dl) list = list.filter((t) => (dl === 'overdue' ? t.overdue : dl === 'set' ? t.deadline !== null : t.deadline === null));
      const st = q.get('status'); if (st) list = list.filter((t) => t.status === st);
      return respond(list);
    }
    if (m && method === 'POST') {
      const body = request.postDataJSON() as { title: string; assigneeId: string | null; deadline: string | null; tags?: string[]; parentId?: string; helperIds?: string[]; requirements: TaskView['requirements'] };
      if (body.helperIds !== undefined && (!options.helping || badAssignees(body.assigneeId, body.helperIds))) return respond({ error: options.helping ? 'invalid_assignees' : 'validation', message: '操作を反映できませんでした。' }, 400);
      if (body.parentId !== undefined && (!options.nested || parentRefusal(tasks, null, body.parentId))) return respond({ error: 'invalid_parent', message: '操作を反映できませんでした。' }, 400);
      const assignee = TASK_PEOPLE.find((p) => p.id === body.assigneeId) ?? null;
      const t: TaskView = { ...tasks[0]!, ...(options.nested ? { parentId: body.parentId ?? null } : {}), ...(options.helping ? withHelpers(body.helperIds ?? []) : {}), id: `T-${100 + tasks.length + 1}`, workspaceId: m[1]!, title: body.title, assigneeId: assignee?.id ?? null, assignee: assignee ? { ...assignee, active: true } : null, deadline: body.deadline, status: 'todo', version: 1, requirements: body.requirements, tags: body.tags ?? [], tagLabels: (body.tags ?? []).map(deptName), overdue: false, missingRequirements: [], updatedAt: new Date().toISOString() };
      tasks.unshift(t); return respond({ task: t, replayed: false }, 201);
    }
    m = /^\/api\/tasks\/([^/]+)\/history$/.exec(path);
    if (m) { const t = tasks.find((x) => x.id === m![1]); return respond(t ? [{ id: 'h1', version: 1, action: 'created', actorName: '合成 太郎', at: t.createdAt, source: 'discord', displayChanges: [{ field: 'title', before: null, after: t.title }] }, ...(t.version > 1 ? [{ id: 'h2', version: t.version, action: 'updated', actorName: t.assignee?.displayName ?? '合成 太郎', at: t.updatedAt, source: 'web', displayChanges: [{ field: 'status', before: '未着手', after: '進行中' }] }] : [])].reverse() : []); }
    m = /^\/api\/tasks\/([^/]+)\/reopen$/.exec(path);
    if (m && method === 'POST') { const i = tasks.findIndex((x) => x.id === m![1]); if (!officer) return respond({ error: 'forbidden', message: '再開できるのは役員だけです。' }, 403); tasks[i] = { ...tasks[i]!, status: 'todo', version: tasks[i]!.version + 1 }; return respond({ task: tasks[i], replayed: false }); }
    m = /^\/api\/tasks\/([^/]+)$/.exec(path);
    if (m && method === 'GET') { const t = tasks.find((x) => x.id === m![1]); return t ? respond({ task: t, provenance: t.id === tasks[0]?.id && threads[0] ? [{ kind: 'mail', label: threads[0].receipts[0]!.subject, href: `#/all?thread=${threads[0].id}` }] : [] }) : respond({ error: 'not_found', message: '見つかりません。' }, 404); }
    if (m && method === 'PATCH') {
      const i = tasks.findIndex((x) => x.id === m![1]); const body = request.postDataJSON() as { expectedVersion: number; changes: Record<string, unknown> };
      if (body.expectedVersion !== tasks[i]!.version) return respond({ error: 'version_conflict', message: '他の委員が更新しました。' }, 409);
      const c = body.changes; const requirements = { ...tasks[i]!.requirements };
      if ('parentId' in c && (!options.nested || parentRefusal(tasks, tasks[i]!.id, c.parentId as string | null))) return respond({ error: 'invalid_parent', message: '操作を反映できませんでした。' }, 400);
      for (const f of ['purpose', 'deliverable', 'completionCriteria', 'openQuestions'] as const) if (typeof c[f] === 'string') requirements[f] = (c[f] as string).trim();
      const assignee = 'assigneeId' in c ? TASK_PEOPLE.find((p) => p.id === c.assigneeId) ?? null : undefined;
      let helping: Pick<TaskView, 'helperIds' | 'helpers'> = {};
      if (tasks[i]!.helperIds) {
        const assigneeId = assignee !== undefined ? assignee?.id ?? null : tasks[i]!.assigneeId;
        // A helper made the assignee leaves the helpers (unless the helpers are sent too).
        const ids = (c.helperIds as string[] | undefined) ?? tasks[i]!.helperIds!.filter((h) => h !== assigneeId);
        if (badAssignees(assigneeId, ids)) return respond({ error: 'invalid_assignees', message: '操作を反映できませんでした。' }, 400);
        helping = withHelpers(ids);
      } else if ('helperIds' in c) return respond({ error: 'validation', message: '操作を反映できませんでした。' }, 400);
      const next: TaskView = { ...tasks[i]!, ...(typeof c.title === 'string' ? { title: c.title.trim() } : {}), ...(c.status ? { status: c.status as TaskStatus } : {}), ...('deadline' in c ? { deadline: c.deadline as string | null } : {}), ...(assignee !== undefined ? { assigneeId: assignee?.id ?? null, assignee: assignee ? { ...assignee, active: true } : null } : {}), ...(Array.isArray(c.tags) ? { tags: c.tags as string[], tagLabels: (c.tags as string[]).map(deptName) } : {}), ...('parentId' in c ? { parentId: c.parentId as string | null } : {}), ...helping, requirements, version: tasks[i]!.version + 1, updatedAt: new Date().toISOString() };
      next.overdue = next.deadline !== null && next.deadline < TODAY && next.status !== 'done';
      next.missingRequirements = (['purpose', 'deliverable', 'completionCriteria'] as const).filter((f) => next.requirements[f] === '');
      tasks[i] = next; return respond({ task: next, replayed: false });
    }
    calls.push(`UNHANDLED ${method} ${path}`);
    return respond({ error: 'not_found', message: 'preview: not handled' }, 404);
  };
  await page.route('**/api/**', handler);
  return { calls, threads, tasks };
}
