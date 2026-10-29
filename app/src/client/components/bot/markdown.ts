// Discord Markdown subset of the Bot's answers (../docs/contracts/bot-front.md §3-1): **bold**, `-#`
// small lines, bullet lists and links. This is a plain parser into a tree of text, so no HTML is ever
// produced: the screen renders each piece as text (React escapes it), and only http(s) URLs become links.

export type BotInline = { kind: 'text'; text: string } | { kind: 'bold'; text: string } | { kind: 'link'; text: string; href: string };

export type BotBlock =
  | { kind: 'paragraph'; lines: BotInline[][] }
  | { kind: 'small'; inline: BotInline[] }
  | { kind: 'list'; items: BotInline[][] };

const TOKEN = /\*\*([^*\n]{1,500}?)\*\*|\[([^\]\n]{1,200})\]\((https?:\/\/[^\s()<>]{1,2000})\)|(https?:\/\/[^\s<>"'`]{1,2000})/g;
const TRAILING_PUNCTUATION = /[.,;:!?。、）)」』]+$/;

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/** One line of text: bold, links and plain text. Anything else stays plain text. */
export function parseInline(line: string): BotInline[] {
  const out: BotInline[] = [];
  let last = 0;
  for (const match of line.matchAll(TOKEN)) {
    const start = match.index ?? 0;
    if (start > last) out.push({ kind: 'text', text: line.slice(last, start) });
    last = start + match[0].length;
    if (match[1] !== undefined) {
      out.push({ kind: 'bold', text: match[1] });
    } else if (match[2] !== undefined && match[3] !== undefined && isHttpUrl(match[3])) {
      out.push({ kind: 'link', text: match[2], href: match[3] });
    } else if (match[4] !== undefined) {
      // A bare URL: the trailing punctuation of a sentence is not part of the link.
      const raw = match[4];
      const trimmed = raw.replace(TRAILING_PUNCTUATION, '');
      if (isHttpUrl(trimmed)) {
        out.push({ kind: 'link', text: trimmed, href: trimmed });
        if (trimmed.length < raw.length) out.push({ kind: 'text', text: raw.slice(trimmed.length) });
      } else {
        out.push({ kind: 'text', text: raw });
      }
    } else {
      out.push({ kind: 'text', text: match[0] });
    }
  }
  if (last < line.length) out.push({ kind: 'text', text: line.slice(last) });
  return out;
}

/** The whole answer: blank lines separate blocks; `-# ` lines are small; `- ` and `* ` lines form a list. */
export function parseBotText(text: string): BotBlock[] {
  const blocks: BotBlock[] = [];
  // Open blocks, kept in one object so every change to them is visible in this function.
  const open: { paragraph: BotInline[][] | null; list: BotInline[][] | null } = { paragraph: null, list: null };
  const closeOpen = () => {
    if (open.paragraph) blocks.push({ kind: 'paragraph', lines: open.paragraph });
    if (open.list) blocks.push({ kind: 'list', items: open.list });
    open.paragraph = null;
    open.list = null;
  };
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (line.trim() === '') {
      closeOpen();
      continue;
    }
    if (line.startsWith('-# ')) {
      closeOpen();
      blocks.push({ kind: 'small', inline: parseInline(line.slice(3)) });
      continue;
    }
    const bullet = /^[-*] (.*)$/.exec(line);
    if (bullet) {
      if (open.paragraph) {
        blocks.push({ kind: 'paragraph', lines: open.paragraph });
        open.paragraph = null;
      }
      const items: BotInline[][] = open.list ?? [];
      items.push(parseInline(bullet[1]!));
      open.list = items;
      continue;
    }
    if (open.list) {
      blocks.push({ kind: 'list', items: open.list });
      open.list = null;
    }
    const lines: BotInline[][] = open.paragraph ?? [];
    lines.push(parseInline(line));
    open.paragraph = lines;
  }
  closeOpen();
  return blocks;
}
