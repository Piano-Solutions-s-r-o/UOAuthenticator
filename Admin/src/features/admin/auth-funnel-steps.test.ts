import { describe, expect, it } from 'vitest';

import { funnelSteps, isReachedOutcome, outcomeLabel } from './auth-funnel-steps';

describe('sign-up funnel steps', () => {
  it('counts the first open of a browser-bound registration link as a reached email link', () => {
    const emailLink = funnelSteps.find((info) => info.step === 'email_link_opened');
    if (!emailLink) throw new Error('email_link_opened step is missing');
    expect(isReachedOutcome(emailLink, 'opened')).toBe(true);
    expect(isReachedOutcome(emailLink, 'already_used')).toBe(false);
    expect(outcomeLabel('opened')).toBe('Registration link opened (first time)');
  });
});
