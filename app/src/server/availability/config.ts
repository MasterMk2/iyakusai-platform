import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ConfigError } from '../auth.js';
import { readServiceAccountKey, type ServiceAccountKey } from '../google/service-account.js';

// Free/busy from members' Google calendars (2026-11-20): an operator file `availability.json` next to the mailbox
// configuration (SMM_MAIL_CONFIG), like books-sheets.json. Absent, the feature is off (no screen offers it).
//
//   { "version": 1, "serviceAccountKeyFile": "<a JSON key>", "refreshMinutes": 15, "horizonDays": 42 }
//
// The key is a Google Cloud service account's JSON key (the Calendar API enabled in its project). Members share
// their calendars with the account's address as "予定の表示（時間枠のみ、詳細は非表示）"; the account has no other
// access. It may be the same account as the books' spreadsheet. refreshMinutes: how often Google is asked (5–120).
// horizonDays: how many days from today are read (7–60).

export const AVAILABILITY_CONFIG_FILE = 'availability.json';
const KNOWN = new Set(['version', 'serviceAccountKeyFile', 'refreshMinutes', 'horizonDays']);

export interface AvailabilityConfig {
  key: ServiceAccountKey;
  refreshMinutes: number;
  horizonDays: number;
}

const intIn = (value: unknown, fallback: number, min: number, max: number, name: string): number => {
  const v = value ?? fallback;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new ConfigError(`${name} は ${min}〜${max} の整数にしてください。`);
  return v;
};

/** Validates the document; the key is passed by the caller (tests give a generated one). */
export function validateAvailabilityConfig(raw: unknown, key: ServiceAccountKey): AvailabilityConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigError(`${AVAILABILITY_CONFIG_FILE} はオブジェクトで指定してください。`);
  const o = raw as Record<string, unknown>;
  const unknown = Object.keys(o).filter((k) => !KNOWN.has(k));
  if (unknown.length > 0) throw new ConfigError(`${AVAILABILITY_CONFIG_FILE} に不明な項目があります: ${unknown.join(', ')}`);
  if (o.version !== 1) throw new ConfigError(`${AVAILABILITY_CONFIG_FILE} の version は 1 にしてください。`);
  return { key, refreshMinutes: intIn(o.refreshMinutes, 15, 5, 120, 'refreshMinutes'), horizonDays: intIn(o.horizonDays, 42, 7, 60, 'horizonDays') };
}

/** availability.json next to the mailbox configuration, or null when there is none (the feature is off). */
export function loadAvailabilityConfig(mailConfigFile: string): AvailabilityConfig | null {
  const file = join(dirname(resolve(mailConfigFile)), AVAILABILITY_CONFIG_FILE);
  if (!existsSync(file)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    throw new ConfigError(`${AVAILABILITY_CONFIG_FILE} を JSON として読み込めません。`);
  }
  const keyFile = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>).serviceAccountKeyFile : undefined;
  return validateAvailabilityConfig(raw, readServiceAccountKey(keyFile));
}
