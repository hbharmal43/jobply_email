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
      <h1 style="margin:0 0 12px;font-size:22px;color:#0A0A0A;">Fantastic work, ${name} — you're making real progress!</h1>
      <p style="margin:0 0 16px;font-size:14px;color:#404040;line-height:1.6;">
        You've already applied to <strong>${count} ${jobWord}</strong> through Jobply. Every
        application is a step closer to your next opportunity. Most job seekers lose momentum
        early, but your consistency sets you apart. Stay focused, keep applying, and let every
        application bring you one step closer to the interview — and the offer — you've been
        working toward.
      </p>
      ${button('Find more jobs', 'https://jobply.ai/dashboard')}
    `, payload.unsubscribeUrl);
    const text = `Fantastic work, ${name} — you're making real progress!\n\nYou've already applied to ${count} ${jobWord} through Jobply. Every application is a step closer to your next opportunity. Most job seekers lose momentum early, but your consistency sets you apart. Stay focused, keep applying, and let every application bring you one step closer to the interview — and the offer — you've been working toward.\n\nFind more jobs: https://jobply.ai/dashboard`;
    return { subject: `You've applied to ${count} ${jobWord} — keep it up`, html, text };
  },
};
