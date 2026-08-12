export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export interface EmailTemplate<P = Record<string, unknown>> {
  templateKey: string;
  version: number;
  render: (payload: P) => RenderedEmail;
}

/**
 * Some send paths downstream (seen via Resend) render non-ASCII characters
 * as mojibake (e.g. "—" -> "â€"") — a classic UTF-8-read-as-Latin-1 symptom.
 * Rather than chase which hop mis-declares the charset, swap typographic
 * characters for numeric HTML entities, which are pure ASCII and render
 * correctly no matter how the transport mis-handles 8-bit bytes.
 */
function escapeTypographicChars(html: string): string {
  return html
    .replace(/—/g, '&mdash;')
    .replace(/–/g, '&ndash;')
    .replace(/·/g, '&middot;')
    .replace(/’/g, '&rsquo;')
    .replace(/‘/g, '&lsquo;')
    .replace(/“/g, '&ldquo;')
    .replace(/”/g, '&rdquo;');
}

/**
 * Shared layout so the templates look like one product, not several.
 * unsubscribeUrl is optional: account_deleted (and any future one-off
 * transactional confirmation with no account left to manage or unsubscribe
 * from) omits it, which drops both footer links down to a bare wordmark.
 */
export function layout(bodyHtml: string, unsubscribeUrl?: string): string {
  const footer = unsubscribeUrl
    ? `
          <p style="margin:0;font-size:12px;color:#A3A3A3;">
            Jobply &middot; <a href="https://jobply.ai/dashboard/settings" style="color:#A3A3A3;">Manage account</a>
          </p>
          <p style="margin:8px 0 0;">
            <a href="${unsubscribeUrl}" style="color:#0A0A0A;font-weight:700;font-size:13px;text-decoration:underline;">Unsubscribe</a>
          </p>
    `
    : `
          <p style="margin:0;font-size:12px;color:#A3A3A3;">Jobply</p>
    `;

  const html = `
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
    <body style="margin:0;padding:0;background:#F5F5F5;font-family:sans-serif;">
      <div style="max-width:600px;margin:32px auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 12px rgba(0,0,0,0.08);">
        <div style="background:#ffde59;padding:20px 28px;">
          <img src="https://jobply.ai/logo.png" alt="Jobply" width="66" height="28" style="display:block;height:28px;width:66px;border:0;">
        </div>
        <div style="padding:28px;">
          ${bodyHtml}
        </div>
        <div style="padding:0 28px 24px;text-align:center;">
          ${footer}
        </div>
      </div>
    </body>
    </html>
  `;
  return escapeTypographicChars(html);
}

export function button(label: string, url: string): string {
  return `
    <a href="${url}" style="display:inline-block;background:#ffde59;color:#0A0A0A;font-weight:700;font-size:14px;text-decoration:none;padding:14px 24px;border-radius:12px;margin-top:8px;">
      ${label}
    </a>
  `;
}
