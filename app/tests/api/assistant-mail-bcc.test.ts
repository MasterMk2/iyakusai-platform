import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { AssistantServiceClient } from '../../src/server/assistant/client.js';
import { registerAssistantRoutes } from '../../src/server/assistant/routes.js';
import type { User } from '../../src/server/domain/types.js';
import { parseTaskBridge } from '../../src/server/tasks/bridge.js';
import { startAssistantFake, type AssistantFake } from '../assistant-fake.js';

// The mail screen's BCC address comes from the mailbox settings (draftBccAddress), added by this server to the
// Bot host's meta. Without the setting the meta is passed through unchanged, and the screen leaves the sentence out.

const BRIDGE = parseTaskBridge(JSON.stringify({ version: 1, bindings: [{ principalId: 'editor-a', taskUserId: 'user-member-a1' }] }));
let fake: AssistantFake;
let app: FastifyInstance;

async function start(mailDraftBcc: string | null) {
  fake = await startAssistantFake();
  const client = new AssistantServiceClient({ baseUrl: fake.url, key: fake.key, timeoutMs: 2_000, longTimeoutMs: 3_000 });
  app = Fastify();
  registerAssistantRoutes(app, {
    assistant: { client, bridge: BRIDGE },
    mailDraftBcc,
    parse: (schema, value) => schema.parse(value),
    requireUser: () => ({ id: 'editor-a', disabled: false }) as User,
  });
  await app.ready();
}

afterEach(async () => {
  await app.close();
  await fake.close();
});

describe('mail-draft BCC address in the assistant meta', () => {
  it('adds the configured address', async () => {
    await start('archive@committee.example');
    const res = await app.inject({ method: 'GET', url: '/api/assistant/meta' });
    expect(res.statusCode).toBe(200);
    expect(res.json().mailBcc).toBe('archive@committee.example');
    expect(res.json().features.ask).toBe(true);
  });

  it('passes the meta through unchanged without the setting', async () => {
    await start(null);
    const res = await app.inject({ method: 'GET', url: '/api/assistant/meta' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).not.toHaveProperty('mailBcc');
  });
});
