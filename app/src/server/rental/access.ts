import type { RentalAccessResponse } from '../../shared/rental-access.js';
import type { User } from '../domain/types.js';
import { isTemporaryStaffLoginId } from '../discord-auth/temporary-staff.js';
import { RENTAL_PERMISSIONS, type Actor, type RentalPermission, type RentalStore } from './store.js';
import { RentalError, utcNow } from './validate.js';

/** The DB override wins over the operator's initial environment setting; no write happens on read. */
export class RentalAccess {
  constructor(private readonly store: RentalStore, private readonly initialAllMembersAdmin: boolean) {}

  policy(): { revision: number; allMembersAdmin: boolean } {
    const read = (key: string) => this.store.db.prepare('SELECT value FROM config WHERE key=?').get(key)?.value;
    const enabled = read('rental_all_members_admin');
    const revision = read('rental_access_revision');
    if (enabled !== undefined && enabled !== 'true' && enabled !== 'false') throw new RentalError(500, '物品の権限設定を読み取れません。', 'integrity');
    const version = revision === undefined ? 0 : Number(revision);
    if (!Number.isSafeInteger(version) || version < 0) throw new RentalError(500, '物品の権限設定を読み取れません。', 'integrity');
    return { revision: version, allMembersAdmin: enabled === undefined ? this.initialAllMembersAdmin : enabled === 'true' };
  }

  permissions(userId: string): RentalPermission[] {
    // Temporary staff only lend and take back items, whatever the members' setting says.
    if (isTemporaryStaffLoginId(userId)) return ['rental.loan'];
    const stored = this.store.permissionsOf(userId);
    return this.policy().allMembersAdmin || stored.includes('rental.admin') ? ['rental.issue', 'rental.loan'] : stored;
  }

  isAdmin(user: User): boolean {
    if (isTemporaryStaffLoginId(user.id)) return false;
    return !user.disabled && (user.canManageAccess || this.policy().allMembersAdmin || this.store.permissionsOf(user.id).includes('rental.admin'));
  }

  snapshot(people: User[], lookup: (id: string) => User | undefined): RentalAccessResponse {
    const policy = this.policy();
    const history = this.store.db.prepare('SELECT * FROM rental_access_events ORDER BY id DESC LIMIT 20').all();
    return {
      ...policy,
      people: people.filter((u) => !u.disabled).map((u) => ({
        id: u.id, displayName: u.displayName, roleLabel: u.roleLabel,
        storedPermissions: this.store.permissionsOf(u.id), effectivePermissions: this.permissions(u.id), effectiveAdmin: this.isAdmin(u) && this.permissions(u.id).includes('rental.issue'),
      })).sort((a, b) => a.displayName.localeCompare(b.displayName, 'ja')),
      history: history.map((e) => ({
        id: Number(e.id), at: String(e.at), actorName: lookup(String(e.actor_id))?.displayName ?? String(e.actor_name),
        targetName: e.target_id ? lookup(String(e.target_id))?.displayName ?? '利用できなくなったアカウント' : null,
        kind: e.kind as 'policy' | 'account', before: JSON.parse(String(e.before_json)), after: JSON.parse(String(e.after_json)),
      })),
    };
  }

  updatePolicy(enabled: unknown, expectedRevision: unknown, actor: Actor): void {
    if (typeof enabled !== 'boolean') throw new RentalError(400, '全員設定はオンまたはオフで指定してください。');
    this.change(expectedRevision, actor, 'policy', null, () => {
      const before = this.policy().allMembersAdmin;
      this.store.db.prepare('INSERT INTO config(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('rental_all_members_admin', String(enabled));
      return { before, after: enabled };
    });
  }

  updateAccount(userId: string, wanted: unknown, expectedRevision: unknown, actor: Actor, legacy = false): void {
    if (!Array.isArray(wanted) || wanted.some((p) => typeof p !== 'string' || !(RENTAL_PERMISSIONS as readonly string[]).includes(p))) throw new RentalError(400, '物品の権限を正しく指定してください。');
    const permissions = [...new Set(wanted)] as RentalPermission[];
    if (permissions.includes('rental.admin')) permissions.push('rental.loan', 'rental.issue');
    const after = [...new Set(permissions)].sort();
    this.change(expectedRevision, actor, 'account', userId, () => {
      const before = this.store.permissionsOf(userId);
      this.store.db.prepare('DELETE FROM grants WHERE user_id=?').run(userId);
      const now = utcNow();
      for (const permission of after) this.store.db.prepare('INSERT INTO grants(user_id,permission,granted_by,granted_at) VALUES(?,?,?,?)').run(userId, permission, actor.id, now);
      return { before, after };
    }, legacy);
  }

  private change(expected: unknown, actor: Actor, kind: 'policy' | 'account', target: string | null, update: () => { before: unknown; after: unknown }, legacy = false): void {
    if ((!legacy || expected !== undefined) && (typeof expected !== 'number' || !Number.isSafeInteger(expected) || expected < 0)) throw new RentalError(400, '表示中の設定の版を指定してください。');
    const db = this.store.db;
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.policy().revision;
      if (expected !== undefined && current !== expected) throw new RentalError(409, '別の管理者が先に変更しました。最新の設定を読み直してから保存してください。', 'conflict');
      const { before, after } = update();
      db.prepare('INSERT INTO rental_access_events(at,actor_id,actor_name,kind,target_id,before_json,after_json) VALUES(?,?,?,?,?,?,?)').run(utcNow(), actor.id, actor.name, kind, target, JSON.stringify(before), JSON.stringify(after));
      db.prepare('INSERT INTO config(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('rental_access_revision', String(current + 1));
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
}
