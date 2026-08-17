import { layout, type EmailTemplate } from './types';

export interface AccountDeletedPayload {
  firstName?: string | null;
}

// No unsubscribeUrl passed to layout() — by the time this sends, the
// profile is gone, so "Manage account" / "Unsubscribe" have nothing to
// point at. See layout()'s doc comment in types.ts.
export const accountDeletedTemplate: EmailTemplate<AccountDeletedPayload> = {
  templateKey: 'account_deleted',
  version: 1,
  render: (payload) => {
    const name = payload.firstName?.trim() || 'there';
    const html = layout(`
      <h1 style="margin:0 0 12px;font-size:22px;color:#0A0A0A;">We're sorry to see you go, ${name}.</h1>
      <p style="margin:0 0 16px;font-size:14px;color:#404040;line-height:1.6;">
        Your Jobply account has been successfully deleted, and all associated data has
        been removed in accordance with our privacy policy.
      </p>
      <p style="margin:0 0 16px;font-size:14px;color:#404040;line-height:1.6;">
        Thank you for being part of the Jobply community. We hope we were able to make
        your job search a little easier.
      </p>
      <p style="margin:0 0 16px;font-size:14px;color:#404040;line-height:1.6;">
        If your journey brings you back in the future, we'll be here to help you
        discover opportunities, simplify applications, and take the next step in your
        career.
      </p>
      <p style="margin:0;font-size:14px;color:#404040;line-height:1.6;">
        We wish you all the best in your job search and future success.<br>
        — The Jobply Team
      </p>
    `);
    const text = `We're sorry to see you go, ${name}.\n\nYour Jobply account has been successfully deleted, and all associated data has been removed in accordance with our privacy policy.\n\nThank you for being part of the Jobply community. We hope we were able to make your job search a little easier.\n\nIf your journey brings you back in the future, we'll be here to help you discover opportunities, simplify applications, and take the next step in your career.\n\nWe wish you all the best in your job search and future success.\n\n— The Jobply Team`;
    return { subject: 'Your Jobply account has been deleted', html, text };
  },
};
