// Operator-issued local accounts for item work on the festival days. These IDs are explicitly
// not Discord identities: the account key is `staff:<student number>` in a reserved number range.
// The range is the operator's: SMM_TEMPORARY_STAFF_RANGE="first-last", eight digits each (both ends
// included), chosen so that no real student number falls in it. Unset, no number is a staff number.

const RANGE = /^(\d{8})-(\d{8})$/;
let parsed: { source: string; range: readonly [number, number] | null } | null = null;

function staffRange(): readonly [number, number] | null {
  const source = process.env.SMM_TEMPORARY_STAFF_RANGE ?? '';
  if (parsed?.source !== source) {
    const m = RANGE.exec(source.trim());
    const range = m && Number(m[1]) <= Number(m[2]) ? ([Number(m[1]), Number(m[2])] as const) : null;
    parsed = { source, range };
  }
  return parsed.range;
}

/** A student number in the reserved temporary staff range. */
export function isStaffStudentId(value: string): boolean {
  const range = staffRange();
  if (!range || !/^\d{8}$/.test(value)) return false;
  const n = Number(value);
  return n >= range[0] && n <= range[1];
}

export const isTemporaryStaffId = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith('staff:') && isStaffStudentId(value.slice(6));

export const isTemporaryStaffLoginId = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith('iy-') && isStaffStudentId(value.slice(3));

/** The stored shape a temporary staff account must have exactly; anything else is not one. */
export function isTemporaryStaffAccount(a: unknown): boolean {
  if (!a || typeof a !== 'object') return false;
  const r = a as Record<string, unknown>;
  return (
    r.accountType === 'temporary_staff' &&
    isTemporaryStaffId(r.discordUserId) &&
    r.studentId === r.discordUserId.slice(6) &&
    r.initialLoginId === 'iy-' + String(r.studentId) &&
    r.guildId === null &&
    r.joinEpochMs === null &&
    r.taskUserId === null &&
    Array.isArray(r.existingRoleIds) &&
    r.existingRoleIds.length === 0 &&
    r.pending === null &&
    r.memberVerifiedAt === null &&
    r.status !== 'pending'
  );
}

export const temporaryStaffName = (studentId: string | null | undefined): string => '臨時スタッフ ' + String(studentId);

const STAFF_GET = new Set([
  '/api/session',
  '/api/rental/me',
  '/api/rental/borrowers',
  '/api/rental/summary',
  '/api/rental/overview',
  '/api/rental/items/:code',
  '/api/rental/items/:code/inspection',
  '/api/rental/operations/:id',
  '/api/rental/operations/:id/photos/:index',
  '/api/rental/issuance/:code',
  '/api/rental/items/:code/metadata',
  '/api/rental/items/:code/corrections',
]);

const STAFF_POST = new Set([
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/reauth',
  '/api/auth/password',
  '/api/rental/borrowers',
  '/api/rental/operations',
  '/api/rental/items/:code/corrections',
]);

/** API routes a temporary staff account may call; everything else answers 403 (http.ts). */
export function staffRouteAllowed(method: string, route: string | undefined): boolean {
  if (method === 'GET' || method === 'HEAD') return STAFF_GET.has(route ?? '');
  // Item details and corrections of registrations: open to temporary staff too.
  if (method === 'PATCH') return route === '/api/rental/items/:code/metadata';
  return method === 'POST' && STAFF_POST.has(route ?? '');
}
