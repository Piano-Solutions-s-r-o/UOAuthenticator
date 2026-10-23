import { describe, expect, it } from 'vitest';

import { funnelSteps, isReachedOutcome, outcomeLabel } from './auth-funnel-steps';

describe('sign-up funnel steps', () => {
  it('counts a confirmed browser-bound registration link as a reached email link', () => {
    const emailLink = funnelSteps.find((info) => info.step === 'email_link_opened');
    if (!emailLink) throw new Error('email_link_opened step is missing');
    expect(isReachedOutcome(emailLink, 'registration_verified')).toBe(true);
    expect(isReachedOutcome(emailLink, 'already_used')).toBe(false);
    expect(outcomeLabel('registration_verified')).toBe('Valid verification link (browser-bound)');
  });
});
