import { layout, button, type EmailTemplate } from './types';

export interface NoApplicationsNudgePayload {
  firstName?: string | null;
  unsubscribeUrl: string;
}

const STEPS = [
  { title: 'Open your matches', body: 'Head to your Jobply dashboard and pick a role that stands out.' },
  { title: 'Click apply', body: "Jobply's extension auto-fills the application on the job site — Workday, Greenhouse, Lever, and more." },
  { title: 'Review and submit', body: "Double-check the details, then hit submit. That's your first one done." },
];

function stepRow(index: number, title: string, body: string, isLast: boolean): string {
  return `
    <tr>
      <td style="width:26px;vertical-align:top;${isLast ? '' : 'padding-bottom:14px;'}">
        <div style="width:20px;height:20px;border-radius:50%;background:#ffde59;color:#0A0A0A;font-weight:700;font-size:12px;text-align:center;line-height:20px;">${index}</div>
      </td>
      <td style="vertical-align:top;padding-left:14px;${isLast ? '' : 'padding-bottom:14px;'}">
        <p style="margin:0;font-weight:700;font-size:14px;color:#0A0A0A;">${title}</p>
        <p style="margin:2px 0 0;font-size:13px;color:#737373;line-height:1.5;">${body}</p>
      </td>
    </tr>
  `;
}

export const noApplicationsNudgeTemplate: EmailTemplate<NoApplicationsNudgePayload> = {
  templateKey: 'no_applications_nudge',
  version: 1,
  render: (payload) => {
    const name = payload.firstName?.trim() || 'there';
    const html = layout(`
      <h1 style="margin:0 0 12px;font-size:22px;color:#0A0A0A;">You're all set, ${name} — your next opportunity is waiting</h1>
      <p style="margin:0 0 20px;font-size:14px;color:#404040;line-height:1.6;">
        Your profile is complete, and your Jobply extension is ready to go. The only thing
        left is to submit your first application. Every successful job search starts with a
        single click, and we've already found opportunities that match your profile. Take
        the first step today — you might be closer to your next interview than you think.
      </p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;">
        ${STEPS.map((s, i) => stepRow(i + 1, s.title, s.body, i === STEPS.length - 1)).join('')}
      </table>
      ${button('See your matches', 'https://jobply.ai/dashboard')}
    `, payload.unsubscribeUrl);
    const text = `You're all set, ${name} — your next opportunity is waiting\n\nYour profile is complete, and your Jobply extension is ready to go. The only thing left is to submit your first application. Every successful job search starts with a single click, and we've already found opportunities that match your profile. Take the first step today — you might be closer to your next interview than you think.\n\n${STEPS.map((s, i) => `${i + 1}. ${s.title} — ${s.body}`).join('\n')}\n\nSee your matches: https://jobply.ai/dashboard`;
    return { subject: 'Your first application is the hardest one to send', html, text };
  },
};
