import type { PrismaClient } from '@prisma/client';

type CompletionPrisma = Pick<PrismaClient, '$queryRaw' | 'pendingRegistration'>;

/**
 * Two tokens of one address (a resend, or a second browser) can be spent at the same moment. The
 * loser must see the winner's user through the token epoch check and fail like any used token,
 * not reach the unique constraint on user creation.
 */
export async function lockRegistrationIdentity(prisma: CompletionPrisma, tokenHash: string): Promise<void> {
  const row = await prisma.pendingRegistration.findUnique({
    where: { completionHash: tokenHash }, select: { emailHash: true },
  });
  if (!row) return;
  await prisma.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('pending-registration-email'), hashtext(${row.emailHash}))::text AS "lockResult"`;
}

/**
 * Runs in the transaction that spends the verification token. Every registration of this address
 * from this browser and OAuth context finishes together, so the window on the newest resend learns
 * that an older email's link did the work. Another address or browser is never touched: this link
 * proved neither. `continued` closes the original window's own continuation when it finished itself.
 */
export async function completeRegistrationFamily(prisma: CompletionPrisma, params: {
  tokenHash: string; userId: string; credentialEpoch: number; continued: boolean; now: Date;
}): Promise<string[]> {
  const row = await prisma.pendingRegistration.findUnique({
    where: { completionHash: params.tokenHash },
    select: { credentialHash: true, contextHash: true, emailHash: true },
  });
  if (!row) return [];
  const rows = await prisma.pendingRegistration.findMany({ select: { id: true }, where: { ...row, completedAt: null } });
  const ids = rows.map(({ id }) => id);
  await prisma.pendingRegistration.updateMany({ where: { id: { in: ids } }, data: {
    completedAt: params.now, completedUserId: params.userId, completedEpoch: params.credentialEpoch,
    ...(params.continued ? { continuedAt: params.now } : {}),
  } });
  return ids;
}
