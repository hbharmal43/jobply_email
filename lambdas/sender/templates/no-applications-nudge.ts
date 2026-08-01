import { layout, button, type EmailTemplate } from './types';

export interface NoApplicationsNudgePayload {
  firstName?: string | null;
  unsubscribeUrl: string;
}

export const noApplicationsNudgeTemplate: EmailTemplate<NoApplicationsNudgePayload> = {
  templateKey: 'no_applications_nudge',
  version: 1,
  render: (payload) => {
    const name = payload.firstName?.trim() || 'there';
    const html = layout(`
      <h1 style="margin:0 0 12px;font-size:22px;color:#0A0A0A;">Your profile is ready, ${name} — time to put it to work</h1>
      <p style="margin:0 0 16px;font-size:14px;color:#404040;line-height:1.6;">
        You haven't applied to any jobs yet. Your profile and the Jobply extension are set up
        to make applying fast — the hardest part is just sending the first one.
      </p>
      ${button('Browse matched jobs', 'https://jobply.ai/dashboard')}
    `, payload.unsubscribeUrl);
    const text = `Your profile is ready, ${name} — time to put it to work\n\nYou haven't applied to any jobs yet. Browse matched jobs: https://jobply.ai/dashboard`;
    return { subject: "Let's get your first application in", html, text };
  },
};
