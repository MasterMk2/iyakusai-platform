import { describe, expect, it } from 'vitest';
import { AssistantServiceClient, AssistantServiceError, DEFAULT_TIMEOUT_MS, LONG_WRITE_TIMEOUT_MS } from '../../src/server/assistant/client.js';
import { attachmentDisposition, browserJob, browserResult, safeDiscordUrl } from '../../src/server/assistant/routes.js';
import { ConfigError } from '../../src/server/auth.js';
import { loadConfig, parseAssistantConfig, type TaskGatewayConfig } from '../../src/server/config.js';
import type { AssistantJob } from '../../src/shared/assistant.js';
import { cleanText } from '../../src/shared/assistant.js';

const KEY = Buffer.alloc(32, 7);
const TASKS_ON: TaskGatewayConfig = { mode: 'on', serviceUrl: 'https://10.0.0.50:18431', key: KEY, bridgeText: null, linkFile: '/tmp/links.json' };
const TASKS_OFF: TaskGatewayConfig = { mode: 'off' };

describe('Bot tab configuration', () => {
  it('is off unless SMM_ASSISTANT_MODE says on', () => {
    expect(parseAssistantConfig({}, TASKS_ON)).toEqual({ mode: 'off' });
    expect(parseAssistantConfig({ SMM_ASSISTANT_MODE: 'off' }, TASKS_OFF)).toEqual({ mode: 'off' });
  });

  it('turns on with the task API URL and key, and nothing else', () => {
    expect(parseAssistantConfig({ SMM_ASSISTANT_MODE: 'on' }, TASKS_ON)).toEqual({ mode: 'on', serviceUrl: 'https://10.0.0.50:18431', key: KEY });
  });

  it('refuses on without the Bot-host task API, and unknown values', () => {
    expect(() => parseAssistantConfig({ SMM_ASSISTANT_MODE: 'on' }, TASKS_OFF)).toThrow(ConfigError);
    expect(() => parseAssistantConfig({ SMM_ASSISTANT_MODE: 'yes' }, TASKS_ON)).toThrow(ConfigError);
  });

  it('is checked at startup through loadConfig as well', () => {
    expect(loadConfig({}).assistant).toEqual({ mode: 'off' });
    expect(() => loadConfig({ SMM_ASSISTANT_MODE: 'on' })).toThrow(ConfigError);
  });

  it('keeps the timeouts from the contract (8 s reads, 12 s reminder and candidate writes)', () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(8_000);
    expect(LONG_WRITE_TIMEOUT_MS).toBe(12_000);
  });
});

describe('browser links and downloads', () => {
  it('passes only https Discord message links', () => {
    expect(safeDiscordUrl('https://discord.com/channels/1000000000000000010/1000000000000000011')).toBe('https://discord.com/channels/1000000000000000010/1000000000000000011');
    expect(safeDiscordUrl('https://ptb.discordapp.com/channels/@me/1000000000000000011/1000000000000000012')).not.toBeNull();
    for (const bad of ['http://discord.com/channels/1/2', 'https://evil.example/channels/1/2', 'javascript:alert(1)', 'https://discord.com/channels/1/2"><script>', null]) {
      expect(safeDiscordUrl(bad)).toBeNull();
    }
  });

  it('builds an attachment name with an ASCII fallback and the RFC 5987 name', () => {
    expect(attachmentDisposition('回答 (1).docx')).toBe(`attachment; filename="__ (1).docx"; filename*=UTF-8''${encodeURIComponent('回答 (1).docx').replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`);
    expect(attachmentDisposition('a"b;c.txt')).toContain('filename="a_b_c.txt"');
  });

  it('keeps only allowed file types and rebuilds their links', () => {
    const job = {
      id: 'j_00000000000000000001',
      result: {
        text: 'x',
        files: [
          { name: 'a.png', mime: 'image/png; name=a', size: 1, url: 'ignored' },
          { name: 'b.html', mime: 'text/html', size: 1, url: 'ignored' },
          { name: 'c.md', mime: 'TEXT/MARKDOWN', size: 1, url: 'ignored' },
        ],
      },
    } as unknown as AssistantJob;
    expect(browserResult(job)!.files).toEqual([
      { name: 'a.png', mime: 'image/png', size: 1, url: '/api/assistant/files/j_00000000000000000001/a.png' },
      { name: 'c.md', mime: 'text/markdown; charset=utf-8', size: 1, url: '/api/assistant/files/j_00000000000000000001/c.md' },
    ]);
    const shaped = browserJob({ ...job, discordUrl: 'https://evil.example/x' } as AssistantJob);
    expect(shaped.discordUrl).toBeNull();
  });
});

describe('text cleaning (contract §3-4)', () => {
  it('trims and removes control characters except tab, carriage return and line feed', () => {
    expect(cleanText('  a\u0000b\u0007\tc\r\nd\u007f  ')).toBe('ab\tc\r\nd');
  });
});

describe('file relay from the Bot host', () => {
  const fileResponse = (body: ReadableStream<Uint8Array>, length: string) =>
    new Response(body, { status: 200, headers: { 'content-type': 'image/png', 'content-length': length } });
  const clientWith = (response: () => Response) =>
    new AssistantServiceClient({ baseUrl: 'https://10.0.0.50:18431', key: KEY, fetchImpl: async () => response() });

  it('passes a complete file', async () => {
    const bytes = new Uint8Array([137, 80, 78, 71]);
    const client = clientWith(() => fileResponse(new Blob([bytes]).stream(), '4'));
    const file = await client.file('discord-1000000000000000001', 'j_aaaaaaaaaaaaaaaaaaaa', 'a.png');
    expect([...file.body]).toEqual([...bytes]);
    expect(file.mime).toBe('image/png');
  });

  it('refuses a file shorter than declared or cut mid-way, instead of passing it on as complete', async () => {
    const short = clientWith(() => fileResponse(new Blob([new Uint8Array([1, 2])]).stream(), '4'));
    await expect(short.file('discord-1000000000000000001', 'j_aaaaaaaaaaaaaaaaaaaa', 'a.png')).rejects.toBeInstanceOf(AssistantServiceError);
    const cut = clientWith(() =>
      fileResponse(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(new Uint8Array([1]));
            controller.error(new Error('connection reset'));
          },
        }),
        '4',
      ),
    );
    await expect(cut.file('discord-1000000000000000001', 'j_aaaaaaaaaaaaaaaaaaaa', 'a.png')).rejects.toMatchObject({ kind: 'unavailable' });
  });
});