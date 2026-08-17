import { layout, button, type EmailTemplate } from './types';

export interface ExtensionFeedbackPayload {
  firstName?: string | null;
  unsubscribeUrl: string;
}

/**
 * Reuses the uid/token already signed into unsubscribeUrl (see
 * buildUnsubscribeUrl in jobply-email/lambdas/sender/handler.ts) instead of
 * threading a separate token through the payload — it's the same HMAC
 * scheme, verified the same way, by app/api/email/feedback/route.ts.
 */
function feedbackFormUrl(unsubscribeUrl: string): string {
  const { search } = new URL(unsubscribeUrl);
  return `https://jobply.ai/email/feedback${search}`;
}

export const extensionFeedbackTemplate: EmailTemplate<ExtensionFeedbackPayload> = {
  templateKey: 'extension_feedback',
  version: 1,
  render: (payload) => {
    const name = payload.firstName?.trim() || 'there';
    const feedbackUrl = feedbackFormUrl(payload.unsubscribeUrl);
    const html = layout(`
      <h1 style="margin:0 0 12px;font-size:22px;color:#0A0A0A;">How's your Jobply experience so far, ${name}?</h1>
      <p style="margin:0 0 16px;font-size:14px;color:#404040;line-height:1.6;">
        You've been using the extension for a little while now, and we'd love to hear your
        thoughts. What's helping you save time? What's not working as expected? Your feedback
        helps us improve Jobply and build features that make job searching easier for everyone.
      </p>
      ${button('Share your feedback', feedbackUrl)}
    `, payload.unsubscribeUrl);
    const text = `How's your Jobply experience so far, ${name}?\n\nYou've been using the extension for a little while now, and we'd love to hear your thoughts. What's helping you save time? What's not working as expected? Your feedback helps us improve Jobply and build features that make job searching easier for everyone.\n\nShare your feedback: ${feedbackUrl}`;
    return { subject: 'Got 2 minutes? Quick question for you', html, text };
  },
};
