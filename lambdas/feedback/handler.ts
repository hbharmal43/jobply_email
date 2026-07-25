/**
 * Feedback Lambda — Part A (SES)
 *
 * Consumes SES events delivered via EventBridge (from the Configuration Set's
 * event destination), normalizes them, and calls email_api.record_email_feedback
 * in Supabase. Hard bounces and complaints create suppressions.
 *
 * Trigger: EventBridge rule with pattern { "source": ["aws.ses"] }.
 *
 * Env vars:
 *   SUPABASE_SECRET_ID   ARN/name of the Secrets Manager secret holding
 *                        { "url": "...", "serviceKey": "..." }
 *
 * Deps: @aws-sdk/client-secrets-manager, @supabase/supabase-js
 */

import { createHash } from 'node:crypto';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// --- SES → our event_type enum -------------------------------------------------
const EVENT_TYPE_MAP: Record<string, string> = {
  Send: 'send_accepted',
  Delivery: 'delivered',
  DeliveryDelay: 'delivery_delayed',
  Bounce: 'bounced',
  Complaint: 'complained',
  Open: 'opened',
  Click: 'clicked',
  Reject: 'rejected',
  RenderingFailure: 'rendering_failed',
};

// --- Cached Supabase client (survives warm invocations) ------------------------
let cachedClient: SupabaseClient | null = null;

async function getSupabase(): Promise<SupabaseClient> {
  if (cachedClient) return cachedClient;
  const secretId = process.env.SUPABASE_SECRET_ID;
  if (!secretId) throw new Error('SUPABASE_SECRET_ID not set');

  const sm = new SecretsManagerClient({});
  const res = await sm.send(new GetSecretValueCommand({ SecretId: secretId }));
  const { url, serviceKey } = JSON.parse(res.SecretString ?? '{}');
  if (!url || !serviceKey) throw new Error('Supabase secret missing url/serviceKey');

  cachedClient = createClient(url, serviceKey, { auth: { persistSession: false } });
  return cachedClient;
}

// --- Helpers -------------------------------------------------------------------
const firstTag = (tags: Record<string, string[]> | undefined, name: string): string | undefined =>
  tags?.[name]?.[0];

const isUuid = (v: string | undefined): v is string =>
  !!v && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

function recipientOf(detail: any, sesType: string): string | undefined {
  if (sesType === 'Bounce') return detail.bounce?.bouncedRecipients?.[0]?.emailAddress;
  if (sesType === 'Complaint') return detail.complaint?.complainedRecipients?.[0]?.emailAddress;
  return detail.mail?.destination?.[0];
}

/** Deterministic key so duplicate SES deliveries collapse to one event row. */
function providerEventKey(messageId: string, sesType: string, ts: string, recipient?: string): string {
  return createHash('sha256')
    .update(`${messageId}|${sesType}|${ts}|${recipient ?? ''}`)
    .digest('hex');
}

// --- Handler -------------------------------------------------------------------
export async function handler(event: any): Promise<void> {
  if (event?.source !== 'aws.ses') {
    console.warn('Ignoring non-SES event', { source: event?.source });
    return;
  }

  const detail = event.detail ?? {};
  const sesType: string = detail.eventType;
  const ourType = EVENT_TYPE_MAP[sesType];
  if (!ourType) {
    console.warn('Unmapped SES event type', { sesType });
    return;
  }

  const mail = detail.mail ?? {};
  const messageId: string = mail.messageId;
  const tags = mail.tags as Record<string, string[]> | undefined;
  const emailJobId = firstTag(tags, 'email_job_id');
  const userRef = firstTag(tags, 'user_ref');
  const recipient = recipientOf(detail, sesType);

  // Per-event timestamp (fall back to mail timestamp / now).
  const eventAt: string =
    detail.bounce?.timestamp ??
    detail.complaint?.timestamp ??
    detail.delivery?.timestamp ??
    mail.timestamp ??
    new Date().toISOString();

  const metadata: Record<string, unknown> = { ses_event_type: sesType };
  if (sesType === 'Bounce') {
    metadata.bounce_type = detail.bounce?.bounceType;        // 'Permanent' | 'Transient'
    metadata.bounce_subtype = detail.bounce?.bounceSubType;
  } else if (sesType === 'Complaint') {
    metadata.complaint_feedback_type = detail.complaint?.complaintFeedbackType;
  }

  const supabase = await getSupabase();
  const { data, error } = await supabase
    .rpc('record_email_feedback', {
      p_provider_event_key: providerEventKey(messageId, sesType, eventAt, recipient),
      p_event_type: ourType,
      p_event_at: eventAt,
      p_ses_message_id: messageId,
      p_email_job_id: isUuid(emailJobId) ? emailJobId : null,
      p_user_id: isUuid(userRef) ? userRef : null,
      p_recipient_email: recipient ?? null,
      p_metadata: metadata,
      p_raw_payload: detail,
    });

  if (error) {
    // Throw so EventBridge/Lambda retries; the RPC is idempotent so retries are safe.
    console.error('record_email_feedback failed', { messageId, sesType, error: error.message });
    throw error;
  }

  console.log('feedback recorded', { messageId, sesType, ourType, result: data });
}
