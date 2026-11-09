import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import type { SessionResponse, SessionUser } from '../../shared/api';
import type { TaskContextResponse } from '../../shared/tasks';
import { TASK_ROLE_LABELS } from '../../shared/tasks';
import { api, toFailure } from '../api';
import { useLoader } from '../useLoader';
import { AccessManagersPanel } from './AccessManagersPanel';
import { AdminPanel } from './AdminPanel';
import { DiscordAccountPanel } from './DiscordAccountPanel';
import { FeaturesPanel } from './FeaturesPanel';
import { LoadStatus } from './LoadStatus';
import { LoginActivityPanel } from './LoginActivityPanel';
import { MailAccessPanel } from './MailAccessPanel';
import { RentalAccessPanel } from './RentalAccessPanel';
import { RolloverPanel } from './rollover/RolloverPanel';
import { CardSettingsPanel } from './CardSettingsPanel';
import { AccountingAccessPanel } from './payments/AccountingAccessPanel';
import { BankPanel } from './bank/BankPanel';
import { Facts } from './books/common';
import { DayOfSettingsPanel } from './dayof/DayOfSettingsPanel';
import { storeTheme, THEME_LABELS, useTheme, type ThemeChoice } from '../theme';
import './payments/payments.css';

/**
 * The parts of the settings (2026-11-06), in the order of the list. One part is shown at a time, beside the list on a
 * PC and in place of it on a phone (../docs/ui-guidelines.md §6): before, every part was on one page, some 20,000px
 * long for an access administrator, with five lists of every member one after another.
 */
export const SETTINGS_SECTIONS = ['account', 'card', 'theme', 'managers', 'mail', 'line', 'accounting', 'rental', 'features', 'dayof', 'login', 'bank', 'rollover', 'directory'] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export function parseSettingsSection(value: string | undefined): SettingsSection | null {
  return SETTINGS_SECTIONS.find((section) => section === value) ?? null;
}

type Group = 'self' | 'grants' | 'ops';
const GROUPS: { key: Group; label: string }[] = [
  { key: 'self', label: '自分の設定' },
  { key: 'grants', label: '権限' },
  { key: 'ops', label: '委員会の運営' },
];

interface Part {
  key: SettingsSection;
  group: Group;
  label: string;
  body: ReactNode;
  /** Listed only once its panel has said it can be used (the bank: most members are not allowed to see it). */
  listedWhenKnown?: boolean;
}

const NARROW = '(max-width: 900px)';
function useNarrow(): boolean {
  const query = () => (typeof window.matchMedia === 'function' ? window.matchMedia(NARROW) : null);
  const [narrow, setNarrow] = useState(() => query()?.matches ?? false);
  useEffect(() => {
    const list = query();
    if (!list) return;
    const changed = () => setNarrow(list.matches);
    list.addEventListener('change', changed);
    return () => list.removeEventListener('change', changed);
  }, []);
  return narrow;
}

interface MockPerson {
  principalId: string;
  label: string;
  email: string;
  provenance: string;
  membership: string;
  active: boolean;
  dm: string;
}

const PROVENANCE: Record<string, string> = { direct: '直接', nested: '入れ子', organization: '全組織' };

/** Settings: the viewer's own account, card and colours, then (access administrators) the grants and the committee's settings. */
export function SettingsView({
  session,
  user,
  tasks,
  committeeMail = false,
  committeeLine = false,
  section = null,
  onSection = () => undefined,
  onChanged,
}: {
  session: SessionResponse;
  user: SessionUser;
  tasks: TaskContextResponse | null;
  /** The committee mailbox is configured: its edit grants replace the synthetic access screen. */
  committeeMail?: boolean;
  /** The committee's official LINE account is open here (2026-10-28): its grants below the mailbox's. */
  committeeLine?: boolean;
  /** The part opened (`#/settings/<section>`); none shows the first part on a PC and the list on a phone. */
  section?: SettingsSection | null;
  onSection?: (section: SettingsSection | null) => void;
  onChanged: () => void;
}) {
  const account = 'authMode' in session && session.authMode === 'account' ? session : null;
  const discord = 'authMode' in session && session.authMode === 'discord' ? session : null;
  const admin = user.canManageAccess;
  const narrow = useNarrow();

  // Every part stays mounted (hidden when not shown), so a choice not saved yet survives a look at another part, and
  // a part whose server has no such feature (its panel answers 404 or 403) says so and leaves the list.
  const [usable, setUsable] = useState<Partial<Record<SettingsSection, boolean>>>({});
  // One callback per part for the whole life of the screen (the panels report from an effect that depends on it).
  const [report] = useState(() => {
    const reporters: Partial<Record<SettingsSection, (ok: boolean) => void>> = {};
    return (key: SettingsSection) => (reporters[key] ??= (ok: boolean) => setUsable((u) => (u[key] === ok ? u : { ...u, [key]: ok })));
  });

  const parts: Part[] = [
    { key: 'account', group: 'self', label: 'アカウント', body: <AccountSection session={session} user={user} tasks={tasks} onChanged={onChanged} /> },
    // The card login messages and the card writer say 「設定 → 委員カード」: the same name here.
    ...(discord ? [{ key: 'card', group: 'self', label: '委員カード', body: <CardSettingsPanel admin={admin} onChanged={onChanged} /> } as Part] : []),
    { key: 'theme', group: 'self', label: '画面の色', body: <ThemeSection /> },
    ...(admin
      ? ([
          ...(discord ? [{ key: 'managers', group: 'grants', label: '権限設定者', body: <AccessManagersPanel onChanged={onChanged} onAvailable={report('managers')} /> } as Part] : []),
          {
            key: 'mail',
            group: 'grants',
            label: committeeMail ? 'メールの権限' : '受信箱の権限',
            body: committeeMail ? <MailAccessPanel /> : <AdminPanel user={user} onChanged={onChanged} demoControls={session.demoAuthentication === true} />,
          },
          ...(committeeMail && committeeLine ? [{ key: 'line', group: 'grants', label: '公式LINE の権限', body: <MailAccessPanel variant="line" /> } as Part] : []),
          { key: 'accounting', group: 'grants', label: '会計の権限', body: <AccountingAccessPanel onAvailable={report('accounting')} /> },
          { key: 'rental', group: 'grants', label: '物品の権限', body: <RentalAccessPanel onChanged={onChanged} onAvailable={report('rental')} /> },
          // Stopping a feature for a while (2026-11-09: rental); first of the committee's settings.
          { key: 'features', group: 'ops', label: '使う機能', body: <FeaturesPanel onChanged={onChanged} onAvailable={report('features')} /> },
          { key: 'dayof', group: 'ops', label: '当日の欄', body: <DayOfSettingsPanel onAvailable={report('dayof')} /> },
          ...(discord ? [{ key: 'login', group: 'ops', label: 'ログインの記録', body: <LoginActivityPanel /> } as Part] : []),
        ] as Part[])
      : []),
    // 権限管理者 and 会計を見る: the panel says which (its status answers 403 for everyone else).
    ...(discord && committeeMail ? [{ key: 'bank', group: 'ops', label: '銀行の連携', body: <BankPanel onAvailable={report('bank')} />, listedWhenKnown: !admin } as Part] : []),
    ...(admin ? [{ key: 'rollover', group: 'ops', label: '年度の切り替え', body: <RolloverPanel onAvailable={report('rollover')} /> } as Part] : []),
    ...(account?.composition === 'mock' ? [{ key: 'directory', group: 'ops', label: '模擬ディレクトリ', body: <MockDirectory onChanged={onChanged} /> } as Part] : []),
  ];
  const listed = parts.filter((p) => usable[p.key] !== false && (!p.listedWhenKnown || usable[p.key] === true));
  // A part this person may have but whose server has not answered yet is opened (its own loading shows), so a link
  // to it does not jump to the first part and back.
  const opened = section ? parts.find((p) => p.key === section && usable[p.key] !== false) : undefined;
  const shown: SettingsSection = opened?.key ?? 'account';
  // On a phone with nothing opened, the list is the screen and no part is the current one.
  const current = narrow && !section ? null : shown;

  const paneRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const chosen = useRef<{ to: SettingsSection | null; from: SettingsSection | null } | null>(null);
  useEffect(() => {
    const move = chosen.current;
    chosen.current = null;
    if (!move) return;
    if (move.to) {
      // The opened part starts at its top (the list may have been scrolled far down); on a phone the list is gone, so
      // the focus goes to the part instead of being lost with it.
      if (narrow) paneRef.current?.querySelector<HTMLElement>(`[data-section="${move.to}"]`)?.focus({ preventScroll: true });
      window.scrollTo({ top: 0 });
    } else if (move.from) {
      navRef.current?.querySelector<HTMLElement>(`[data-testid="settings-section-${move.from}"]`)?.focus();
    }
  }, [section, narrow]);

  // A link of the list carries its part (data-part); the way back to the list carries none.
  const select = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    const key = parseSettingsSection(event.currentTarget.dataset.part);
    if (key === section) return;
    chosen.current = { to: key, from: shown };
    onSection(key);
  };

  return (
    <main className={`main settings ${section ? 'has-section' : 'no-section'}`} aria-labelledby="settings-title">
      <h2 id="settings-title">設定</h2>
      <div className="settings-body">
        <nav ref={navRef} className="settings-nav" aria-label="設定の項目">
          {GROUPS.map((group) => {
            const items = listed.filter((p) => p.group === group.key);
            if (items.length === 0) return null;
            return (
              <div key={group.key} className="settings-nav-group">
                <p className="settings-nav-heading" id={`settings-group-${group.key}`}>
                  {group.label}
                </p>
                <ul aria-labelledby={`settings-group-${group.key}`}>
                  {items.map((p) => (
                    <li key={p.key}>
                      <a href={`#/settings/${p.key}`} aria-current={p.key === current ? 'page' : undefined} onClick={select} data-part={p.key} data-testid={`settings-section-${p.key}`}>
                        {p.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </nav>
        <div ref={paneRef} className="settings-pane">
          <a className="settings-back" href="#/settings" onClick={select}>
            ← 設定の一覧
          </a>
          {parts.map((p) => (
            <div key={p.key} className="settings-part" data-section={p.key} hidden={p.key !== shown} tabIndex={-1}>
              {p.body}
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}

function AccountSection({ session, user, tasks, onChanged }: { session: SessionResponse; user: SessionUser; tasks: TaskContextResponse | null; onChanged: () => void }) {
  const account = 'authMode' in session && session.authMode === 'account' ? session : null;
  const discord = 'authMode' in session && session.authMode === 'discord' ? session : null;
  const taskRoles = !tasks
    ? '確認中です。'
    : !tasks.enabled
      ? 'このサーバーではタスク機能が設定されていません。'
      : !tasks.bound
        ? 'このアカウントはタスク機能の利用者として登録されていません。'
        : tasks.memberships.length === 0
          ? 'どの部署にも入っていません。'
          : tasks.memberships.map((m) => `${m.workspace.name}：${TASK_ROLE_LABELS[m.role]}`).join('、');
  return (
    <section aria-labelledby="settings-account-title">
      <h3 id="settings-account-title">アカウント</h3>
      <Facts
        items={[
          ['名前', user.displayName],
          ['所属', discord?.account?.departments.length ? discord.account.departments.join('・') : user.roleLabel],
          ['ログインID', discord?.account?.initialLoginId ?? null],
          ['委員会タスク', taskRoles],
        ]}
      />
      {discord ? (
        <DiscordAccountPanel session={discord} onChanged={onChanged} />
      ) : account ? (
        <p className="hint">
          パスワードを変更するときは、ログアウトして「初回登録・パスワード再設定」から、連携済みの Discord に届く確認コードで再設定してください。再設定すると、ほかの端末のログインもすべて終了します。
        </p>
      ) : session.demoAuthentication ? (
        <p className="hint">デモ用モック認証です。ペルソナは画面上部で切り替えます。</p>
      ) : (
        <p className="hint">利用者はリバースプロキシの認証で識別しています。</p>
      )}
    </section>
  );
}

/** The colour theme for this browser (2026-10-28); a choice takes effect at once, with no save. The header's button changes the same choice. */
function ThemeSection() {
  const theme = useTheme();
  const choose = (next: ThemeChoice) => storeTheme(next);
  return (
    <section aria-labelledby="settings-theme-title">
      <h3 id="settings-theme-title">画面の色</h3>
      <fieldset className="theme-choice">
        <legend className="sr-only">画面の色</legend>
        {(Object.keys(THEME_LABELS) as ThemeChoice[]).map((key) => (
          <label key={key} className="status-option">
            <input type="radio" name="theme" value={key} checked={theme === key} onChange={() => choose(key)} />
            {THEME_LABELS[key]}
          </label>
        ))}
      </fieldset>
      <p className="hint">はじめは若葉です。画面上の名前の横のボタンでも、若葉・ライト・ダークを順に切り替えられます。この端末のこのブラウザーだけに保存します。</p>
    </section>
  );
}

function MockDirectory({ onChanged }: { onChanged: () => void }) {
  const [refresh, setRefresh] = useState(0);
  const load = useCallback(
    (signal: AbortSignal) => {
      void refresh;
      return api<{ notice: string; people: MockPerson[] }>('GET', '/api/mock/directory', undefined, signal);
    },
    [refresh],
  );
  const directory = useLoader(load);
  const [message, setMessage] = useState<string | null>(null);
  async function apply(principalId: string, action: string) {
    setMessage(null);
    try {
      const res = await api<{ revoked: { sessions: number } }>('POST', '/api/mock/directory', { principalId, action });
      setMessage(`模擬ディレクトリを変更しました（終了したセッション: ${res.revoked.sessions}）。`);
      setRefresh((n) => n + 1);
      onChanged();
    } catch (err) {
      setMessage(toFailure(err).message);
    }
  }
  return (
    <section className="admin" aria-label="模擬ディレクトリ" data-testid="mock-directory">
      <h3>模擬ディレクトリ（試用専用・合成データ）</h3>
      <p className="hint">会員資格の喪失・利用停止・Discord 連携の置き換えを模擬して、ログインとセッションへの反映を確認できます。本番構成にはこの画面と API はありません。</p>
      <LoadStatus loader={directory} what="模擬ディレクトリ" compact />
      {message && <p className="status info">{message}</p>}
      <table>
        <thead>
          <tr>
            <th>人物</th>
            <th>メール</th>
            <th>会員資格</th>
            <th>状態</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {(directory.data?.people ?? []).map((p) => (
            <tr key={p.principalId} data-mock-person={p.principalId}>
              <td>{p.label}</td>
              <td>{p.email}</td>
              <td>
                {PROVENANCE[p.provenance] ?? p.provenance}・{p.membership === 'member' ? '会員' : p.membership === 'removed' ? '喪失' : '未確定'}
              </td>
              <td>
                {p.active ? '有効' : '停止'}・DM {p.dm === 'open' ? '受信可' : '拒否'}
              </td>
              <td className="admin-actions">
                <button type="button" className="secondary" onClick={() => void apply(p.principalId, p.membership === 'member' ? 'remove_membership' : 'restore_membership')}>
                  {p.membership === 'member' ? '会員資格を外す' : '会員資格を戻す'}
                </button>
                <button type="button" className="secondary" onClick={() => void apply(p.principalId, p.active ? 'disable' : 'enable')}>
                  {p.active ? '利用停止' : '利用再開'}
                </button>
                <button type="button" className="secondary" onClick={() => void apply(p.principalId, 'replace_binding')}>
                  Discord 連携を置き換え
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
