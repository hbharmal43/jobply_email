import { layout, button, type EmailTemplate } from './types';

export interface ExtensionNudgePayload {
  firstName?: string | null;
  unsubscribeUrl: string;
}

export const extensionNudgeTemplate: EmailTemplate<ExtensionNudgePayload> = {
  templateKey: 'extension_nudge',
  version: 1,
  render: (payload) => {
    const name = payload.firstName?.trim() || 'there';
    const html = layout(`
      <h1 style="margin:0 0 12px;font-size:22px;color:#0A0A0A;">Why spend 15 minutes on every application, ${name}?</h1>
      <p style="margin:0 0 16px;font-size:14px;color:#404040;line-height:1.6;">
        Install the Jobply Chrome Extension and let it do the repetitive work for you.
        Automatically fill applications across Workday, Greenhouse, Lever, and many more
        platforms in under 30 seconds. Spend less time filling forms and more time landing
        interviews.
      </p>
      ${button('Download the extension', 'https://chromewebstore.google.com/detail/clggbdcopoanbmfckeehnoodopjmfjjn?utm_source=item-share-cb')}
    `, payload.unsubscribeUrl);
    const text = `Why spend 15 minutes on every application, ${name}?\n\nInstall the Jobply Chrome Extension and let it do the repetitive work for you. Automatically fill applications across Workday, Greenhouse, Lever, and many more platforms in under 30 seconds. Spend less time filling forms and more time landing interviews.\n\nDownload the extension: https://chromewebstore.google.com/detail/clggbdcopoanbmfckeehnoodopjmfjjn?utm_source=item-share-cb`;
    return { subject: "You're missing the best part of Jobply", html, text };
  },
};
