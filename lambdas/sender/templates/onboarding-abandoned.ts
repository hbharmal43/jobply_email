import { layout, button, type EmailTemplate } from './types';

export interface OnboardingAbandonedPayload {
  firstName?: string | null;
  unsubscribeUrl: string;
}

const PERKS = [
  { title: 'Auto-filled applications', body: "No more retyping the same info on every job site." },
  { title: 'Matches picked for you', body: 'Curated roles based on your skills and preferences.' },
  { title: 'Less than 5 minutes', body: "Most of the setup is already done." },
];

function perkRow(title: string, body: string, isLast: boolean): string {
  return `
    <tr>
      <td style="width:26px;vertical-align:top;${isLast ? '' : 'padding-bottom:14px;'}">
        <div style="width:20px;height:20px;border-radius:50%;background:#ffde59;color:#0A0A0A;font-weight:700;font-size:12px;text-align:center;line-height:20px;">&#10003;</div>
      </td>
      <td style="vertical-align:top;padding-left:14px;${isLast ? '' : 'padding-bottom:14px;'}">
        <p style="margin:0;font-weight:700;font-size:14px;color:#0A0A0A;">${title}</p>
        <p style="margin:2px 0 0;font-size:13px;color:#737373;line-height:1.5;">${body}</p>
      </td>
    </tr>
  `;
}

export const onboardingAbandonedTemplate: EmailTemplate<OnboardingAbandonedPayload> = {
  templateKey: 'onboarding_abandoned',
  version: 1,
  render: (payload) => {
    const name = payload.firstName?.trim() || 'there';
    const html = layout(`
      <h1 style="margin:0 0 12px;font-size:22px;color:#0A0A0A;">You left your profile half-finished, ${name}</h1>
      <p style="margin:0 0 20px;font-size:14px;color:#404040;line-height:1.6;">
        Looks like you got pulled away before finishing your Jobply setup. No worries —
        pick up right where you left off. It's just a couple more minutes, and it's what
        unlocks auto-filled applications and job matches picked for you.
      </p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;">
        ${PERKS.map((p, i) => perkRow(p.title, p.body, i === PERKS.length - 1)).join('')}
      </table>
      ${button('Finish where I left off', 'https://jobply.ai/onboarding')}
    `, payload.unsubscribeUrl);
    const text = `You left your profile half-finished, ${name}\n\nLooks like you got pulled away before finishing your Jobply setup. Pick up right where you left off:\n\n${PERKS.map(p => `- ${p.title} — ${p.body}`).join('\n')}\n\nhttps://jobply.ai/onboarding`;
    return { subject: "You were this close, don't lose your progress", html, text };
  },
};
