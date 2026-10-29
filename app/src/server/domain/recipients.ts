import type { Address } from '../../shared/api.js';
import type { Mailbox } from './types.js';

// Synthetic-recipient display policy (test default, see docs/requirements.md):
// - Show the address of the mailbox this receipt was delivered to.
// - Show addresses that are not app-managed mailboxes (e.g. customers, external CCs).
// - Omit every other app-managed mailbox address, whether or not the viewer can read it,
//   so the display never depends on, or reveals, other mailboxes' receipts or grants.
// - Bcc is never stored or displayed; delivery metadata (Delivered-To, Received) stays hidden.
// The UI shows a fixed, unconditional policy note rather than a per-message "hidden" marker.

export function displayRecipients(addresses: Address[], receiptMailbox: Mailbox, allMailboxes: Mailbox[]): Address[] {
  const own = receiptMailbox.address.toLowerCase();
  const managed = new Set(allMailboxes.map((m) => m.address.toLowerCase()));
  return addresses.filter((a) => {
    const addr = a.address.toLowerCase();
    return addr === own || !managed.has(addr);
  });
}
