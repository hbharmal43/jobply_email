import { welcomeTemplate } from './welcome';
import { onboardingAbandonedTemplate } from './onboarding-abandoned';
import { extensionNudgeTemplate } from './extension-nudge';
import type { EmailTemplate } from './types';

export const TEMPLATES: Record<string, EmailTemplate<any>> = {
  welcome: welcomeTemplate,
  onboarding_abandoned: onboardingAbandonedTemplate,
  extension_nudge: extensionNudgeTemplate,
};

export function getTemplate(templateKey: string): EmailTemplate<any> | undefined {
  return TEMPLATES[templateKey];
}

export type { RenderedEmail, EmailTemplate } from './types';
