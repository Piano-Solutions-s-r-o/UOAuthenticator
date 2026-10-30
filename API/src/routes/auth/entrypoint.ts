import type { FastifyInstance } from 'fastify';

import { AppError } from '../../utils/errors.js';
import { configVerifier } from '../../middleware/config-verifier.js';
import {
  readAuthUiAsset,
  renderAuthEntrypointHtml,
  sendAuthHtml,
} from '../../services/auth-ui.service.js';
import { configFetchRateLimiter } from './rate-limit-keys.js';
import { recordAuthFunnelStep } from '../../services/auth-funnel.service.js';
import {
  hasS256Challenge,
  resolveRegistrationHandoff,
} from '../../services/registration-handoff.service.js';

// Gap-fix B Task 2 (design §11.4): `team_hint` is a client-side chooser preselect ONLY — it never
// grants anything server-side (select-team's ACTIVE-membership + domain check remains the sole
// authority). Bound to a conservative id/slug-safe charset; anything else is silently dropped
// before the querystring reaches the SPA bootstrap rather than rejecting the whole request.
const TEAM_HINT_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;

// UOA re-renders this window mid-flow (2FA, team chooser, invite and email-link continuations). Only
// a render without any of these is a product starting a flow, which is what the funnel counts.
const CONTINUATION_QUERY_KEYS = [
  'email_token',
  'enterprise_link_intent',
  'flow',
  'handoff_target',
  'invite_token',
  'login_token',
  'management_org_id',
  'request_access_status',
  'signing_token',
  'twofa_enroll_required',
  'twofa_setup_token',
  'twofa_token',
] as const;

/**
 * The funnel outcome for a render of the window, or null for a mid-flow re-render. HUGO-1850:
 * `prompt=create` opens account creation first, so those starts are counted apart.
 */
export function flowStartOutcome(query: unknown): 'shown' | 'shown_register' | null {
  const params = query && typeof query === 'object' ? (query as Record<string, unknown>) : {};
  if (CONTINUATION_QUERY_KEYS.some((key) => key in params)) return null;
  const prompt = typeof params.prompt === 'string' ? params.prompt : '';
  return prompt.split(' ').includes('create') ? 'shown_register' : 'shown';
}

/**
 * Strips an invalid `team_hint` from the raw request URL before it becomes the SPA's initial
 * bootstrap state. Deliberately a no-op fast path when `team_hint` is absent or already valid, so
 * the byte-identical guarantee for `workspace_selection: "off"` (which never even reads the hint)
 * holds regardless of validation — this only ever rewrites the edge case being rejected.
 */
export function sanitizeTeamHintInUrl(rawUrl: string): string {
  const qIdx = rawUrl.indexOf('?');
  if (qIdx === -1) return rawUrl;

  const query = rawUrl.slice(qIdx + 1);
  if (!query.includes('team_hint')) return rawUrl;

  const params = new URLSearchParams(query);
  const hint = params.get('team_hint');
  if (hint === null || TEAM_HINT_PATTERN.test(hint)) return rawUrl;

  params.delete('team_hint');
  const rest = params.toString();
  return rest ? `${rawUrl.slice(0, qIdx)}?${rest}` : rawUrl.slice(0, qIdx);
}

export function registerAuthEntrypointRoute(app: FastifyInstance): void {
  // OAuth popup entrypoint. This must start by fetching the config JWT from a URL supplied by the client.
  app.get(
    '/auth',
    {
      preHandler: [configFetchRateLimiter, configVerifier],
    },
    async (request, reply) => {
      if (!request.config || !request.configUrl) {
        throw new AppError('BAD_REQUEST', 400, 'MISSING_CONFIG');
      }

      const requestUrl = sanitizeTeamHintInUrl(request.raw.url ?? '');
      const start = flowStartOutcome(request.query);
      // HUGO-2261: a browser that opened a registration link finishes it here, on the product's
      // fresh sign-in. Anything else about the cookie is ignored, and the window stays as it was.
      const handoff =
        start && hasS256Challenge(request.query)
          ? await resolveRegistrationHandoff(
              { request, config: request.config, configUrl: request.configUrl },
              request.adminDb,
            )
          : null;
      const html = await renderAuthEntrypointHtml({
        config: request.config,
        configUrl: request.configUrl,
        requestUrl,
        ...(handoff && 'email' in handoff ? { registrationHandoff: { email: handoff.email } } : {}),
      });
      // The handoff continues a registration already counted, it does not start a flow.
      const outcome = request.method === 'HEAD' || handoff ? null : start;
      if (outcome) {
        await recordAuthFunnelStep(
          { domain: request.config.domain, step: 'flow_started', outcome },
          { prisma: request.adminDb },
        );
      }
      sendAuthHtml(reply, html);
    },
  );

  // Serve the built Auth app assets needed by `Auth/dist/index.html`.
  //
  // Note: we intentionally avoid adding extra Fastify plugins for this simple static
  // use-case; later tasks can replace this with a more complete static/SSR solution.
  app.get('/assets/*', async (request, reply) => {
    const params = request.params as { '*': string };
    const rel = params['*'] ?? '';
    const { body, contentType } = await readAuthUiAsset({
      relativePath: pathJoin('assets', rel),
    });
    reply.type(contentType).status(200).send(body);
  });
}

function pathJoin(prefix: string, rest: string): string {
  const normalizedRest = rest.replace(/^\/+/, '');
  return `${prefix}/${normalizedRest}`;
}
