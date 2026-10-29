import type { MailboxDefinition } from './config.js';

// Which committee mailboxes a message belongs to. An address counts when, after normalizing, it is
// exactly a listed committee address: lower case, another committee domain mapped to the main one
// (.jp = .com), and a "+tag" dropped on committee domains (info+managers@ is delivered to info@).
// Personal addresses are never listed, so they never make a mailbox. Forwarding (a group that is a member
// of another group) is followed to every destination, so forwarded mail shows in each mailbox it reached.

export class CommitteeAddresses {
  private readonly byAddress = new Map<string, MailboxDefinition>();
  private readonly byListId = new Map<string, MailboxDefinition>();
  private readonly domains = new Set<string>();
  private readonly byTag = new Map<string, MailboxDefinition>();

  constructor(
    readonly mailboxes: readonly MailboxDefinition[],
    private readonly aliases: Readonly<Record<string, string>>,
  ) {
    for (const m of mailboxes) {
      const [local, domain] = m.address.split('@') as [string, string];
      this.byAddress.set(m.address, m);
      this.domains.add(domain);
      // Google Groups name the list "<local.domain>" in the List-Id header.
      this.byListId.set(`${local}.${domain}`, m);
      for (const [alias, target] of Object.entries(aliases)) if (target === domain) this.byListId.set(`${local}.${alias}`, m);
      if (m.subjectTag) this.byTag.set(m.subjectTag, m);
    }
  }

  /**
   * Groups named by the tags at the very start of a subject ("[adm] [sps] ..."), which Google Groups add
   * on delivery. Tags after "Re:" or inside the subject are left from earlier mail and are not counted.
   */
  ofSubject(subject: string): MailboxDefinition[] {
    const lead = /^\s*((?:\[[^\]\s]{1,20}\]\s*)+)/.exec(subject)?.[1] ?? '';
    return [...lead.matchAll(/\[([^\]]+)\]/g)].flatMap((t) => {
      const m = this.byTag.get(t[1]!.toLowerCase());
      return m ? [m] : [];
    });
  }

  /** These mailboxes and every mailbox they forward to, directly or through others, in configuration order. */
  withForwards(found: Iterable<MailboxDefinition>): MailboxDefinition[] {
    const ids = new Set<string>();
    const queue = [...found];
    while (queue.length > 0) {
      const m = queue.shift()!;
      if (ids.has(m.id)) continue;
      ids.add(m.id);
      for (const f of m.forwardsTo) {
        const next = this.mailboxes.find((x) => x.id === f);
        if (next) queue.push(next);
      }
    }
    return this.mailboxes.filter((m) => ids.has(m.id));
  }

  get catchAll(): MailboxDefinition {
    return this.mailboxes.find((m) => m.catchAll)!;
  }

  normalize(address: string): string {
    const value = address.trim().toLowerCase();
    const at = value.lastIndexOf('@');
    if (at <= 0) return value;
    let local = value.slice(0, at);
    let domain = value.slice(at + 1);
    domain = this.aliases[domain] ?? domain;
    if (this.domains.has(domain)) local = local.split('+')[0]!;
    return `${local}@${domain}`;
  }

  ofAddress(address: string): MailboxDefinition | undefined {
    return this.byAddress.get(this.normalize(address));
  }

  /** A List-Id header value such as `"協賛" <sponsorship.iyakusai.com>`. */
  ofListId(value: string): MailboxDefinition | undefined {
    const inner = /<([^<>\s]+)>/.exec(value)?.[1] ?? value.trim();
    return this.byListId.get(inner.toLowerCase());
  }

  /** Mailboxes named by any of these addresses, in configuration order. */
  matching(addresses: Iterable<string>, listIds: Iterable<string> = []): MailboxDefinition[] {
    const found = new Set<string>();
    for (const a of addresses) {
      const m = this.ofAddress(a);
      if (m) found.add(m.id);
    }
    for (const l of listIds) {
      const m = this.ofListId(l);
      if (m) found.add(m.id);
    }
    return this.mailboxes.filter((m) => found.has(m.id));
  }
}
