import { dateFindings, placeholders, type ScreenFinding } from './mailScreen.js';

// Checks before an official LINE message goes out, like the mail ones (2026-11-09). Fixed rules, no AI: half-written
// places, a date whose weekday is wrong, an image named but not attached, one person's name or a personal greeting
// in a message that goes to several people, and recipients whose friendship is not confirmed. A mail's signature and
// addressee checks are left out: a LINE message comes from the account and usually has neither. Nothing here blocks
// a send (the person decides).

export interface LineScreenInput {
  /** The text as it will be sent (the server's preview). */
  body: string;
  /** Whom it goes to: the conversation's name, and whether the person is a known friend (false: not confirmed). */
  recipients: { title: string; friend?: boolean }[];
  /** Images or files go with the text. */
  attached: boolean;
  now?: Date;
}

// A greeting meant for everyone is fine in a message to several people.
const EVERYONE = /皆|みな|みんな|各位|関係者|担当者|お客/;
const GREETING = /([^\s、。,，!！?？「」『』（）()]{1,12}?)(様|さま|さん|くん|君|殿|ちゃん)(?=$|[\s、。,，!！?？])/;

export function screenLine(input: LineScreenInput): ScreenFinding[] {
  const now = input.now ?? new Date();
  const text = input.body.replace(/\r\n/g, '\n');
  const out: ScreenFinding[] = [];

  const holes = placeholders(text);
  if (holes.length > 0) out.push({ level: 'warning', text: `書きかけの箇所が残っているようです：${holes.slice(0, 5).join('、')}` });
  out.push(...dateFindings(text, now));
  if (/画像|写真|添付/.test(text) && !input.attached) out.push({ level: 'warning', text: '本文に「画像」「写真」「添付」とありますが、画像もファイルも付いていません。' });

  if (input.recipients.length > 1) {
    // Each person gets the same text: a name of one of them, or a personal greeting, is seen by all.
    const named = [...new Set(input.recipients.map((r) => r.title.trim()).filter((t) => Array.from(t).length >= 2 && text.includes(t)))];
    if (named.length > 0) {
      out.push({ level: 'warning', text: `${input.recipients.length} 人に同じ文が届きます。本文にある「${named.slice(0, 3).join('」「')}」の名前は、ほかの相手にも見えます。` });
    } else {
      const head = text.split('\n').filter((l) => l.trim()).slice(0, 2);
      const greeting = head.map((l) => GREETING.exec(l.trim())).find((m) => m && !EVERYONE.test(m[1]!));
      if (greeting) out.push({ level: 'info', text: `${input.recipients.length} 人に同じ文が届きます。冒頭の「${greeting[0]}」は全員に同じように見えます。` });
    }
  }

  const unconfirmed = input.recipients.filter((r) => r.friend === false).length;
  if (unconfirmed > 0) {
    out.push({ level: 'info', text: `友だち登録が確認できない相手が ${unconfirmed} 人います。友だち解除・ブロックされていると届きません。` });
  }
  return out;
}
