import { readFileSync, statSync } from 'node:fs';

// Real names of accounts, maintained by the operator outside Git (personal data): a JSON file
// { "version": 1, "names": { "<Discord user ID>": "氏名" } }. It is re-read when it changes, so a
// corrected name shows without a restart. A missing or invalid file shows no names (never guessed).

const UID = /^[1-9]\d{16,19}$/;

/**
 * Student IDs of committee members, from the committee's own documents, maintained like the name
 * roster: { "version": 1, "studentIds": { "<Discord user ID>": "<student ID>" } }. Invalid entries are
 * ignored; a missing file assigns nothing.
 */
export class StudentIdRoster {
  private cache: { mtimeMs: number; size: number; ids: Map<string, string> } | null = null;

  constructor(
    private readonly file: string | null,
    private readonly normalize: (value: string) => string | null,
  ) {}

  studentIdOf(discordUserId: string): string | null {
    if (!this.file) return null;
    try {
      const stat = statSync(this.file);
      if (!this.cache || this.cache.mtimeMs !== stat.mtimeMs || this.cache.size !== stat.size) {
        const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as { version?: unknown; studentIds?: Record<string, unknown> };
        const ids = new Map<string, string>();
        const seen = new Set<string>();
        if (parsed.version === 1 && parsed.studentIds && typeof parsed.studentIds === 'object') {
          for (const [uid, value] of Object.entries(parsed.studentIds)) {
            const id = typeof value === 'string' ? this.normalize(value) : null;
            // One student ID per person: a duplicated ID is ignored for everyone it names.
            if (!UID.test(uid) || !id) continue;
            if (seen.has(id)) {
              for (const [k, v] of ids) if (v === id) ids.delete(k);
              continue;
            }
            seen.add(id);
            ids.set(uid, id);
          }
        }
        this.cache = { mtimeMs: stat.mtimeMs, size: stat.size, ids };
      }
      return this.cache.ids.get(discordUserId) ?? null;
    } catch {
      return null;
    }
  }
}

export class NameRoster {
  private cache: { mtimeMs: number; size: number; names: Map<string, string> } | null = null;

  constructor(private readonly file: string | null) {}

  nameOf(discordUserId: string): string | null {
    if (!this.file) return null;
    try {
      const stat = statSync(this.file);
      if (!this.cache || this.cache.mtimeMs !== stat.mtimeMs || this.cache.size !== stat.size) {
        const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as { version?: unknown; names?: Record<string, unknown> };
        const names = new Map<string, string>();
        if (parsed.version === 1 && parsed.names && typeof parsed.names === 'object') {
          for (const [uid, name] of Object.entries(parsed.names)) {
            if (UID.test(uid) && typeof name === 'string' && name.trim() && name.length <= 60) names.set(uid, name.trim());
          }
        }
        this.cache = { mtimeMs: stat.mtimeMs, size: stat.size, names };
      }
      return this.cache.names.get(discordUserId) ?? null;
    } catch {
      return null;
    }
  }
}
