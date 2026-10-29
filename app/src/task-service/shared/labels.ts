import type { ChangeSource, RequirementField, Role, TaskField, TaskStatus } from './types.js';

export const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: '未着手',
  in_progress: '進行中',
  blocked: '保留',
  done: '完了',
};

export const ROLE_LABELS: Record<Role, string> = {
  viewer: '閲覧者',
  editor: '編集者',
  admin: '管理者',
};

export const REQUIREMENT_LABELS: Record<RequirementField, string> = {
  purpose: '目的',
  deliverable: '成果物',
  completionCriteria: '完了条件',
  openQuestions: '不明点',
};

export const FIELD_LABELS: Record<TaskField, string> = {
  title: 'タイトル',
  description: '説明',
  assigneeId: '担当者',
  deadline: '期限',
  status: '状態',
  ...REQUIREMENT_LABELS,
};

export const SOURCE_LABELS: Record<ChangeSource, string> = {
  web: 'Web',
  'mock-bot': '模擬Bot',
  discord: 'Discord',
  system: 'サンプル初期化',
};
