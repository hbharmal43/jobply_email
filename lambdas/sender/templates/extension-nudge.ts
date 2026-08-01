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
      <h1 style="margin:0 0 12px;font-size:22px;color:#0A0A0A;">Applying is 10x faster with the extension, ${name}</h1>
      <p style="margin:0 0 16px;font-size:14px;color:#404040;line-height:1.6;">
        You haven't installed the Jobply Chrome extension yet. It auto-fills job
        applications on Workday, Greenhouse, Lever, and 7+ platforms — what takes
        15 minutes by hand takes under 30 seconds with it.
      </p>
      ${button('Add to Chrome', 'https://chromewebstore.google.com/detail/clggbdcopoanbmfckeehnoodopjmfjjn?utm_source=item-share-cb')}
    `, payload.unsubscribeUrl);
    const text = `Applying is 10x faster with the extension, ${name}\n\nYou haven't installed the Jobply Chrome extension yet. Install it here: https://chromewebstore.google.com/detail/clggbdcopoanbmfckeehnoodopjmfjjn?utm_source=item-share-cb`;
    return { subject: 'Apply 10x faster with the Jobply extension', html, text };
  },
};
