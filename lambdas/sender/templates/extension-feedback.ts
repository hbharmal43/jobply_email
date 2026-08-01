import { layout, button, type EmailTemplate } from './types';

export interface ExtensionFeedbackPayload {
  firstName?: string | null;
  unsubscribeUrl: string;
}

// TODO: point this at the real feedback form once it exists.
const FEEDBACK_FORM_URL = 'https://jobply.ai/feedback';

export const extensionFeedbackTemplate: EmailTemplate<ExtensionFeedbackPayload> = {
  templateKey: 'extension_feedback',
  version: 1,
  render: (payload) => {
    const name = payload.firstName?.trim() || 'there';
    const html = layout(`
      <h1 style="margin:0 0 12px;font-size:22px;color:#0A0A0A;">How's the extension working for you, ${name}?</h1>
      <p style="margin:0 0 16px;font-size:14px;color:#404040;line-height:1.6;">
        You've been applying with the Jobply extension for a while now — we'd love to hear
        how it's going. Two minutes of your feedback directly shapes what we build next.
      </p>
      ${button('Share your feedback', FEEDBACK_FORM_URL)}
    `, payload.unsubscribeUrl);
    const text = `How's the extension working for you, ${name}?\n\nWe'd love your feedback: ${FEEDBACK_FORM_URL}`;
    return { subject: 'Quick question about your Jobply experience', html, text };
  },
};
