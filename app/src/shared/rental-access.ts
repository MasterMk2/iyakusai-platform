export type RentalAccessPermission = 'rental.loan' | 'rental.issue' | 'rental.admin';
export interface RentalAccessPerson {
  id: string;
  displayName: string;
  roleLabel: string;
  storedPermissions: RentalAccessPermission[];
  effectivePermissions: RentalAccessPermission[];
  effectiveAdmin: boolean;
}
export interface RentalAccessResponse {
  revision: number;
  allMembersAdmin: boolean;
  people: RentalAccessPerson[];
  history: {
    id: number;
    at: string;
    actorName: string;
    targetName: string | null;
    kind: 'policy' | 'account';
    before: boolean | RentalAccessPermission[];
    after: boolean | RentalAccessPermission[];
  }[];
}

/** GET/PUT /api/rental/admin/switch (src/server/rental/switch.ts): whether rental is in use, for access administrators. */
export interface RentalSwitchResponse {
  enabled: boolean;
  /** Items with a group now and items back with a problem: what stopping would leave unattended. */
  loaned: number;
  review: number;
  history: { id: number; at: string; actorName: string; enabled: boolean }[];
}
