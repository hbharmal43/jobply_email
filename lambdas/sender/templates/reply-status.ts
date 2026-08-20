import { layout, button, type EmailTemplate } from './types';

export interface ReplyStatusPayload {
  firstName?: string | null;
  companyName: string;
  jobTitle?: string | null;
  unsubscribeUrl: string;
}

/**
 * Reuses the uid/token already signed into unsubscribeUrl (same HMAC scheme
 * as extension-feedback's feedbackFormUrl) so a single click records the
 * answer server-side instead of requiring the user to log in and fill a form.
 */
function replyStatusUrl(unsubscribeUrl: string, reply: 'yes' | 'no'): string {
  const { searchParams } = new URL(unsubscribeUrl);
  searchParams.set('reply', reply);
  return `https://jobply.ai/email/reply-status?${searchParams.toString()}`;
}

function buildStatusSteps(company: string): { title: string; body: string }[] {
  return [
    { title: 'Open your Applied tab', body: 'Head to your Jobply dashboard and click Applied in the top nav.' },
    { title: 'Find the application', body: `Locate ${company} in the list, then click the arrow on its status badge to open the dropdown.` },
    { title: 'Choose the matching status', body: 'Pick Screening, Interview, Offer, or Rejected, whichever fits what you heard.' },
  ];
}

function statusStepRow(index: number, title: string, body: string, isLast: boolean): string {
  return `
    <tr>
      <td style="width:26px;vertical-align:top;${isLast ? '' : 'padding-bottom:14px;'}">
        <div style="width:20px;height:20px;border-radius:50%;background:#F5F5F5;color:#0A0A0A;font-weight:700;font-size:12px;text-align:center;line-height:20px;">${index}</div>
      </td>
      <td style="vertical-align:top;padding-left:14px;${isLast ? '' : 'padding-bottom:14px;'}">
        <p style="margin:0;font-weight:700;font-size:14px;color:#0A0A0A;">${title}</p>
        <p style="margin:2px 0 0;font-size:13px;color:#737373;line-height:1.5;">${body}</p>
      </td>
    </tr>
  `;
}

export const replyStatusTemplate: EmailTemplate<ReplyStatusPayload> = {
  templateKey: 'reply_status_check',
  version: 1,
  render: (payload) => {
    const name = payload.firstName?.trim() || 'there';
    const company = payload.companyName.trim();
    const role = payload.jobTitle?.trim();
    const yesUrl = replyStatusUrl(payload.unsubscribeUrl, 'yes');
    const noUrl = replyStatusUrl(payload.unsubscribeUrl, 'no');
    const roleLine = role ? ` for the <strong>${role}</strong> role` : '';
    const steps = buildStatusSteps(company);

    const html = layout(`
      <h1 style="margin:0 0 12px;font-size:22px;color:#0A0A0A;">Hey ${name}, any word from ${company}?</h1>
      <p style="margin:0 0 20px;font-size:14px;color:#404040;line-height:1.6;">
        You applied to <strong>${company}</strong>${roleLine} through Jobply a little while
        back. We'd love a quick update. It helps us understand what's working and follow up
        at the right time.
      </p>
      <table role="presentation" cellpadding="0" cellspacing="0">
        <tr>
          <td style="padding-right:12px;">${button('Yes, I heard back', yesUrl)}</td>
          <td>
            <a href="${noUrl}" style="display:inline-block;background:#F5F5F5;color:#0A0A0A;font-weight:700;font-size:14px;text-decoration:none;padding:14px 24px;border-radius:12px;margin-top:8px;">
              Not yet
            </a>
          </td>
        </tr>
      </table>
      <p style="margin:28px 0 12px;font-size:13px;font-weight:700;color:#0A0A0A;">
        Heard back? Update your application status too, so your dashboard stays accurate:
      </p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        ${steps.map((s, i) => statusStepRow(i + 1, s.title, s.body, i === steps.length - 1)).join('')}
      </table>
    `, payload.unsubscribeUrl);

    const stepsText = steps.map((s, i) => `${i + 1}. ${s.title}: ${s.body}`).join('\n');
    const text = `Hey ${name}, any word from ${company}?\n\nYou applied to ${company}${role ? ` for the ${role} role` : ''} through Jobply a little while back. We'd love a quick update.\n\nYes, I heard back: ${yesUrl}\nNot yet: ${noUrl}\n\nHeard back? Update your application status too, so your dashboard stays accurate:\n${stepsText}`;

    return { subject: `Any update on your ${company} application?`, html, text };
  },
};
