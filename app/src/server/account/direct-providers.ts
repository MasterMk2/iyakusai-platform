import type { BotDelivery, DeliveryAck, GroupMembershipReader, IdentityLink, IdentityLinkDirectory, LoginCodeEnvelope, PrincipalDirectory } from '../login/types.js';
import type { GoogleDirectoryReader } from './google-directory.js';
import { bindingToLink, type FileIdentityRegistry } from './identity-registry.js';

// The four LoginService provider slots of the direct-provider composition, in process:
//  - links / principals: the authoritative registry (re-read per call) + live Directory user check;
//  - membership: the Directory effective-membership reader;
//  - deliver: an approved DM transport, or the explicit unavailable transport below.
// Every failure throws (or reports an unresolved observation), which the login core treats as a denial.
// Freshness cost (documented): one authenticated request reads the registry up to three times (link,
// then principal before and after the live read), each a synchronous read + hash + compatibility check.

export interface DirectIdentityProviders {
  links: IdentityLinkDirectory;
  principals: PrincipalDirectory;
  membership: GroupMembershipReader;
}

export function directIdentityProviders(registry: FileIdentityRegistry, directory: GoogleDirectoryReader): DirectIdentityProviders {
  return {
    links: {
      findByVerifiedEmail: async (email: string): Promise<IdentityLink | null> => {
        const binding = registry.current().byEmail(email);
        return binding ? bindingToLink(binding) : null;
      },
      getLink: async (linkId: string): Promise<IdentityLink | null> => {
        const binding = registry.current().byLinkId(linkId);
        return binding ? bindingToLink(binding) : null;
      },
    },
    principals: {
      getPrincipal: async (principalId: string) => {
        const binding = registry.current().byPrincipal(principalId);
        if (!binding) return null;
        if (binding.status !== 'active') return { principalId, active: false };
        const live = await directory.verifyPrincipal(binding.google.userId, binding.google.primaryEmail);
        // The binding must still be the same one after the live read (a reload may have revoked it).
        const after = registry.current().byPrincipal(principalId);
        const unchanged = after?.status === 'active' && after.linkVersion === binding.linkVersion && after.google.userId === binding.google.userId;
        return { principalId, active: live && unchanged };
      },
    },
    membership: { lookup: directory.lookup },
  };
}

/**
 * No approved Bot DM transport: every delivery is refused (never reported as delivered), so no
 * code becomes usable. Existing password credentials keep working under the full per-request checks.
 */
export const unavailableDmDelivery: BotDelivery = async (envelope: LoginCodeEnvelope): Promise<DeliveryAck> => ({
  deliveryId: envelope.deliveryId,
  status: 'failed',
  reason: 'unavailable',
});
