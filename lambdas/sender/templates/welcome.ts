import { layout, button, type EmailTemplate } from './types';

export interface WelcomePayload {
  firstName?: string | null;
  unsubscribeUrl: string;
}

export const welcomeTemplate: EmailTemplate<WelcomePayload> = {
  templateKey: 'welcome',
  version: 1,
  render: (payload) => {
    const name = payload.firstName?.trim() || 'there';
    const html = layout(`
      <h1 style="margin:0 0 12px;font-size:22px;color:#0A0A0A;">Welcome to Jobply, ${name}!</h1>
      <p style="margin:0 0 16px;font-size:14px;color:#404040;line-height:1.6;">
        You're in. You can start your onboarding now — it only takes a couple of minutes
        and it's what powers your auto-filled applications and job matches from here on.
      </p>
      ${button('Start your onboarding', 'https://jobply.ai/onboarding')}
    `, payload.unsubscribeUrl);
    const text = `Welcome to Jobply, ${name}!\n\nYou can start your onboarding now — it only takes a couple of minutes and it's what powers your auto-filled applications and job matches.\n\nStart your onboarding: https://jobply.ai/onboarding`;
    return { subject: 'Welcome to Jobply', html, text };
  },
};
