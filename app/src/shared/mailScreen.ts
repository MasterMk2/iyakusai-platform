// Checks before a committee mail goes out (is the signature there, and the like).
// Fixed rules, no AI: the signature and the addressee line, half-written places, attachments named but not
// attached, a date whose weekday is wrong, the From address among the recipients, an empty body, a reply-to
// address outside the committee. The screen
// shows what it finds before sending; nothing here blocks a send (the person decides).

export interface ScreenInput {
  subject: string;
  body: string;
  to: { name: string | null; address: string }[];
  cc: { name: string | null; address: string }[];
  /** The reply-to address, when one other than From is given. */
  replyTo?: { name: string | null; address: string } | null;
  fromAddress: string;
  /** The committee's name as the From line writes it (the signature should carry it). */
  fromName: string;
  attachments: number;
  now?: Date;
}

export interface ScreenFinding {
  level: 'warning' | 'info';
  text: string;
}

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
const ADDRESSEE = /(様|御中|各位|先生|殿|さん|ご担当|御担当)/;
// What may follow a half-written 【…】 on its line: nothing, or a particle / honorific / punctuation (not a value).
const PLACEHOLDER_AFTER = /^(\s*$|[様、。，．,.」』）)のをにがはとでへもやかなど]|御中|殿)/;

/** The person's own text: without quoted lines (">") of the mail being answered. */
export function ownText(body: string): string {
  return body
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((l) => !/^\s*>/.test(l))
    .join('\n');
}

/** The text above the signature separator ("--" on its own line), if there is one. */
function aboveSignature(text: string): string {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => /^\s*--\s*$/.test(l));
  return (at >= 0 ? lines.slice(0, at) : lines).join('\n');
}

function daysIn(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** The year a "M月D日" without a year most likely means: the one that puts the date nearest to now. */
function nearestYear(month: number, day: number, now: Date): number {
  const y = Number(now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' }).slice(0, 4));
  let best = y;
  let gap = Infinity;
  for (const year of [y - 1, y, y + 1]) {
    const d = Math.abs(Date.UTC(year, month - 1, Math.min(day, daysIn(year, month))) - now.getTime());
    if (d < gap) {
      gap = d;
      best = year;
    }
  }
  return best;
}

function dateFindings(text: string, now: Date): ScreenFinding[] {
  const out: ScreenFinding[] = [];
  const seen = new Set<string>();
  const patterns = [
    /(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*[（(]\s*([日月火水木金土])\s*(?:曜日?)?\s*[）)]/g,
    /(?:(\d{4})\s*\/\s*)?(\d{1,2})\s*\/\s*(\d{1,2})\s*[（(]\s*([日月火水木金土])\s*(?:曜日?)?\s*[）)]/g,
  ];
  for (const pattern of patterns) {
    for (const m of text.normalize('NFKC').matchAll(pattern)) {
      const written = m[0].trim();
      if (seen.has(written)) continue;
      seen.add(written);
      const month = Number(m[2]);
      const day = Number(m[3]);
      if (month < 1 || month > 12 || day < 1) {
        out.push({ level: 'warning', text: `「${written}」は日付として読めません。` });
        continue;
      }
      const year = m[1] ? Number(m[1]) : nearestYear(month, day, now);
      if (day > daysIn(year, month)) {
        out.push({ level: 'warning', text: `「${written}」の日はありません（${year}年${month}月は${daysIn(year, month)}日まで）。` });
        continue;
      }
      const actual = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()]!;
      if (actual !== m[4]) out.push({ level: 'warning', text: `「${written}」の曜日が違います（${year}年${month}月${day}日は${actual}曜日）。` });
    }
  }
  return out;
}

function placeholders(text: string): string[] {
  const found: string[] = [];
  for (const line of text.split('\n')) {
    for (const m of line.matchAll(/【([^】]{0,30})】/g)) {
      const after = line.slice((m.index ?? 0) + m[0].length);
      if (!m[1]!.trim() || PLACEHOLDER_AFTER.test(after)) found.push(m[0]);
    }
    for (const m of line.matchAll(/[〇○◯]{2,}|[×✕]{2,}|ＸＸ|(?<![A-Za-z])XX(?![A-Za-z])/g)) found.push(m[0]);
  }
  return [...new Set(found)];
}

export function screenMail(input: ScreenInput): ScreenFinding[] {
  const now = input.now ?? new Date();
  const own = ownText(input.body);
  const main = aboveSignature(own);
  const out: ScreenFinding[] = [];

  if (!own.includes(input.fromName) && !/医学薬学祭|医薬祭/.test(own)) {
    out.push({ level: 'warning', text: `署名が見当たりません（「${input.fromName}」の名前が本文にありません）。` });
  }
  // The addressee is often two lines ("株式会社〇〇" / "営業部 〇〇様"): the first three lines count.
  const head = main.split('\n').filter((l) => l.trim()).slice(0, 3);
  if (!head.some((l) => ADDRESSEE.test(l))) out.push({ level: 'warning', text: '本文の冒頭に宛名（「〇〇様」「〇〇御中」など）が見当たりません。' });
  if (main.replace(/\s+/g, '').length < 15) out.push({ level: 'warning', text: '本文がほとんど書かれていません。' });
  const holes = placeholders(`${input.subject}\n${own}`);
  if (holes.length > 0) out.push({ level: 'warning', text: `書きかけの箇所が残っているようです：${holes.slice(0, 5).join('、')}` });
  const mentions = /添付|別添|同封/.test(own);
  if (mentions && input.attachments === 0) out.push({ level: 'warning', text: '本文に「添付」とありますが、ファイルが付いていません。' });
  if (!mentions && input.attachments > 0) out.push({ level: 'info', text: '添付ファイルがありますが、本文では触れていません。' });
  out.push(...dateFindings(`${input.subject}\n${own}`, now));
  const self = input.fromAddress.toLowerCase();
  if ([...input.to, ...input.cc].some((a) => a.address.toLowerCase() === self)) out.push({ level: 'warning', text: '宛先か CC に、差出人と同じアドレスがあります。' });
  // Answers to an address on another domain do not come back into the committee's mailboxes.
  const domain = (address: string) => address.slice(address.lastIndexOf('@') + 1).toLowerCase();
  if (input.replyTo && domain(input.replyTo.address) !== domain(input.fromAddress)) {
    out.push({ level: 'warning', text: `返信先（${input.replyTo.address}）が委員会の外のアドレスです。相手の返信は委員会の受信箱に入りません。` });
  }
  return out;
}
