import { welcomeTemplate } from './welcome';
import { onboardingAbandonedTemplate } from './onboarding-abandoned';
import { extensionNudgeTemplate } from './extension-nudge';
import { applicationPraiseTemplate } from './application-praise';
import { noApplicationsNudgeTemplate } from './no-applications-nudge';
import { extensionFeedbackTemplate } from './extension-feedback';
import { accountDeletedTemplate } from './account-deleted';
import type { EmailTemplate } from './types';

export const TEMPLATES: Record<string, EmailTemplate<any>> = {
  welcome: welcomeTemplate,
  onboarding_abandoned: onboardingAbandonedTemplate,
  extension_nudge: extensionNudgeTemplate,
  application_praise: applicationPraiseTemplate,
  no_applications_nudge: noApplicationsNudgeTemplate,
  extension_feedback: extensionFeedbackTemplate,
  account_deleted: accountDeletedTemplate,
};

export function getTemplate(templateKey: string): EmailTemplate<any> | undefined {
  return TEMPLATES[templateKey];
}

export type { RenderedEmail, EmailTemplate } from './types';
