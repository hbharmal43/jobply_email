import { layout, button, type EmailTemplate } from './types';

export interface WelcomePayload {
  firstName?: string | null;
}

export const welcomeTemplate: EmailTemplate<WelcomePayload> = {
  templateKey: 'welcome',
  version: 1,
  render: (payload) => {
    const name = payload.firstName?.trim() || 'there';
    const html = layout(`
      <h1 style="margin:0 0 12px;font-size:22px;color:#0A0A0A;">Welcome to Jobply, ${name}!</h1>
      <p style="margin:0 0 16px;font-size:14px;color:#404040;line-height:1.6;">
        You're in. Finish your profile and install the Chrome extension to start
        auto-filling job applications on Workday, Greenhouse, Lever, and 25+ other platforms.
      </p>
      ${button('Go to your dashboard', 'https://jobply.ai/dashboard')}
    `);
    const text = `Welcome to Jobply, ${name}!\n\nFinish your profile and install the Chrome extension to start auto-filling job applications.\n\nGo to your dashboard: https://jobply.ai/dashboard`;
    return { subject: 'Welcome to Jobply', html, text };
  },
};
