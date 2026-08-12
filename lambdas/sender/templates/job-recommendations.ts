import { layout, type EmailTemplate } from './types';

export interface RecommendedJob {
  job_id?: string;
  id?: string;
  job_title?: string;
  title?: string;
  company_name?: string;
  company?: string;
  location?: string;
  ai_work_arrangement?: string;
  work_arrangement?: string;
  job_url?: string;
  salary_min?: number | string | null;
  salary_max?: number | string | null;
  salary_currency?: string | null;
}

export interface JobRecommendationsPayload {
  firstName?: string | null;
  userTitle?: string | null;
  jobs: RecommendedJob[];
  appUrl?: string;
  unsubscribeUrl: string;
}

export function formatSalary(
  salaryMin?: number | string | null,
  salaryMax?: number | string | null,
  currency?: string | null,
): string {
  if (!salaryMin && !salaryMax) return '';

  const curr = (currency || '$').trim();
  const currUpper = curr.toUpperCase();
  let currStr = curr;

  if (currUpper === 'USD' || currUpper === '$') {
    currStr = '$';
  } else if (currUpper === 'EUR' || currUpper === '€') {
    currStr = '€';
  } else if (currUpper === 'GBP' || currUpper === '£') {
    currStr = '£';
  }

  const parseVal = (v: number | string): string => {
    const num = typeof v === 'string' ? parseFloat(v) : v;
    return isNaN(num) ? String(v) : Math.round(num).toLocaleString('en-US');
  };

  const minStr = salaryMin ? parseVal(salaryMin) : null;
  const maxStr = salaryMax ? parseVal(salaryMax) : null;

  if (minStr && maxStr) {
    return `${currStr}${minStr} - ${currStr}${maxStr}`;
  }
  if (minStr) {
    return `From ${currStr}${minStr}`;
  }
  if (maxStr) {
    return `Up to ${currStr}${maxStr}`;
  }
  return '';
}

export const jobRecommendationsTemplate: EmailTemplate<JobRecommendationsPayload> = {
  templateKey: 'job_recommendations',
  version: 1,
  render: (payload) => {
    const name = payload.firstName?.trim() || 'there';
    const firstFirstName = name.split(' ')[0] || 'there';
    const appUrl = payload.appUrl || 'https://jobply.ai';
    const jobs = payload.jobs || [];
    const userTitle = payload.userTitle?.trim();

    const headlineTitle = `Top ${jobs.length} Best Jobs For You Today — Jobply`;

    let jobCardsHtml = '';
    for (let idx = 0; idx < jobs.length; idx++) {
      const job = jobs[idx];
      const indexNum = idx + 1;
      const jobTitle = job.job_title || job.title || 'Position Available';
      const company = job.company_name || job.company || 'Featured Company';
      const location = job.location || 'Remote / Flexible';
      const workArr = job.ai_work_arrangement || job.work_arrangement || '';
      const jobId = job.job_id || job.id || '';
      const jobLink = job.job_url || (jobId ? `${appUrl}/jobs/${jobId}` : appUrl);

      const salStr = formatSalary(job.salary_min, job.salary_max, job.salary_currency);

      const badgeHtml = workArr
        ? `<span style="background-color: #e0e7ff; color: #3730a3; padding: 3px 8px; border-radius: 12px; font-size: 12px; font-weight: 500; margin-left: 6px;">${workArr}</span>`
        : '';

      const salaryHtml = salStr
        ? `<div style="font-size: 14px; font-weight: 600; color: #16a34a; margin-top: 6px;">💰 ${salStr}</div>`
        : '';

      jobCardsHtml += `
        <div style="background-color: #ffffff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 18px; margin-bottom: 14px; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
            <div style="display: flex; justify-content: space-between; align-items: flex-start;">
                <div>
                    <h3 style="margin: 0 0 6px 0; font-size: 17px; font-weight: 600; color: #111827;">
                        <a href="${jobLink}" style="color: #2563eb; text-decoration: none;">${indexNum}. ${jobTitle}</a>
                    </h3>
                    <div style="font-size: 14px; font-weight: 500; color: #4b5563; margin-bottom: 4px;">🏢 ${company}</div>
                    <div style="font-size: 13px; color: #6b7280;">📍 ${location} ${badgeHtml}</div>
                    ${salaryHtml}
                </div>
            </div>
            <div style="margin-top: 12px; text-align: right;">
                <a href="${jobLink}" style="display: inline-block; background-color: #2563eb; color: #ffffff; padding: 8px 16px; border-radius: 6px; font-size: 13px; font-weight: 600; text-decoration: none;">Apply / View Job →</a>
            </div>
        </div>
      `;
    }

    const titleContext = userTitle ? ` (${userTitle})` : '';

    const bodyHtml = `
      <div style="background: linear-gradient(135deg, #1e3a8a 0%, #3b82f6 100%); color: #ffffff; padding: 24px; border-radius: 8px; text-align: left; margin-bottom: 20px;">
          <h1 style="margin: 0; font-size: 22px; font-weight: 700; color: #ffffff;">Hi ${firstFirstName}, 👋</h1>
          <p style="margin: 6px 0 0 0; font-size: 15px; color: #e0e7ff;">
              Here are your top ${jobs.length} job matches based on your profile${titleContext}:
          </p>
      </div>

      <div style="background-color: #f9fafb; padding: 16px; border-radius: 8px;">
          ${jobCardsHtml}

          <div style="text-align: center; margin-top: 24px; padding-top: 16px; border-top: 1px solid #e5e7eb;">
              <a href="${appUrl}/dashboard" style="display: inline-block; background-color: #111827; color: #ffffff; padding: 12px 24px; border-radius: 8px; font-size: 15px; font-weight: 600; text-decoration: none;">
                  Explore All Recommendations on Jobply
              </a>
          </div>
      </div>
    `;

    const html = layout(bodyHtml, payload.unsubscribeUrl);

    // Render plain text fallback
    const textLines: string[] = [
      `Hi ${firstFirstName},`,
      '',
      `Here are your top ${jobs.length} job matches today on Jobply${titleContext}:`,
      '='.repeat(40),
      '',
    ];

    for (let idx = 0; idx < jobs.length; idx++) {
      const job = jobs[idx];
      const indexNum = idx + 1;
      const jobTitle = job.job_title || job.title || 'Position Available';
      const company = job.company_name || job.company || 'Featured Company';
      const location = job.location || 'Remote / Flexible';
      const jobId = job.job_id || job.id || '';
      const jobLink = job.job_url || (jobId ? `${appUrl}/jobs/${jobId}` : appUrl);
      const salStr = formatSalary(job.salary_min, job.salary_max, job.salary_currency);

      textLines.push(`${indexNum}. ${jobTitle}`);
      textLines.push(`   Company: ${company}`);
      textLines.push(`   Location: ${location}`);
      if (salStr) {
        textLines.push(`   Salary: ${salStr}`);
      }
      textLines.push(`   Apply: ${jobLink}`);
      textLines.push('');
    }

    textLines.push('='.repeat(40));
    textLines.push(`View more recommendations: ${appUrl}/dashboard`);
    textLines.push('To manage email preferences or unsubscribe, visit your account settings.');

    const text = textLines.join('\n');

    return {
      subject: headlineTitle,
      html,
      text,
    };
  },
};
