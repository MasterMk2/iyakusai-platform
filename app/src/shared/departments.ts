/**
 * The order departments are shown in (2026-11-05): the organisation's order, each 部 followed by its 課, the same
 * as the Bot's task departments (bot/src/iyakusai_bot/task_domain.py). A person's departments ("総務部・会計課")
 * and the department choices of the screens follow it. Names outside the list come after it, in Japanese order.
 */
export const DEPARTMENT_ORDER: readonly string[] = [
  '役員会',
  '総務部', '会計課', 'システム課',
  '内務部', '企画課', '会場課',
  '外務部', '広報課', '渉外課',
];

const rank = (name: string): number => {
  const i = DEPARTMENT_ORDER.indexOf(name);
  return i === -1 ? DEPARTMENT_ORDER.length : i;
};

export function compareDepartments(a: string, b: string): number {
  return rank(a) - rank(b) || a.localeCompare(b, 'ja');
}
