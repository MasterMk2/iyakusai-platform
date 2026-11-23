import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError } from '../../src/server/auth.js';
import { loadSiteEditorConfig, validateSiteEditorConfig } from '../../src/server/site-editor/config.js';

// site-editor.json (synthetic keys and names only).

const KEY_HEX = 'c3'.repeat(16) + 'd4'.repeat(16);
const KEY = Buffer.from(KEY_HEX, 'hex');
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'iyakusai-site-editor-config-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function place(json: (keyFile: string) => unknown, key = KEY_HEX): string {
  const keyFile = path.join(dir, 'site-editor.key');
  writeFileSync(keyFile, `${key}\n`);
  chmodSync(keyFile, 0o600);
  writeFileSync(path.join(dir, 'site-editor.json'), JSON.stringify(json(keyFile)));
  return path.join(dir, 'mail.json');
}

describe('site-editor.json', () => {
  it('is off without the file', () => {
    expect(loadSiteEditorConfig(path.join(dir, 'mail.json'))).toBeNull();
  });

  it('reads the server, the key, the site and who may edit or publish', () => {
    const config = loadSiteEditorConfig(
      place((keyFile) => ({ version: 1, upstream: 'http://wge:8080/', keyFile, siteUrl: 'https://site.example.invalid/wge/', editors: { departments: ['総務部', ' 総務部 '], userIds: ['21000002'] }, publishers: { userIds: ['21000003'] } })),
    );
    expect(config).toEqual({
      upstream: 'http://wge:8080',
      key: KEY,
      siteUrl: 'https://site.example.invalid/wge/',
      editors: { everyone: false, departments: ['総務部'], userIds: ['21000002'] },
      publishers: { departments: [], userIds: ['21000003'] },
    });
    expect(validateSiteEditorConfig({ version: 1, upstream: 'http://wge:8080' }, KEY)).toMatchObject({ siteUrl: null, editors: { everyone: false, departments: [], userIds: [] } });
    expect(validateSiteEditorConfig({ version: 1, upstream: 'http://wge:8080', editors: { everyone: true } }, KEY).editors.everyone).toBe(true);
    // Everyone is for writing only: publishing is always chosen.
    expect(() => validateSiteEditorConfig({ version: 1, upstream: 'http://wge:8080', publishers: { everyone: true } }, KEY)).toThrow(/知らない項目/);
    expect(() => validateSiteEditorConfig({ version: 1, upstream: 'http://wge:8080', editors: { everyone: 'yes' } }, KEY)).toThrow(/everyone/);
  });

  it('refuses an upstream with a path, a query or a user name, and a site that is not http(s)', () => {
    for (const upstream of ['http://wge:8080/api', 'http://wge:8080/?a=1', 'http://user:pw@wge:8080', 'ftp://wge:8080', 'wge:8080', '']) {
      expect(() => validateSiteEditorConfig({ version: 1, upstream }, KEY), upstream).toThrow(ConfigError);
    }
    expect(() => validateSiteEditorConfig({ version: 1, upstream: 'http://wge:8080', siteUrl: 'javascript:alert(1)' }, KEY)).toThrow(/siteUrl/);
  });

  it('refuses unknown fields, a wrong version and bad lists of people', () => {
    expect(() => validateSiteEditorConfig({ version: 1, upstream: 'http://wge:8080', extra: 1 }, KEY)).toThrow(/知らない項目/);
    expect(() => validateSiteEditorConfig({ version: 2, upstream: 'http://wge:8080' }, KEY)).toThrow(/version/);
    expect(() => validateSiteEditorConfig({ version: 1, upstream: 'http://wge:8080', editors: { roles: [] } }, KEY)).toThrow(/知らない項目/);
    expect(() => validateSiteEditorConfig({ version: 1, upstream: 'http://wge:8080', editors: { departments: 'X' } }, KEY)).toThrow(ConfigError);
    expect(() => validateSiteEditorConfig({ version: 1, upstream: 'http://wge:8080', publishers: { userIds: ['a\nb'] } }, KEY)).toThrow(ConfigError);
  });

  it('refuses a short key and a missing key file, naming no secret', () => {
    expect(() => loadSiteEditorConfig(place((keyFile) => ({ version: 1, upstream: 'http://wge:8080', keyFile }), 'abcd'))).toThrow(/32 バイト/);
    expect(() => loadSiteEditorConfig(place(() => ({ version: 1, upstream: 'http://wge:8080', keyFile: path.join(dir, 'missing.key') })))).toThrow(/読み込めません/);
    try {
      loadSiteEditorConfig(place((keyFile) => ({ version: 1, upstream: 'http://wge:8080', keyFile }), 'abcd'));
    } catch (err) {
      expect(String((err as Error).message)).not.toContain('abcd');
    }
  });
});
