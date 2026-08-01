import { layout, button, type EmailTemplate } from './types';

export interface ApplicationPraisePayload {
  firstName?: string | null;
  applicationCount?: number | null;
  unsubscribeUrl: string;
}

export const applicationPraiseTemplate: EmailTemplate<ApplicationPraisePayload> = {
  templateKey: 'application_praise',
  version: 1,
  render: (payload) => {
    const name = payload.firstName?.trim() || 'there';
    const count = payload.applicationCount ?? 0;
    const jobWord = count === 1 ? 'job' : 'jobs';
    const html = layout(`
      <h1 style="margin:0 0 12px;font-size:22px;color:#0A0A0A;">Nice work, ${name} — you're on a roll</h1>
      <p style="margin:0 0 16px;font-size:14px;color:#404040;line-height:1.6;">
        So far you've applied to <strong>${count} ${jobWord}</strong> with Jobply. Every application
        adds up, and consistency is what gets interviews. Keep going.
      </p>
      ${button('Find more jobs to apply to', 'https://jobply.ai/dashboard')}
    `, payload.unsubscribeUrl);
    const text = `Nice work, ${name} — you're on a roll\n\nSo far you've applied to ${count} ${jobWord} with Jobply. Keep going: https://jobply.ai/dashboard`;
    return { subject: `You've applied to ${count} ${jobWord} — keep it up`, html, text };
  },
};
