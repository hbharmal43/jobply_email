import { layout, button, type EmailTemplate } from './types';

export interface WelcomePayload {
  firstName?: string | null;
  unsubscribeUrl: string;
}

const STEPS = [
  { title: 'Upload your resume', body: 'We pull out your experience, skills, and education automatically — no manual data entry.' },
  { title: 'Set your target roles', body: 'Tell us the roles, locations, and salary range you actually want.' },
  { title: 'Install the extension', body: 'Jobply auto-fills applications for you as you browse job boards.' },
  { title: 'Track it all in one place', body: 'Every application, status, and match lands in a single dashboard.' },
];

function stepRow(index: number, title: string, body: string, isLast: boolean): string {
  return `
    <tr>
      <td style="width:32px;vertical-align:top;${isLast ? '' : 'padding-bottom:18px;'}">
        <div style="width:26px;height:26px;border-radius:50%;background:#ffde59;color:#0A0A0A;font-weight:700;font-size:13px;text-align:center;line-height:26px;">${index}</div>
      </td>
      <td style="vertical-align:top;padding-left:14px;${isLast ? '' : 'padding-bottom:18px;'}">
        <p style="margin:0;font-weight:700;font-size:14px;color:#0A0A0A;">${title}</p>
        <p style="margin:3px 0 0;font-size:13px;color:#737373;line-height:1.5;">${body}</p>
      </td>
    </tr>
  `;
}

export const welcomeTemplate: EmailTemplate<WelcomePayload> = {
  templateKey: 'welcome',
  version: 1,
  render: (payload) => {
    const name = payload.firstName?.trim() || 'there';
    const html = layout(`
      <div style="text-align:center;margin:0 0 20px;">
        <img src="https://jobply.ai/email/welcome-hero.png" alt="" width="150" style="display:inline-block;width:150px;height:auto;border:0;">
      </div>
      <h1 style="margin:0 0 12px;font-size:22px;color:#0A0A0A;text-align:center;">Welcome to Jobply, ${name}!</h1>
      <p style="margin:0 0 24px;font-size:14px;color:#404040;line-height:1.6;text-align:center;">
        You're just a few minutes away from completing your profile. Once it's set up, we'll
        start finding and matching you with opportunities that align with your skills and
        career goals.
      </p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
        ${STEPS.map((s, i) => stepRow(i + 1, s.title, s.body, i === STEPS.length - 1)).join('')}
      </table>
      <div style="text-align:center;">
        ${button('Set up my profile', 'https://jobply.ai/onboarding')}
      </div>
    `, payload.unsubscribeUrl);
    const text = `Welcome to Jobply, ${name}!\n\nYou're just a few minutes away from completing your profile. Once it's set up, we'll start finding and matching you with opportunities that align with your skills and career goals.\n\n${STEPS.map((s, i) => `${i + 1}. ${s.title} — ${s.body}`).join('\n')}\n\nSet up my profile: https://jobply.ai/onboarding`;
    return { subject: 'Welcome to Jobply', html, text };
  },
};
