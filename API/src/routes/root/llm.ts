import type { FastifyInstance } from 'fastify';

import { llmAvatarsMarkdown } from './llm-avatars.js';
import { llmBillingMarkdown } from './llm-billing.js';
import { llmIntegrationMarkdown } from './llm-integration.js';
import { llmIntegrationMarkdown2 } from './llm-integration-2.js';
import { llmIntroMarkdown } from './llm-intro.js';
import { llmSignaturesMarkdown } from './llm-signatures.js';

function renderLlmMarkdown(): string {
  // llmIntegrationMarkdown owns both confidential subject profiles: one-time
  // source assertions and reusable, audience-bound chained access tokens.
  return `Optional signed config claim \`login_restart_url\`: client sign-in initiation URL, same origin as an allowed redirect, HTTPS (HTTP loopback only). Auth returns there after password reset and offers it when login has no PKCE. The client must generate fresh PKCE; never point this at a code callback. Clients without the claim keep the previous behavior.\n\n${llmIntroMarkdown}\n${llmIntegrationMarkdown}\n${llmIntegrationMarkdown2}\n${llmBillingMarkdown}\n${llmSignaturesMarkdown}\n${llmAvatarsMarkdown}`;
}

export function registerLlmRoute(app: FastifyInstance): void {
  app.get('/llm', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.type('text/markdown; charset=utf-8').send(renderLlmMarkdown());
  });
}
