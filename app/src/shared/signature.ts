import { z } from 'zod';

// The signature the mail and official LINE forms start with (2026-11-10). The committee's own mail ends with one
// shape, the commonest from April to November 2026:
//
//   ーーー ーーー ーーー ーーー ーーー ーーー ーーー ーーー
//   送信者
//
//   <委員会名>
//   <肩書き> <氏名>
//
//   <住所の行>
//   団体代表email : <委員会の窓口のアドレス>
//   委員個人email : <本人のアドレス>
//   ーーー ーーー ーーー ーーー ーーー ーーー ーーー ーーー
//
// Its official LINE messages carry a short one at the end (the chair's choice): a rule, the committee and the person.
// The committee's name is the From line's (mail config); the address line and the committee's address are set by an
// access administrator in the settings, and each person sets their own title and address there. Nothing real is
// written in this file: the repository is public.

export const SIGNATURE_LIMITS = {
  title: 30,
  email: 254,
  address: 80,
} as const;

/** The rule above and below the mail signature, as the committee writes it. */
export const MAIL_SIGNATURE_RULE = 'ーーー ーーー ーーー ーーー ーーー ーーー ーーー ーーー';
/** The rule above the LINE signature. */
export const LINE_SIGNATURE_RULE = 'ーーー';

/** Used when the server has no From name (sending is not set up). */
export const DEFAULT_ORGANIZATION = '医学薬学祭実行委員会';

/** What the signature is made of (GET /api/signature, and MailSendOptions.signature). */
export interface SignatureParts {
  /** The committee's name (the From line). */
  organization: string;
  /** The person's name. */
  name: string;
  /** The title before the name: the one set by the person, or their department. Empty: the name alone. */
  title: string;
  /** The committee's address line (〒 …), or empty. */
  address: string;
  /** The committee's contact address (団体代表email), or empty. */
  contactEmail: string;
  /** The person's own address (委員個人email), or empty. */
  personalEmail: string;
}

/** GET /api/signature: the parts, and what the settings show and may change. */
export interface SignatureView extends SignatureParts {
  /** The title used when the person sets none (from their departments). */
  defaultTitle: string;
  /** What the person set (empty: not set). */
  own: { title: string; personalEmail: string };
  /** An access administrator may set the committee's lines. */
  canEditCommittee: boolean;
  /** When the person and the committee lines were last changed (ISO), or null. */
  updatedAt: string | null;
  committeeUpdatedAt: string | null;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f\u2028\u2029]/;
const EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

const line = (label: string, max: number) =>
  z
    .string()
    .transform((v) => v.normalize('NFC').trim())
    .refine((v) => !CONTROL.test(v), `${label}は 1 行で書いてください。`)
    .refine((v) => Array.from(v).length <= max, `${label}は ${max} 文字までです。`);
const email = (label: string) =>
  z
    .string()
    .transform((v) => v.trim())
    .refine((v) => v === '' || (v.length <= SIGNATURE_LIMITS.email && EMAIL.test(v)), `${label}はメールアドレスの形で書いてください（空欄なら行を出しません）。`);

/** PUT /api/signature: the person's own title and address (empty: not used). */
export const ownSignatureBody = z.strictObject({
  title: line('肩書き', SIGNATURE_LIMITS.title),
  personalEmail: email('個人のメールアドレス'),
});
export type OwnSignatureBody = z.infer<typeof ownSignatureBody>;

/** PUT /api/signature/committee: the committee's lines (access administrators). */
export const committeeSignatureBody = z.strictObject({
  address: line('住所の行', SIGNATURE_LIMITS.address),
  contactEmail: email('団体代表のメールアドレス'),
});
export type CommitteeSignatureBody = z.infer<typeof committeeSignatureBody>;

/**
 * The title for a person who set none: their departments without 役員会 (a meeting, not a title), the 課 when they
 * have one (the committee signs "会計課 〇〇", not "総務部・会計課 〇〇"). The role label is the departments joined
 * with "・", or "委員" with none (discord-auth/http.ts).
 */
export function defaultTitle(roleLabel: string): string {
  const parts = roleLabel
    .split('・')
    .map((p) => p.trim())
    .filter((p) => p && p !== '委員' && p !== '役員会');
  const sections = parts.filter((p) => p.endsWith('課'));
  return (sections.length > 0 ? sections : parts).join('・');
}

/** The mail signature. The same parts always give the same text (the form finds it again in the body). */
export function mailSignature(p: SignatureParts): string {
  const who = [p.title, p.name].map((s) => s.trim()).filter(Boolean).join(' ');
  const lines = [MAIL_SIGNATURE_RULE, '送信者', '', p.organization];
  if (who) lines.push(who);
  const contact = [
    p.address.trim(),
    p.contactEmail.trim() ? `団体代表email : ${p.contactEmail.trim()}` : '',
    p.personalEmail.trim() ? `委員個人email : ${p.personalEmail.trim()}` : '',
  ].filter(Boolean);
  if (contact.length > 0) lines.push('', ...contact);
  lines.push(MAIL_SIGNATURE_RULE);
  return lines.join('\n');
}

/** The official LINE signature: a rule, the committee, the title and name. */
export function lineSignature(p: Pick<SignatureParts, 'organization' | 'title' | 'name'>): string {
  const who = [p.title, p.name].map((s) => s.trim()).filter(Boolean).join(' ');
  return [LINE_SIGNATURE_RULE, p.organization, ...(who ? [who] : [])].join('\n');
}

/** The start of a new LINE message: room to write, then the signature. */
export function lineStart(p: Pick<SignatureParts, 'organization' | 'title' | 'name'>): string {
  return `\n\n${lineSignature(p)}`;
}

/** The text the person wrote: without the LINE signature it started with (when it is still there, unchanged). */
export function lineOwnText(body: string, signature: string | null): string {
  const text = body.replace(/\r\n/g, '\n');
  if (!signature) return text.trim();
  const at = text.lastIndexOf(signature);
  return (at >= 0 ? text.slice(0, at) + text.slice(at + signature.length) : text).trim();
}

/** The parts a page can use before it knows the person (or when the server has no signature): the name only. */
export function fallbackParts(organization: string, name: string, roleLabel = ''): SignatureParts {
  return { organization: organization || DEFAULT_ORGANIZATION, name, title: defaultTitle(roleLabel), address: '', contactEmail: '', personalEmail: '' };
}

// A rule line: the committee's ("ーーー ーーー …") or a long one of the Bot's drafts ("ーーーー…", "------").
const RULE_LINE = /^\s*(?:[ー─━－-]{6,}|ー{3}(?:[ \u3000]+ー{2,3})+)\s*$/;
const COMMITTEE_NAME = /医学薬学祭|医薬祭/;

/**
 * A draft's own signature block (the Bot writes one between two rules, with the committee's name in it) replaced by
 * the committee's signature; null when the draft has none (the caller then adds the signature after the text).
 */
export function replaceDraftSignature(text: string, signature: string, organization: string): string | null {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const rules = lines.map((l, i) => (RULE_LINE.test(l) ? i : -1)).filter((i) => i >= 0);
  const named = (from: number, to: number) => lines.slice(from, to).some((l) => (organization && l.includes(organization)) || COMMITTEE_NAME.test(l));
  for (let k = rules.length - 1; k >= 1; k--) {
    const start = rules[k - 1]!;
    const end = rules[k]!;
    if (end - start <= 10 && named(start + 1, end)) return [...lines.slice(0, start), signature, ...lines.slice(end + 1)].join('\n').trimEnd();
  }
  // One rule near the end, with the committee's name after it: the block runs to the end.
  const last = rules.at(-1);
  if (last !== undefined && lines.length - last <= 8 && named(last + 1, lines.length)) return [...lines.slice(0, last), signature].join('\n').trimEnd();
  return null;
}

/** A line that starts a signature (the mail checks look above it): "--", or a rule of ー (not a row of hyphens, which a body uses too). */
export function isSignatureRule(line: string): boolean {
  return /^\s*(?:--|ー{6,}|ー{3}(?:[ \u3000]+ー{2,3})+)\s*$/.test(line);
}
