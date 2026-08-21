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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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

    const headlineTitle = `${jobs.length} fresh job ${jobs.length === 1 ? 'match' : 'matches'} for you`;

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

      const safeTitle = escapeHtml(jobTitle);
      const safeCompany = escapeHtml(company);
      const safeLocation = escapeHtml(location);
      const safeWorkArrangement = escapeHtml(workArr);
      const safeJobLink = escapeHtml(jobLink);

      const badgeHtml = workArr
        ? `<span style="display:inline-block;background:#F3F4F6;color:#404040;padding:5px 9px;border-radius:999px;font-size:11px;font-weight:700;line-height:14px;margin-left:6px;">${safeWorkArrangement}</span>`
        : '';

      const salaryHtml = salStr
        ? `<span style="display:inline-block;background:#ECFDF3;color:#16794A;padding:5px 9px;border-radius:999px;font-size:11px;font-weight:700;line-height:14px;">${escapeHtml(salStr)}</span>`
        : '';

      jobCardsHtml += `
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border:1px solid #E5E5E5;border-radius:14px;margin:0 0 14px;background:#FFFFFF;border-collapse:separate;">
          <tr>
            <td style="padding:20px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td width="42" valign="top" style="width:42px;padding-right:14px;">
                    <div style="width:36px;height:36px;line-height:36px;text-align:center;background:#FFF2AE;border-radius:10px;color:#0A0A0A;font-size:12px;font-weight:800;">${String(indexNum).padStart(2, '0')}</div>
                  </td>
                  <td valign="top">
                    <p style="margin:0 0 5px;color:#737373;font-size:12px;font-weight:700;line-height:17px;text-transform:uppercase;letter-spacing:.5px;">${safeCompany}</p>
                    <h2 style="margin:0;font-size:19px;line-height:25px;font-weight:800;color:#0A0A0A;">
                      <a href="${safeJobLink}" style="color:#0A0A0A;text-decoration:none;">${safeTitle}</a>
                    </h2>
                    <p style="margin:8px 0 0;color:#525252;font-size:13px;line-height:19px;">${safeLocation}${badgeHtml}</p>
                  </td>
                </tr>
                <tr>
                  <td width="42" style="width:42px;padding-right:14px;">&nbsp;</td>
                  <td style="padding-top:15px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td valign="middle">${salaryHtml}</td>
                        <td align="right" valign="middle">
                          <a href="${safeJobLink}" style="display:inline-block;background:#FFDE59;color:#0A0A0A;padding:10px 15px;border-radius:9px;font-size:13px;line-height:17px;font-weight:800;text-decoration:none;">View job &rarr;</a>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      `;
    }

    const titleContext = userTitle ? ` for ${escapeHtml(userTitle)}` : '';

    const bodyHtml = `
      <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">Your newest Jobply matches are ready to review.</div>

      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background:#FFF8D8;border:1px solid #F5E7A3;border-radius:16px;border-collapse:separate;margin:0 0 24px;">
        <tr>
          <td style="padding:26px 24px;">
            <p style="margin:0 0 10px;color:#6B5A00;font-size:11px;line-height:15px;font-weight:800;letter-spacing:1.2px;text-transform:uppercase;">Your daily shortlist</p>
            <h1 style="margin:0;color:#0A0A0A;font-size:29px;line-height:34px;font-weight:850;letter-spacing:-.6px;">${jobs.length} fresh ${jobs.length === 1 ? 'role' : 'roles'} worth a look</h1>
            <p style="margin:12px 0 0;color:#525252;font-size:15px;line-height:23px;">Selected from your experience and preferences${titleContext}.</p>
          </td>
        </tr>
      </table>

      <p style="margin:0 0 8px;color:#0A0A0A;font-size:16px;line-height:24px;font-weight:700;">Hi ${escapeHtml(firstFirstName)},</p>
      <p style="margin:0 0 20px;color:#525252;font-size:14px;line-height:22px;">We narrowed today&rsquo;s listings down to the opportunities most relevant to you.</p>

      ${jobCardsHtml}

      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin-top:24px;">
        <tr>
          <td align="center">
            <a href="${escapeHtml(appUrl)}/dashboard" style="display:inline-block;background:#0A0A0A;color:#FFFFFF;padding:14px 24px;border-radius:10px;font-size:14px;line-height:18px;font-weight:800;text-decoration:none;">See all job matches</a>
          </td>
        </tr>
      </table>

      <p style="margin:24px 0 0;text-align:center;color:#A3A3A3;font-size:11px;line-height:17px;">Matches improve as you save, dismiss, and apply to jobs.</p>
    `;

    const html = layout(bodyHtml, payload.unsubscribeUrl);

    // Render plain text fallback
    const textLines: string[] = [
      `Hi ${firstFirstName},`,
      '',
      `Here are ${jobs.length} fresh job matches selected for you today${userTitle ? ` (${userTitle})` : ''}:`,
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
      textLines.push(`   View job: ${jobLink}`);
      textLines.push('');
    }

    textLines.push('='.repeat(40));
    textLines.push(`See all job matches: ${appUrl}/dashboard`);
    textLines.push('To manage email preferences or unsubscribe, visit your account settings.');

    const text = textLines.join('\n');

    return {
      subject: headlineTitle,
      html,
      text,
    };
  },
};
