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

/** Shared layout so the three v1 templates look like one product, not three. */
export function layout(bodyHtml: string): string {
  return `
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
    <body style="margin:0;padding:0;background:#F5F5F5;font-family:sans-serif;">
      <div style="max-width:600px;margin:32px auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 12px rgba(0,0,0,0.08);">
        <div style="background:#ffde59;padding:24px 28px;">
          <span style="font-size:16px;font-weight:800;color:#0A0A0A;">Jobply</span>
        </div>
        <div style="padding:28px;">
          ${bodyHtml}
        </div>
        <div style="padding:0 28px 24px;">
          <p style="margin:0;font-size:12px;color:#A3A3A3;">
            Jobply · <a href="https://jobply.ai/dashboard/settings" style="color:#A3A3A3;">Manage email preferences</a>
          </p>
        </div>
      </div>
    </body>
    </html>
  `;
}

export function button(label: string, url: string): string {
  return `
    <a href="${url}" style="display:inline-block;background:#ffde59;color:#0A0A0A;font-weight:700;font-size:14px;text-decoration:none;padding:14px 24px;border-radius:12px;margin-top:8px;">
      ${label}
    </a>
  `;
}
