import { layout, button, type EmailTemplate } from './types';

export interface OnboardingAbandonedPayload {
  firstName?: string | null;
}

export const onboardingAbandonedTemplate: EmailTemplate<OnboardingAbandonedPayload> = {
  templateKey: 'onboarding_abandoned',
  version: 1,
  render: (payload) => {
    const name = payload.firstName?.trim() || 'there';
    const html = layout(`
      <h1 style="margin:0 0 12px;font-size:22px;color:#0A0A0A;">You left your profile hanging, ${name}</h1>
      <p style="margin:0 0 16px;font-size:14px;color:#404040;line-height:1.6;">
        You started setting up your Jobply profile but didn't finish. It only takes a
        couple more minutes, and it's what powers your auto-filled applications and job matches.
      </p>
      ${button('Finish your profile', 'https://jobply.ai/onboarding')}
    `);
    const text = `You left your profile hanging, ${name}\n\nYou started setting up your Jobply profile but didn't finish. Finish it here: https://jobply.ai/onboarding`;
    return { subject: "Don't lose your Jobply progress", html, text };
  },
};
