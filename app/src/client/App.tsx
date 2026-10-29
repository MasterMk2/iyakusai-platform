import { useCallback, useEffect, useState } from 'react';
import type { MailboxSummary, SessionResponse } from '../shared/api';
import type { LineAccountSummary } from '../shared/line';
import type { MailSendOptions, MailStatusResponse } from '../shared/mailbox';
import type { TaskContextResponse } from '../shared/tasks';
import { api, ApiFailure } from './api';
import { AccountBar } from './components/AccountBar';
import { AccountLogin } from './components/AccountLogin';
import { AdminPanel } from './components/AdminPanel';
import { GlobalNav, Masthead, type NavItem, type NavKey } from './components/AppShell';
import { DemoBar } from './components/DemoBar';
import { DiscordBar } from './components/DiscordBar';
import { DiscordLogin } from './components/DiscordLogin';
import { HomeView } from './components/HomeView';
import { LoadStatus } from './components/LoadStatus';
import { LineConversation } from './components/LineConversation';
import { MailCompose, newDraft } from './components/MailCompose';
import { MailReauth } from './components/MailReauth';
import { Login } from './components/Login';
import { ProxyBar } from './components/ProxyBar';
import { SessionUnavailableBar } from './components/SessionUnavailableBar';
import { SettingsView } from './components/SettingsView';
import { TasksView, type TaskFocus } from './components/tasks/TasksView';
import { BotView, parseBotSection, type BotSection } from './components/bot/BotView';
import { ContactsView, type ContactPrefill } from './components/contacts/ContactsView';
import { ThreadDetail } from './components/ThreadDetail';
import { ThreadList, type InboxFilter } from './components/ThreadList';
import type { BotReplyRequest, DraftToSend } from '../shared/mailHandoff';
import { useLoader } from './useLoader';

const PROXY_ERRORS = new Set(['untrusted_proxy', 'unauthenticated', 'invalid_identity', 'unknown_identity']);

export interface Route {
  view: 'home' | 'mail' | 'admin' | 'tasks' | 'bot' | 'settings' | 'contacts';
  mailboxId: string | null;
  lineAccountId: string | null;
  /** Selected email thread (`thread=`) or LINE conversation (`conv=`); at most one is set. */
  threadId: string | null;
  conversationId: string | null;
  /** Tasks view: committee (`ws=`), selected task (`task=`) or the create form (`new=1`). */
  taskWorkspaceId: string | null;
  taskId: string | null;
  taskNew: boolean;
  taskRemaining: boolean;
  /** Tasks view opened from a home count (`focus=`): that filter is set when the list opens. */
  taskFocus: TaskFocus | null;
  /** Inbox opened from a home count (`filter=`): unhandled items or the viewer's own. */
  inboxFilter: InboxFilter | null;
  /** Committee mailbox: writing new mail (`compose=1`) instead of a thread. */
  mailCompose: boolean;
  /** Bot tab: the sub-view (`#/bot/<section>`) and an opened job (`?job=`). */
  botSection: BotSection | null;
  botJobId: string | null;
  /** Contacts (inside the mailbox tab): an opened contact (`c=`), the add form (`new=1`) or the import (`import=1`). */
  contactId: string | null;
  contactNew: boolean;
  contactImport: boolean;
}

const EMPTY_ROUTE: Route = {
  view: 'mail',
  mailboxId: null,
  lineAccountId: null,
  threadId: null,
  conversationId: null,
  taskWorkspaceId: null,
  taskId: null,
  taskNew: false,
  taskRemaining: false,
  taskFocus: null,
  inboxFilter: null,
  mailCompose: false,
  botSection: null,
  botJobId: null,
  contactId: null,
  contactNew: false,
  contactImport: false,
};

function parseFocus(value: string | null): TaskFocus | null {
  return value === 'overdue' || value === 'today' || value === 'mine' ? value : null;
}

export function parseHash(hash: string): Route {
  const [path = '', query = ''] = hash.replace(/^#/, '').split('?');
  const params = new URLSearchParams(query);
  const threadId = params.get('thread');
  const conversationId = threadId ? null : params.get('conv');
  const parts = path.split('/').filter(Boolean);
  const filter = params.get('filter');
  const inboxFilter: InboxFilter | null = filter === 'unhandled' || filter === 'mine' ? filter : null;
  if (parts[0] === 'home') return { ...EMPTY_ROUTE, view: 'home' };
  if (parts[0] === 'admin') return { ...EMPTY_ROUTE, view: 'admin' };
  if (parts[0] === 'settings') return { ...EMPTY_ROUTE, view: 'settings' };
  if (parts[0] === 'contacts') {
    const contactId = params.get('c');
    return { ...EMPTY_ROUTE, view: 'contacts', contactId: contactId && /^ct_[0-9a-f]{16}$/.test(contactId) ? contactId : null, contactNew: params.get('new') === '1', contactImport: params.get('import') === '1' };
  }
  if (parts[0] === 'bot') return { ...EMPTY_ROUTE, view: 'bot', botSection: parseBotSection(parts[1]), botJobId: params.get('job') };
  if (parts[0] === 'tasks') {
    return { ...EMPTY_ROUTE, view: 'tasks', taskWorkspaceId: params.get('ws'), taskId: params.get('task'), taskNew: params.get('new') === '1', taskRemaining: params.get('remaining') === '1', taskFocus: parseFocus(params.get('focus')) };
  }
  const mailCompose = !threadId && !conversationId && params.get('compose') === '1';
  if (parts[0] === 'mailbox' && parts[1]) return { ...EMPTY_ROUTE, mailboxId: decodeURIComponent(parts[1]), threadId, conversationId, inboxFilter, mailCompose };
  if (parts[0] === 'line' && parts[1]) return { ...EMPTY_ROUTE, lineAccountId: decodeURIComponent(parts[1]), threadId, conversationId, inboxFilter };
  return { ...EMPTY_ROUTE, threadId, conversationId, inboxFilter, mailCompose };
}

export function toHash(route: Route): string {
  if (route.view === 'home') return '#/home';
  if (route.view === 'admin') return '#/admin';
  if (route.view === 'settings') return '#/settings';
  if (route.view === 'contacts') {
    const q = new URLSearchParams();
    if (route.contactId) q.set('c', route.contactId);
    else if (route.contactNew) q.set('new', '1');
    else if (route.contactImport) q.set('import', '1');
    return q.size > 0 ? `#/contacts?${q.toString()}` : '#/contacts';
  }
  if (route.view === 'bot') {
    const base = `#/bot/${route.botSection ?? 'ask'}`;
    return route.botJobId ? `${base}?job=${encodeURIComponent(route.botJobId)}` : base;
  }
  if (route.view === 'tasks') {
    const q = new URLSearchParams();
    if (route.taskWorkspaceId) q.set('ws', route.taskWorkspaceId);
    if (route.taskId) q.set('task', route.taskId);
    if (route.taskNew) q.set('new', '1');
    if (route.taskRemaining) q.set('remaining', '1');
    if (route.taskFocus) q.set('focus', route.taskFocus);
    return q.size > 0 ? `#/tasks?${q.toString()}` : '#/tasks';
  }
  const base = route.mailboxId
    ? `#/mailbox/${encodeURIComponent(route.mailboxId)}`
    : route.lineAccountId
      ? `#/line/${encodeURIComponent(route.lineAccountId)}`
      : '#/all';
  const q = new URLSearchParams();
  if (route.threadId) q.set('thread', route.threadId);
  else if (route.conversationId) q.set('conv', route.conversationId);
  else if (route.mailCompose && !route.lineAccountId) q.set('compose', '1');
  if (route.inboxFilter) q.set('filter', route.inboxFilter);
  return q.size > 0 ? `${base}?${q.toString()}` : base;
}

function useHashRoute(): [Route, (r: Route) => void] {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = () => {
      const next = parseHash(window.location.hash);
      setRoute((prev) => (toHash(prev) === toHash(next) ? prev : next));
    };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  // Apply the route in the same update as the click; waiting for the async
  // hashchange would remount the list after the user may already be typing.
  const navigate = useCallback((r: Route) => {
    const hash = toHash(r);
    window.location.hash = hash;
    setRoute(parseHash(hash));
  }, []);
  return [route, navigate];
}

/** Answer of GET /api/rental/me (only the part this screen uses). */
interface RentalMe {
  permissions: string[];
}

/** Set by the rental phone screen before it sends a signed-out person to this screen. */
const RENTAL_RETURN_KEY = 'iyakusai-return';
const RENTAL_RETURN_PATH = /^\/(rental\/?|i\/IY-[A-Z0-9-]+)$/;

export function App() {
  const [route, navigate] = useHashRoute();
  const [refresh, setRefresh] = useState(0);
  const bump = useCallback(() => setRefresh((n) => n + 1), []);

  const loadSession = useCallback(
    (signal: AbortSignal) => {
      void refresh;
      return api<SessionResponse>('GET', '/api/session', undefined, signal);
    },
    [refresh],
  );
  const session = useLoader(loadSession);
  const user = session.data?.user ?? null;
  // Mock authentication is shown only when the session explicitly confirms demo mode. Trusted-proxy
  // mode is known from the session or a proxy rejection; anything else (loading, 5xx, network) is unknown.
  const demoMode = session.data?.demoAuthentication === true;
  const accountSession = session.data && 'authMode' in session.data && session.data.authMode === 'account' ? session.data : null;
  const discordSession = session.data && 'authMode' in session.data && session.data.authMode === 'discord' ? session.data : null;
  const proxyMode = !accountSession && !discordSession && (session.data ? session.data.demoAuthentication === false : PROXY_ERRORS.has(session.error?.body?.error ?? ''));
  // Discord login (the committee's real login) puts the signed-in user into the common header; the
  // test and demo modes keep their own bar under a plain header.
  const bar = demoMode ? (
    <>
      <Masthead />
      <DemoBar user={user} onChanged={bump} />
    </>
  ) : discordSession ? (
    <DiscordBar
      session={discordSession}
      onLoggedOut={() => {
        navigate(EMPTY_ROUTE);
        bump();
      }}
      onOpenSettings={() => navigate({ ...EMPTY_ROUTE, view: 'settings' })}
    />
  ) : accountSession ? (
    <>
      <Masthead />
      <AccountBar
        session={accountSession}
        onLoggedOut={() => {
          navigate(EMPTY_ROUTE);
          bump();
        }}
      />
    </>
  ) : proxyMode ? (
    <>
      <Masthead />
      <ProxyBar user={user} />
    </>
  ) : (
    <>
      <Masthead />
      <SessionUnavailableBar />
    </>
  );

  // Task gateway status for the signed-in user (one request; gates the per-case task panels).
  const loadTaskContext = useCallback(
    (signal: AbortSignal) => {
      void refresh;
      return user ? api<TaskContextResponse>('GET', '/api/tasks/context', undefined, signal) : Promise.resolve(null);
    },
    [refresh, user],
  );
  const taskContext = useLoader(loadTaskContext);
  const caseTasks = !!taskContext.data?.enabled && !!taskContext.data.bound;

  // Rental permissions of the signed-in account: the 物品 entry appears only when the account holds one.
  // Not configured (404), not signed in (401) and no permission all mean no entry.
  const loadRental = useCallback(
    (signal: AbortSignal) => {
      void refresh;
      return user ? api<RentalMe>('GET', '/api/rental/me', undefined, signal).catch(() => null) : Promise.resolve(null);
    },
    [refresh, user],
  );
  const rental = useLoader(loadRental);
  const rentalEntry = (rental.data?.permissions.length ?? 0) > 0;

  // Coming back from the rental screen: after signing in, return to the item that was being read.
  useEffect(() => {
    if (!user) return;
    let target: string | null;
    try {
      target = sessionStorage.getItem(RENTAL_RETURN_KEY);
      sessionStorage.removeItem(RENTAL_RETURN_KEY);
    } catch {
      return;
    }
    if (target && RENTAL_RETURN_PATH.test(target)) window.location.assign(target);
  }, [user]);

  // Committee mailbox (Discord login with the mail store): whether it exists here, whether this account may
  // open it yet, and whether this device must type the password again. 404: the synthetic inbox instead.
  const loadMailStatus = useCallback(
    (signal: AbortSignal) => {
      void refresh;
      if (!user || !discordSession) return Promise.resolve(null);
      return api<MailStatusResponse>('GET', '/api/mail/status', undefined, signal).catch((err: unknown) => {
        if (err instanceof ApiFailure && err.status === 404) return null;
        throw err;
      });
    },
    [refresh, user, discordSession],
  );
  const mailStatus = useLoader(loadMailStatus);
  const committeeMail = mailStatus.data?.enabled === true ? mailStatus.data : null;
  const mailLocked = !!committeeMail && committeeMail.canOpen && committeeMail.reauthRequired;
  // Until the first answer, the kind of inbox is unknown: nothing about mail is loaded or decided yet.
  const mailStatusSettled = !discordSession || !mailStatus.loading || mailStatus.data !== null;

  const loadMailboxes = useCallback(
    (signal: AbortSignal) => {
      void refresh;
      if (!user || !mailStatusSettled) return Promise.resolve([]);
      // Everyone in the committee reads the committee mailbox; the synthetic inbox keeps administrators out of mail.
      if (committeeMail) return committeeMail.canOpen && !committeeMail.reauthRequired ? api<MailboxSummary[]>('GET', '/api/mailboxes', undefined, signal) : Promise.resolve([]);
      return !user.canManageAccess ? api<MailboxSummary[]>('GET', '/api/mailboxes', undefined, signal) : Promise.resolve([]);
    },
    [refresh, user, committeeMail, mailStatusSettled],
  );
  const mailboxes = useLoader(loadMailboxes);

  // Sending from the committee mailbox: the From addresses this person holds a send grant for. Asked once,
  // when the mailbox or the Bot's mail screen is on screen (the other screens never need it).
  const sendScreen = route.view === 'mail' || route.view === 'contacts' || (route.view === 'bot' && route.botSection === 'mail');
  const mailOpen = !!committeeMail && committeeMail.canOpen && !committeeMail.reauthRequired && sendScreen;
  const loadSendOptions = useCallback(
    (signal: AbortSignal) => (mailOpen ? api<MailSendOptions>('GET', '/api/mail/send/options', undefined, signal).catch(() => null) : Promise.resolve(null)),
    [mailOpen],
  );
  const sendOptions = useLoader(loadSendOptions).data;
  const canSendMail = !!sendOptions?.enabled && sendOptions.from.length > 0;
  // The mailbox and the Bot's mail drafts hand each other a message to answer / a draft to send (memory only).
  const [botReplyRequest, setBotReplyRequest] = useState<BotReplyRequest | null>(null);
  const [draftToSend, setDraftToSend] = useState<DraftToSend | null>(null);
  const clearBotReplyRequest = useCallback(() => setBotReplyRequest(null), []);
  const clearDraftToSend = useCallback(() => setDraftToSend(null), []);
  // Contacts <-> mail (memory only): a sender to add as a contact, and a recipient to write new mail to.
  // The search typed on home is handed over the same way (never in the address bar, so not in the history).
  // Each is forgotten as soon as its screen is left, so it never fills a later form.
  const [contactPrefill, setContactPrefill] = useState<ContactPrefill | null>(null);
  const [composeTo, setComposeTo] = useState<string | null>(null);
  const [contactQuery, setContactQuery] = useState('');
  const clearContactPrefill = useCallback(() => setContactPrefill(null), []);
  const [handoffScreen, setHandoffScreen] = useState({ compose: route.mailCompose, contactNew: route.contactNew, contacts: route.view === 'contacts' });
  if (handoffScreen.compose !== route.mailCompose || handoffScreen.contactNew !== route.contactNew || handoffScreen.contacts !== (route.view === 'contacts')) {
    setHandoffScreen({ compose: route.mailCompose, contactNew: route.contactNew, contacts: route.view === 'contacts' });
    if (!route.mailCompose) setComposeTo(null);
    if (!route.contactNew) setContactPrefill(null);
    if (route.view !== 'contacts') setContactQuery('');
  }

  // LINE accounts the user may read. 404 means LINE is not enabled on this server.
  // The committee's official LINE (2026-10-28) opens with its mailbox and, like it, to administrators too.
  const lineOpen = committeeMail ? committeeMail.canOpen && !committeeMail.reauthRequired : !!user && !user.canManageAccess;
  const loadLineAccounts = useCallback(
    (signal: AbortSignal) => {
      void refresh;
      if (!user || !mailStatusSettled || !lineOpen) return Promise.resolve([] as LineAccountSummary[]);
      return api<LineAccountSummary[]>('GET', '/api/line/accounts', undefined, signal).catch((err: unknown) => {
        if (err instanceof ApiFailure && err.status === 404) return [] as LineAccountSummary[];
        throw err;
      });
    },
    [refresh, user, mailStatusSettled, lineOpen],
  );
  const lineAccounts = useLoader(loadLineAccounts);

  // The unified app hides the inbox until a mailbox or LINE account is connected, and opens on the home
  // screen (an empty address, or the inbox address while there is no inbox).
  const inboxCount = (mailboxes.data?.length ?? 0) + (lineAccounts.data?.length ?? 0);
  const inboxEntry = !discordSession || (committeeMail ? committeeMail.canOpen : inboxCount > 0);
  const inboxKnown = mailStatusSettled && mailboxes.data !== null && lineAccounts.data !== null;
  const landing = /^#?\/?$/.test(window.location.hash);
  useEffect(() => {
    if (user && discordSession && route.view === 'mail' && landing) navigate({ ...EMPTY_ROUTE, view: 'home' });
  }, [user, discordSession, landing, route.view, navigate]);
  // Tabs are never hidden (a tab that comes and goes is confusing): an inbox that cannot be used says why.
  const inboxProblem =
    !discordSession || !inboxKnown
      ? null
      : committeeMail
        ? committeeMail.canOpen
          ? null
          : '受信箱はまだ公開前です（いまは試行中の委員だけが使えます）。公開されるまでお待ちください。'
        : inboxCount === 0
          ? 'このサーバーには、あなたが見られる受信箱がありません。'
          : null;

  useEffect(() => {
    const names: Record<Route['view'], string> = { home: 'ホーム', tasks: 'タスク', bot: 'Bot', mail: 'メール', admin: '設定', settings: '設定', contacts: '連絡先' };
    document.title = user ? `${names[route.view]}｜医薬祭 委員会アプリ` : '医薬祭 委員会アプリ';
  }, [route.view, user]);

  if (!session.data) {
    return (
      <div className="app">
        {bar}
        <main className="center">
          <LoadStatus loader={session} what="セッション" />
        </main>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="app">
        {bar}
        {discordSession ? (
          <DiscordLogin session={discordSession} onLoggedIn={bump} />
        ) : accountSession ? (
          <AccountLogin session={accountSession} onLoggedIn={bump} />
        ) : (
          <Login onLoggedIn={() => { navigate(EMPTY_ROUTE); bump(); }} />
        )}
      </div>
    );
  }

  // Same tabs, same order on every screen (the rental screen repeats them in src/rental-web/index.html).
  const navItems: NavItem[] = [
    { key: 'home', label: 'ホーム', href: '#/home', onSelect: () => navigate({ ...EMPTY_ROUTE, view: 'home' }) },
    { key: 'tasks', label: 'タスク', href: '#/tasks', onSelect: () => navigate({ ...EMPTY_ROUTE, view: 'tasks' }) },
    { key: 'rental', label: '物品貸出', labelBreaks: ['物品', '貸出'], href: '/rental' },
    // The tab is "メール", not "メールボックス": mail is sent from here too. The mailboxes inside it are each a "受信箱".
    { key: 'inbox', label: 'メール', href: '#/all', onSelect: () => navigate(EMPTY_ROUTE) },
    // Contacts have their own tab, next to メール.
    { key: 'contacts', label: '連絡先', href: '#/contacts', onSelect: () => navigate({ ...EMPTY_ROUTE, view: 'contacts' }) },
    { key: 'bot', label: 'Bot', href: '#/bot', onSelect: () => navigate({ ...EMPTY_ROUTE, view: 'bot', botSection: 'ask' }) },
    { key: 'settings', label: '設定', href: '#/settings', onSelect: () => navigate({ ...EMPTY_ROUTE, view: 'settings' }) },
  ];
  const currentNav: NavKey = route.view === 'home' ? 'home' : route.view === 'tasks' ? 'tasks' : route.view === 'bot' ? 'bot' : route.view === 'contacts' ? 'contacts' : route.view === 'mail' ? 'inbox' : 'settings';
  // Contacts exist with the committee mailbox (Discord login), for every committee member.
  const contactsEnabled = !!committeeMail;
  const topNav = <GlobalNav items={navItems} current={currentNav} />;

  if (route.view === 'home') {
    return (
      <div className="app">
        {bar}
        {topNav}
        <div className="layout home-layout">
          <HomeView
            userName={user.displayName}
            rental={rentalEntry}
            tasks={taskContext.data ?? null}
            mailboxes={mailboxes.data ?? []}
            lineAccounts={lineAccounts.data ?? []}
            inbox={committeeMail ? committeeMail.canOpen : inboxEntry && inboxCount > 0}
            inboxLocked={mailLocked}
            inboxUnhandledTotal={committeeMail?.unhandledTotal ?? null}
            refresh={refresh}
            onRefresh={bump}
            onOpenTasks={() => navigate({ ...EMPTY_ROUTE, view: 'tasks' })}
            onOpenInbox={(filter) => navigate({ ...EMPTY_ROUTE, inboxFilter: filter ?? null })}
            onOpenMailbox={(mailboxId) => navigate({ ...EMPTY_ROUTE, mailboxId, inboxFilter: 'unhandled' })}
            onOpenThread={(threadId) => navigate({ ...EMPTY_ROUTE, threadId, inboxFilter: 'unhandled' })}
            onOpenBot={(section) => navigate({ ...EMPTY_ROUTE, view: 'bot', botSection: section ?? 'ask' })}
            onOpenContacts={
              contactsEnabled
                ? (query) => {
                    setContactQuery(query);
                    navigate({ ...EMPTY_ROUTE, view: 'contacts' });
                  }
                : undefined
            }
          />
        </div>
      </div>
    );
  }

  if (route.view === 'tasks') {
    return (
      <div className="app">
        {bar}
        {topNav}
        <div className={`layout tasks-layout ${route.taskId || route.taskNew ? 'has-detail' : ''}`}>
          <TasksView
            route={{ workspaceId: route.taskWorkspaceId, taskId: route.taskId, creating: route.taskNew, remaining: route.taskRemaining, focus: route.taskFocus }}
            refresh={refresh}
            onNavigate={(r) => navigate({ ...EMPTY_ROUTE, view: 'tasks', taskWorkspaceId: r.workspaceId, taskId: r.taskId, taskNew: r.creating, taskRemaining: route.taskRemaining, taskFocus: route.taskFocus })}
          />
        </div>
      </div>
    );
  }

  if (route.view === 'bot') {
    return (
      <div className="app">
        {bar}
        {topNav}
        <div className="layout bot-layout">
          <BotView
            section={route.botSection ?? 'ask'}
            jobId={route.botJobId}
            refresh={refresh}
            onNavigate={(section, jobId) => navigate({ ...EMPTY_ROUTE, view: 'bot', botSection: section, botJobId: jobId ?? null })}
            mail={{
              request: botReplyRequest,
              onRequestUsed: clearBotReplyRequest,
              canSend: canSendMail,
              onUseDraft: (draft) => {
                setDraftToSend(draft);
                navigate(draft.reply ? { ...EMPTY_ROUTE, threadId: draft.reply.threadId } : { ...EMPTY_ROUTE, mailCompose: true });
              },
            }}
          />
        </div>
      </div>
    );
  }

  if (route.view === 'contacts' && contactsEnabled) {
    return (
      <div className="app">
        {bar}
        {topNav}
        <div className={`layout contacts-layout ${route.contactId || route.contactNew || route.contactImport ? 'has-detail' : ''}`}>
          <ContactsView
            route={{ contactId: route.contactId, creating: route.contactNew, importing: route.contactImport }}
            initialQuery={contactQuery}
            prefill={route.contactNew ? contactPrefill : null}
            onPrefillUsed={clearContactPrefill}
            canWriteMail={canSendMail}
            onWriteMail={(recipient) => {
              setComposeTo(recipient);
              navigate({ ...EMPTY_ROUTE, mailCompose: true });
            }}
            onNavigate={(r) => navigate({ ...EMPTY_ROUTE, view: 'contacts', contactId: r.contactId, contactNew: r.creating, contactImport: r.importing })}
            refresh={refresh}
          />
        </div>
      </div>
    );
  }

  if (route.view === 'contacts') {
    return (
      <div className="app">
        {bar}
        {topNav}
        <div className="layout home-layout">
          <main className="main" aria-labelledby="contacts-unavailable-title">
            <h2 id="contacts-unavailable-title">連絡先</h2>
            {mailStatusSettled ? (
              <p className="status error" role="alert">
                このサーバーでは連絡先を使えません。
              </p>
            ) : (
              <LoadStatus loader={mailStatus} what="連絡先" />
            )}
          </main>
        </div>
      </div>
    );
  }

  if (route.view === 'settings') {
    return (
      <div className="app">
        {bar}
        {topNav}
        <div className="layout settings-layout">
          <SettingsView session={session.data} user={user} tasks={taskContext.data ?? null} committeeMail={!!committeeMail} committeeLine={!!committeeMail && (lineAccounts.data?.length ?? 0) > 0} onChanged={bump} />
        </div>
      </div>
    );
  }

  const mailboxList = mailboxes.data ?? [];
  const lineList = lineAccounts.data ?? [];
  // The synthetic inbox sends administrators to the access screen; the committee mailbox is read by everyone.
  const isAdminView = !committeeMail && (route.view === 'admin' || user.canManageAccess);
  const composing = !isAdminView && canSendMail && route.mailCompose && !route.lineAccountId;
  const inboxDetail = !isAdminView && (!!(route.threadId ?? route.conversationId) || composing);
  // One message in two mailboxes counts once in the committee total; the per-mailbox counts would count it twice.
  const allUnhandled = committeeMail?.unhandledTotal ?? mailboxList.reduce((n, m) => n + m.unhandledCount, 0) + lineList.reduce((n, a) => n + a.unhandledCount, 0);
  const scopeKey = route.mailboxId ? `m:${route.mailboxId}` : route.lineAccountId ? `l:${route.lineAccountId}` : 'all';
  const scopeAddress = route.mailboxId ? (mailboxList.find((m) => m.id === route.mailboxId)?.address ?? null) : null;
  // Below 1200px the mailbox column folds into this choice above the list (same entries and counts).
  const scopeSwitcher = isAdminView ? null : (
    <label className="scope-switcher">
      <span className="sr-only">表示する受信箱</span>
      <select
        value={scopeKey}
        onChange={(e) => {
          const kind = e.target.value.slice(0, 2);
          const id = e.target.value.slice(2);
          navigate(
            kind === 'm:'
              ? { ...EMPTY_ROUTE, mailboxId: id }
              : kind === 'l:'
                ? { ...EMPTY_ROUTE, lineAccountId: id }
                : { ...EMPTY_ROUTE },
          );
        }}
      >
        <option value="all">
          {committeeMail ? 'すべての受信箱' : 'すべての許可された受信箱'}
          {allUnhandled > 0 ? `（未対応 ${allUnhandled}）` : ''}
        </option>
        {mailboxList.map((m) => (
          <option key={m.id} value={`m:${m.id}`}>
            {m.name}
            {m.unhandledCount > 0 ? `（未対応 ${m.unhandledCount}）` : ''}
          </option>
        ))}
        {lineList.map((a) => (
          <option key={a.id} value={`l:${a.id}`}>
            LINE: {a.name}
            {a.unhandledCount > 0 ? `（未対応 ${a.unhandledCount}）` : ''}
          </option>
        ))}
      </select>
    </label>
  );

  if (inboxProblem) {
    return (
      <div className="app">
        {bar}
        {topNav}
        <div className="layout home-layout">
          <main className="main" aria-labelledby="inbox-unavailable-title" data-testid="inbox-unavailable">
            <h2 id="inbox-unavailable-title">受信箱を開けません</h2>
            <p className="status error" role="alert">
              {inboxProblem}
            </p>
          </main>
        </div>
      </div>
    );
  }

  if (mailLocked) {
    return (
      <div className="app">
        {bar}
        {topNav}
        <div className="layout home-layout">
          <MailReauth idleHours={committeeMail.idleHours} onDone={bump} />
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      {bar}
      {topNav}
      <div className={`layout inbox-layout ${inboxDetail ? 'has-detail' : ''}`}>
        <div className="sidebar">
        {/* Sending apart from the mailboxes: a new-mail button above the list reads as part of the inbox. */}
        {canSendMail && !isAdminView && (
          <section className="sidebar-send" aria-labelledby="sidebar-send-title">
            <h2 className="sidebar-title" id="sidebar-send-title">
              送信
            </h2>
            <button
              type="button"
              className={`send-entry ${composing ? 'active' : ''}`}
              aria-current={composing ? 'page' : undefined}
              onClick={() => {
                setComposeTo(null);
                navigate({ ...route, threadId: null, conversationId: null, mailCompose: true });
              }}
              data-testid="compose-new"
            >
              新しいメールを書く
            </button>
            <p className="hint">委員会のアドレスから送ります。</p>
          </section>
        )}
        <nav aria-label="受信箱">
          <h2 className="sidebar-title">受信箱</h2>
          {isAdminView ? (
            <p className="hint">{proxyMode ? '権限管理者' : 'デモ管理者'}は権限管理とモック同期だけを行えます。メール本文は閲覧できません。</p>
          ) : (
            <>
              <button
                type="button"
                className={`nav-item ${route.view === 'mail' && route.mailboxId === null && route.lineAccountId === null && !composing ? 'active' : ''}`}
                aria-current={route.mailboxId === null && route.lineAccountId === null && !composing ? 'page' : undefined}
                onClick={() => navigate({ ...EMPTY_ROUTE })}
              >
                <span className="mailbox-name">{committeeMail ? 'すべての受信箱' : 'すべての許可された受信箱'}</span>
                {allUnhandled > 0 && <span className="count-badge" aria-label={`未対応 ${allUnhandled} 件`}>{allUnhandled}</span>}
              </button>
              <LoadStatus loader={mailboxes} what="受信箱" compact />
              {mailboxes.data && mailboxList.length === 0 && <p className="empty">閲覧を許可された受信箱はありません。</p>}
              <ul className="mailbox-list">
                {mailboxList.map((m) => (
                  <li key={m.id}>
                    <button
                      type="button"
                      className={`nav-item ${route.mailboxId === m.id && !composing ? 'active' : ''}`}
                      aria-current={route.mailboxId === m.id && !composing ? 'page' : undefined}
                      title={`${m.name}（${m.address}）`}
                      onClick={() => navigate({ ...EMPTY_ROUTE, mailboxId: m.id })}
                      data-mailbox-id={m.id}
                    >
                      <span className="mailbox-name">{m.name}</span>
                      {/* Committee mail: every member edits the handling; the grant only adds notes (said in the detail). */}
                      {!committeeMail && <span className="mailbox-meta">{m.access === 'edit' ? '編集可' : '閲覧のみ'}</span>}
                      {m.unhandledCount > 0 && <span className="count-badge" aria-label={`未対応 ${m.unhandledCount} 件`}>{m.unhandledCount}</span>}
                    </button>
                  </li>
                ))}
              </ul>
              <LoadStatus loader={lineAccounts} what="LINE アカウント" compact />
              {lineList.length > 0 && (
                <>
                  <h3 className="nav-heading">LINE</h3>
                  <ul className="mailbox-list" aria-label="LINE アカウント">
                    {lineList.map((a) => (
                      <li key={a.id}>
                        <button
                          type="button"
                          className={`nav-item ${route.lineAccountId === a.id ? 'active' : ''}`}
                          aria-current={route.lineAccountId === a.id ? 'page' : undefined}
                          onClick={() => navigate({ ...EMPTY_ROUTE, lineAccountId: a.id })}
                          data-line-account-id={a.id}
                        >
                          <span className="mailbox-name">{a.name}</span>
                          <span className="mailbox-meta">
                            {committeeMail ? (a.access === 'edit' ? 'メモ可' : '閲覧・対応') : a.access === 'edit' ? '編集可' : '閲覧のみ'}
                            {a.kind === 'legacy_archive' || a.sending === 'none' ? '・返信不可' : a.canReply ? (a.sending === 'mock' ? '・返信可（模擬）' : '・送信可') : '・返信権限なし'}
                          </span>
                          {a.unhandledCount > 0 && <span className="count-badge" aria-label={`未対応 ${a.unhandledCount} 件`}>{a.unhandledCount}</span>}
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          )}
        </nav>
        </div>
        {isAdminView ? (
          <main className="main">
            <AdminPanel user={user} onChanged={bump} demoControls={demoMode} />
          </main>
        ) : (
          <>
            <section className="list-pane" aria-label="スレッド一覧">
              {/* Below 1200px the side column is folded: sending shows here, marked apart from the mailbox list below. */}
              {canSendMail && !route.lineAccountId && (
                <section className="list-compose" aria-labelledby="list-send-title">
                  <h2 className="list-compose-label" id="list-send-title">
                    送信
                  </h2>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => {
                      setComposeTo(null);
                      navigate({ ...route, threadId: null, conversationId: null, mailCompose: true });
                    }}
                    data-testid="compose-new-list"
                  >
                    新しいメールを書く
                  </button>
                </section>
              )}
              <ThreadList
                key={scopeKey}
                mailboxId={route.mailboxId}
                mailboxAddress={scopeAddress}
                initialFilter={route.inboxFilter}
                onFiltersChanged={() => {
                  // The list's own filters replace a home link's (filter=), so a reload shows what is on screen.
                  if (route.inboxFilter) navigate({ ...route, inboxFilter: null });
                }}
                switcher={scopeSwitcher}
                lineAccountId={route.lineAccountId}
                allTitle={committeeMail ? 'すべての受信箱' : undefined}
                onReauthRequired={bump}
                mailboxName={
                  route.mailboxId
                    ? (mailboxList.find((m) => m.id === route.mailboxId)?.name ?? null)
                    : route.lineAccountId
                      ? (lineList.find((a) => a.id === route.lineAccountId)?.name ?? null)
                      : null
                }
                selectedId={route.threadId ?? route.conversationId}
                refresh={refresh}
                onChanged={bump}
                onSelect={(selection) =>
                  navigate({
                    ...route,
                    threadId: selection.kind === 'thread' ? selection.id : null,
                    conversationId: selection.kind === 'conversation' ? selection.id : null,
                    mailCompose: false,
                  })
                }
              />
            </section>
            <section className="detail-pane" aria-label="スレッド詳細">
              {inboxDetail && (
                <button type="button" className="back-link" onClick={() => navigate({ ...route, threadId: null, conversationId: null, mailCompose: false })}>
                  ← 一覧に戻る
                </button>
              )}
              {composing && sendOptions ? (
                <MailCompose
                  key={draftToSend && !draftToSend.reply ? 'bot-draft' : composeTo ? `to:${composeTo}` : 'new'}
                  options={sendOptions}
                  initial={newDraft(sendOptions, route.mailboxId ?? undefined, draftToSend && !draftToSend.reply ? draftToSend : undefined, draftToSend ? '' : (composeTo ?? ''))}
                  mode="new"
                  onCancel={() => {
                    clearDraftToSend();
                    setComposeTo(null);
                    navigate({ ...route, mailCompose: false });
                  }}
                  onSent={(result) => {
                    clearDraftToSend();
                    setComposeTo(null);
                    navigate({ ...route, mailCompose: false, threadId: result.threadId });
                    bump();
                  }}
                />
              ) : route.threadId ? (
                <ThreadDetail
                  key={route.threadId}
                  threadId={route.threadId}
                  refresh={refresh}
                  onChanged={bump}
                  caseTasks={caseTasks}
                  onReauthRequired={bump}
                  sendOptions={canSendMail ? sendOptions : null}
                  onAskBot={(request) => {
                    setBotReplyRequest(request);
                    navigate({ ...EMPTY_ROUTE, view: 'bot', botSection: 'mail' });
                  }}
                  draft={draftToSend?.reply?.threadId === route.threadId ? draftToSend : null}
                  onDraftUsed={clearDraftToSend}
                  contacts={
                    contactsEnabled
                      ? {
                          onAdd: (prefill) => {
                            setContactPrefill(prefill);
                            navigate({ ...EMPTY_ROUTE, view: 'contacts', contactNew: true });
                          },
                          onOpen: (contactId) => navigate({ ...EMPTY_ROUTE, view: 'contacts', contactId }),
                        }
                      : null
                  }
                />
              ) : route.conversationId ? (
                <LineConversation key={route.conversationId} conversationId={route.conversationId} refresh={refresh} onChanged={bump} caseTasks={caseTasks} />
              ) : (
                <div className="detail-placeholder">
                  <h2>受信内容を選択</h2>
                  <p>一覧から選ぶと、本文と対応状況・担当・ラベル・内部メモがここに出ます。</p>
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
