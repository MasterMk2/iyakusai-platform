// パスワード帳 (2026-11-23): the committee's own accounts and passwords, kept by the server (encrypted at rest with a
// key in the configuration folder) and opened by signed-in members who typed their password a short while ago.
// Sections (グループ on the screen since 2026-11-24; 区分 before) are opened by departments and by named members; each
// holds entries (パスワード on the screen). The screens never receive a
// password or a note in a list: one value at a time, on purpose, and the server records each one it hands out.

export const VAULT_ROLES = ['view', 'edit', 'manage'] as const;
export type VaultRole = (typeof VAULT_ROLES)[number];

export const VAULT_ROLE_LABELS: Record<VaultRole, string> = { view: '見る', edit: '編集する', manage: '管理する' };
export const VAULT_ROLE_HINTS: Record<VaultRole, string> = {
  view: 'パスワードの表示・コピー・印刷',
  edit: '見る＋パスワードの登録・編集・削除',
  manage: '編集する＋見られる人の付け外し',
};

/** 0 for none; a stronger role has a larger number. */
export const vaultRoleRank = (role: VaultRole | null | undefined): number => (role ? VAULT_ROLES.indexOf(role) + 1 : 0);

export function strongerVaultRole(a: VaultRole | null, b: VaultRole | null): VaultRole | null {
  return vaultRoleRank(a) >= vaultRoleRank(b) ? a : b;
}

export const VAULT_LIMITS = {
  sectionName: 40,
  sectionNote: 200,
  sections: 50,
  entryName: 100,
  purpose: 200,
  url: 500,
  username: 200,
  email: 254,
  password: 1000,
  notes: 4000,
  entriesPerSection: 500,
  membersPerSection: 100,
  events: 200,
  department: 60,
} as const;

export const VAULT_SECTION_ID = /^vs_[0-9a-f]{16}$/;
/** A registered address (登録メールアドレス), loose on purpose (a service may accept odd forms): text on both sides of an @. */
export const VAULT_EMAIL = /^[^\s@]+@[^\s@]+$/;
export const VAULT_ENTRY_ID = /^ve_[0-9a-f]{16}$/;
/** Token from the form: a retried save returns the entry the first one made (no duplicates). */
export const VAULT_TOKEN = /^[A-Za-z0-9_-]{16,64}$/;

/** The error code of a request that needs the password typed again first (401). */
export const VAULT_REAUTH_REQUIRED = 'vault_reauth_required';

export const VAULT_REVEAL_MINUTES_DEFAULT = 10;

/**
 * The fields of an entry the server keeps encrypted (all of them). 用途 and 登録メールアドレス came on 2026-11-23 (the
 * chair's list: サイト名・用途・URL・ユーザー名・登録メールアドレス・パスワード); entries saved before open with them empty.
 */
export interface VaultSecret {
  /** サイト名 */
  name: string;
  /** 用途 */
  purpose: string;
  url: string;
  /** ユーザー名（ログインの ID） */
  username: string;
  /** 登録メールアドレス */
  email: string;
  password: string;
  notes: string;
}

export const VAULT_SECRET_KEYS = ['name', 'purpose', 'url', 'username', 'email', 'password', 'notes'] as const satisfies readonly (keyof VaultSecret)[];
export const VAULT_FIELD_LABELS: Record<keyof VaultSecret, string> = { name: 'サイト名', purpose: '用途', url: 'URL', username: 'ユーザー名', email: '登録メールアドレス', password: 'パスワード', notes: 'メモ' };

export type VaultMemberKind = 'user' | 'department';

export interface VaultMetaResponse {
  /** The server has the password book (vault.json and its key). */
  enabled: boolean;
  /** The person may use it: a member of a section, or an access administrator. */
  canOpen: boolean;
  /** An access administrator: makes, renames and removes sections, and sets who opens them. */
  canAdminister: boolean;
  /** Minutes a typed password is good for here. */
  revealMinutes: number;
  /** Until when this device may open entries (UTC), or null when the password is needed first. */
  freshUntil: string | null;
}

export interface VaultSectionSummary {
  id: string;
  name: string;
  note: string;
  /** The person's role here, null for an administrator who is not a member (no values). */
  myRole: VaultRole | null;
  canManage: boolean;
  entryCount: number;
  /** When it was last printed (UTC), null when never. */
  lastPrintedAt: string | null;
  /** Additions, changes and deletions since the last print (since the start when never printed). */
  changesSincePrint: number;
  version: number;
}

export interface VaultSectionsResponse {
  sections: VaultSectionSummary[];
  canAdminister: boolean;
}

export interface VaultEntryItem {
  id: string;
  sectionId: string;
  name: string;
  purpose: string;
  url: string;
  username: string;
  email: string;
  hasPassword: boolean;
  hasNotes: boolean;
  updatedAt: string;
  updatedByName: string;
  version: number;
}

export interface VaultEntriesResponse {
  entries: VaultEntryItem[];
  /** Entries the server could not open (another key, or changed bytes): left out of the list, and to be reported. */
  unreadable: number;
}

export interface VaultEntryResponse {
  entry: VaultEntryItem;
  replayed?: boolean;
}

export type VaultRevealField = 'password' | 'notes';
export type VaultRevealPurpose = 'show' | 'copy' | 'edit';

export interface VaultRevealResponse {
  field: VaultRevealField;
  value: string;
}

export interface VaultMember {
  kind: VaultMemberKind;
  /** A user id or a department name. */
  target: string;
  label: string;
  role: VaultRole;
  grantedByName: string;
  grantedAt: string;
}

/** A person who can open the section now, and why (their own grant, or a department). */
export interface VaultOpener {
  id: string;
  name: string;
  role: VaultRole;
  via: string[];
}

export interface VaultMembersResponse {
  section: VaultSectionSummary;
  members: VaultMember[];
  openers: VaultOpener[];
  choices: { departments: string[]; people: { id: string; name: string; departments: string[] }[] };
}

export interface VaultPrintResponse {
  section: { id: string; name: string };
  edition: string;
  printedAt: string;
  printedByName: string;
  entries: (VaultSecret & { updatedAt: string })[];
}

export type VaultAction =
  | 'section_created'
  | 'section_updated'
  | 'section_deleted'
  | 'member_set'
  | 'member_removed'
  | 'entry_created'
  | 'entry_updated'
  | 'entry_deleted'
  | 'revealed'
  | 'copied'
  | 'printed';

export const VAULT_ACTION_LABELS: Record<VaultAction, string> = {
  section_created: 'グループを作った',
  section_updated: 'グループの名前・説明を変えた',
  section_deleted: 'グループを消した',
  member_set: '見られる人を付けた・変えた',
  member_removed: '見られる人を外した',
  entry_created: 'パスワードを登録した',
  entry_updated: '登録を編集した',
  entry_deleted: '登録を消した',
  revealed: '値を表示した',
  copied: '値をコピーした',
  printed: '印刷した',
};

export interface VaultEventItem {
  at: string;
  actorName: string;
  action: VaultAction;
  /** The entry's name (decrypted now), or a placeholder for one that is gone; null for section events. */
  entryName: string | null;
  detail: string;
}

export interface VaultEventsResponse {
  events: VaultEventItem[];
}

// The password book's address inside the app: its own tab (2026-11-23; #/settings/vault, its first address, opens it too).
export const VAULT_HREF = '#/vault';
