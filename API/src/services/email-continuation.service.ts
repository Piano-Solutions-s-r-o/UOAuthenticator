import type { PrismaClient } from '@prisma/client';
import type { FastifyRequest } from 'fastify';

import { LOGIN_SESSION_AUDIENCE } from '../config/constants.js';
import { requireEnv } from '../config/env.js';
import { runInTransaction } from '../db/tenant-context.js';
import { recordAuthFunnelStep } from './auth-funnel.service.js';
import type { AcceptedEmailInviteWorkspace, VerifyEmailTokenType } from './auth-verify-email.service.js';
import { lockAndAssertAuthenticationEpoch } from './authentication-epoch.service.js';
import { selectRedirectUrl } from './authorization-code.service.js';
import type { ClientConfig } from './config.service.js';
import {
  buildWorkspaceChoices,
  resolveAutoSelectedWorkspace,
  shouldPresentWorkspaceChooser,
  type AutoSelectedWorkspace,
} from './first-login.service.js';
import { recordLoginLog } from './login-log.service.js';
import { signLoginSession } from './login-session.service.js';
import { lockProductWorkspacePolicyShared } from './product-workspace-policy-lock.service.js';
import { resolveProductWorkspaceBeforeTwoFa } from './required-workspace-placement.service.js';
import { finalizeWithTwoFaPolicy } from './workspace-finalize.service.js';

type EmailContinuationParams = {
  userId: string;
  credentialEpoch: number;
  twoFaEnabled: boolean;
  acceptedInvite: AcceptedEmailInviteWorkspace | null;
  authMethod: string;
  config: ClientConfig;
  configUrl: string;
  requestedRedirectUrl?: string;
  requestAccess: boolean;
  codeChallenge?: string;
  codeChallengeMethod?: 'S256';
  ip: string | null;
};

export type EmailContinuation = Awaited<ReturnType<typeof resolveEmailContinuation>>;

export function emailAuthMethod(type: VerifyEmailTokenType): string {
  if (type === 'LOGIN_LINK') return 'login_link';
  return type === 'VERIFY_EMAIL' ? 'verify_email' : 'verify_email_set_password';
}

/**
 * What a verified address leads to: the workspace chooser, a 2FA step, or a code bound to the
 * caller's PKCE. A caller already inside a transaction keeps it, so this decision commits with its
 * own writes.
 */
export async function resolveEmailContinuation(params: EmailContinuationParams, prisma: PrismaClient) {
  const { userId, credentialEpoch, twoFaEnabled, acceptedInvite, authMethod, config, configUrl, requestAccess } = params;
  const redirectUrl = selectRedirectUrl({
    allowedRedirectUrls: config.redirect_urls,
    requestedRedirectUrl: params.requestedRedirectUrl,
  });
  const rememberMe = config.session?.remember_me_default ?? true;
  return runInTransaction(prisma, async (tx) => {
    await lockProductWorkspacePolicyShared(tx);
    const authenticationState = await lockAndAssertAuthenticationEpoch(
      { userId, domain: config.domain, credentialEpoch },
      { prisma: tx, fallbackTwoFaEnabled: twoFaEnabled },
    );

    // Hold first-placement selection through exact-scope policy evaluation and code issuance.
    // The admin transaction preserves intentional cross-product and accepted-invite reads.
    let selectedWorkspace: AutoSelectedWorkspace | null = acceptedInvite
      ? { orgId: acceptedInvite.orgId, teamId: acceptedInvite.teamId }
      : null;
    if (!acceptedInvite && config.login_flow?.workspace_selection === 'auto') {
      const choices = await buildWorkspaceChoices(
        { userId, config },
        { crossProductPrisma: tx, policyPrisma: tx, prisma: tx },
      );
      selectedWorkspace = resolveAutoSelectedWorkspace(choices);
      if (shouldPresentWorkspaceChooser(choices, selectedWorkspace)) {
        const { SHARED_SECRET } = requireEnv('SHARED_SECRET');
        const loginToken = await signLoginSession({
          userId,
          credentialEpoch,
          authMethod,
          config,
          configUrl,
          redirectUrl,
          rememberMe,
          requestAccess,
          codeChallenge: params.codeChallenge,
          codeChallengeMethod: params.codeChallengeMethod,
          sharedSecret: SHARED_SECRET,
          audience: LOGIN_SESSION_AUDIENCE,
        });
        return { kind: 'workspace_chooser' as const, choices, loginToken };
      }
    }
    selectedWorkspace ??= await resolveProductWorkspaceBeforeTwoFa(
      { userId, config },
      { prisma: tx, workspacePrisma: tx },
    );

    const outcome = await finalizeWithTwoFaPolicy(
      {
        userId,
        credentialEpoch,
        twoFaEnabled,
        config,
        configUrl,
        redirectUrl,
        rememberMe,
        requestAccess,
        authMethod,
        codeChallenge: params.codeChallenge,
        codeChallengeMethod: params.codeChallengeMethod,
        ip: params.ip,
        ...(selectedWorkspace ?? {}),
      },
      {
        currentTwoFaEnabled: authenticationState.twoFaEnabled,
        policyLockHeld: true,
        policyPrisma: tx,
        prisma: tx,
        twoFaPolicyPrisma: tx,
        workspacePrisma: tx,
      },
    );
    return { kind: 'finalized' as const, outcome };
  });
}

/** The response body. Logged and counted after the transaction committed (Docs/Auth/signup-funnel-metrics.md). */
export async function emailContinuationResponse(
  continuation: EmailContinuation,
  params: { request: FastifyRequest; domain: string; userId: string; authMethod: string },
) {
  const { request, domain, userId, authMethod } = params;
  if (continuation.kind === 'workspace_chooser') {
    return { login_token: continuation.loginToken, ...continuation.choices };
  }

  const { outcome } = continuation;
  if (outcome.kind === 'twofa') {
    return { ok: true, twofa_required: true, twofa_token: outcome.twofa_token };
  }
  if (outcome.kind === 'twofa_enroll_required') {
    return { ok: true, kind: 'twofa_enroll_required', twofa_enroll_required: true, ...outcome.setup };
  }

  try {
    await recordLoginLog(
      {
        userId,
        domain,
        authMethod,
        ip: request.ip ?? null,
        userAgent:
          typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
      },
      { prisma: request.adminDb },
    );
  } catch (err) {
    request.log.error({ err }, 'failed to record login log');
  }
  await recordAuthFunnelStep(
    { domain, step: 'sign_in_completed', outcome: authMethod },
    { prisma: request.adminDb },
  );

  return {
    ok: true,
    code: outcome.finalResult.status === 'granted' ? outcome.finalResult.code : undefined,
    redirect_to: outcome.finalResult.redirectTo,
    access_request_status: outcome.finalResult.status === 'requested' ? 'pending' : undefined,
  };
}
