// 期限は日付のみで扱う。「今日」は委員会の運用地域に合わせて Asia/Tokyo で判定する。

export const DEADLINE_TIME_ZONE = 'Asia/Tokyo';
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

export function isValidDateOnly(value: string): boolean {
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (year < 2000 || year > 2100) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function todayInTimeZone(now: Date, timeZone = DEADLINE_TIME_ZONE): string {
  // en-CA は YYYY-MM-DD 形式で出力される。
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export function addDays(dateOnly: string, days: number): string {
  const match = DATE_PATTERN.exec(dateOnly);
  if (!match) throw new Error(`Invalid date: ${dateOnly}`);
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days));
  return date.toISOString().slice(0, 10);
}

export function formatDateOnly(dateOnly: string | null): string {
  if (dateOnly === null) return '期限なし';
  const match = DATE_PATTERN.exec(dateOnly);
  if (!match) return dateOnly;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return `${match[1]}/${match[2]}/${match[3]}（${WEEKDAYS[date.getUTCDay()]}）`;
}

export function isOverdue(deadline: string | null, status: string, today: string): boolean {
  return deadline !== null && status !== 'done' && deadline < today;
}

export function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const parts = new Intl.DateTimeFormat('ja-JP', {
    timeZone: DEADLINE_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
  return parts;
}
