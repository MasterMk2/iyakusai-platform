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
