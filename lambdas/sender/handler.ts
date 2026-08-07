/**
 * Sender Lambda — Part B (SES)
 *
 * SQS-triggered. For each queued email_job: re-checks eligibility
 * (authorize_email_send), renders the versioned template, sends via the SES
 * v2 API tagged with email_job_id/journey_key/user_ref so the existing Part A
 * feedback Lambda can correlate a later bounce/complaint back to this job.
 *
 * Uses partial batch response (ReportBatchItemFailures) so one bad message
 * doesn't cause SQS to redeliver the whole batch.
 *
 * Also computes a signed unsubscribe-link URL per send (HMAC-SHA256 of
 * "userId:recipientEmail") and threads it into every template's payload, so
 * jobply_website's /api/email/unsubscribe route can verify it without a
 * database round trip before mutating email_preferences.
 *
 * Env vars:
 *   SUPABASE_SECRET_ID     ARN/name of the Secrets Manager secret holding
 *                          { "url": "...", "serviceKey": "...",
 *                            "emailUnsubscribeSecret": "..." }
 *   FROM_EMAIL              e.g. "Jobply <hello@jobply.ai>"
 *   CONFIGURATION_SET_NAME  SES configuration set (jobply-default)
 *   UNSUBSCRIBE_BASE_URL    Base URL for the unsubscribe page (default
 *                           https://jobply.ai/email/unsubscribe)
 *
 * Deps: @aws-sdk/client-secrets-manager, @aws-sdk/client-sesv2, @supabase/supabase-js
 */

import { createHmac } from 'node:crypto';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getTemplate } from './templates';

const FROM_EMAIL = process.env.FROM_EMAIL ?? 'Jobply <hello@jobply.ai>';
const CONFIGURATION_SET_NAME = process.env.CONFIGURATION_SET_NAME ?? 'jobply-default';
const UNSUBSCRIBE_BASE_URL = process.env.UNSUBSCRIBE_BASE_URL ?? 'https://jobply.ai/email/unsubscribe';

let cachedClient: SupabaseClient | null = null;
let cachedUnsubscribeSecret: string | null = null;

async function loadSecret(): Promise<{ url: string; serviceKey: string; emailUnsubscribeSecret: string }> {
  const secretId = process.env.SUPABASE_SECRET_ID;
  if (!secretId) throw new Error('SUPABASE_SECRET_ID not set');

  const sm = new SecretsManagerClient({});
  const res = await sm.send(new GetSecretValueCommand({ SecretId: secretId }));
  const { url, serviceKey, emailUnsubscribeSecret } = JSON.parse(res.SecretString ?? '{}');
  if (!url || !serviceKey) throw new Error('Supabase secret missing url/serviceKey');
  if (!emailUnsubscribeSecret) throw new Error('Supabase secret missing emailUnsubscribeSecret');

  return { url, serviceKey, emailUnsubscribeSecret };
}

async function getSupabase(): Promise<SupabaseClient> {
  if (cachedClient) return cachedClient;
  const { url, serviceKey, emailUnsubscribeSecret } = await loadSecret();
  cachedClient = createClient(url, serviceKey, { auth: { persistSession: false } });
  cachedUnsubscribeSecret = emailUnsubscribeSecret;
  return cachedClient;
}

async function getUnsubscribeSecret(): Promise<string> {
  if (cachedUnsubscribeSecret) return cachedUnsubscribeSecret;
  await getSupabase(); // populates cachedUnsubscribeSecret as a side effect
  return cachedUnsubscribeSecret!;
}

/** Same HMAC scheme jobply_website/app/api/email/unsubscribe verifies against. */
function buildUnsubscribeUrl(secret: string, userId: string, recipientEmail: string): string {
  const token = createHmac('sha256', secret).update(`${userId}:${recipientEmail}`).digest('hex');
  const params = new URLSearchParams({ uid: userId, token });
  return `${UNSUBSCRIBE_BASE_URL}?${params.toString()}`;
}

const ses = new SESv2Client({});

interface EmailJobRow {
  id: string;
  user_id: string;
  recipient_email: string;
  journey_key: string;
  template_key: string;
  template_version: number;
  payload: Record<string, unknown>;
}

interface QueueMessage {
  email_job_id: string;
  environment: string;
}

interface SQSRecordLike {
  messageId: string;
  body: string;
}

/** Known-before-SES failures (validation, missing template) are permanent. */
class PermanentSendError extends Error {}

async function processOne(supabase: SupabaseClient, jobId: string): Promise<void> {
  const { data: authRows, error: authError } = await supabase.rpc('authorize_email_send', {
    p_job_id: jobId,
  });

  if (authError) {
    // Unknown DB error — retryable, let SQS redeliver.
    throw authError;
  }

  const authResult = authRows?.[0] as
    | { authorized: boolean; reason: string; job: EmailJobRow }
    | undefined;

  if (!authResult) {
    throw new Error(`authorize_email_send returned no rows for job ${jobId}`);
  }

  if (!authResult.authorized) {
    // cancelled / suppressed / already_processed — not an error, nothing to send.
    console.log('send not authorized, skipping', { jobId, reason: authResult.reason });
    return;
  }

  const job = authResult.job;
  const template = getTemplate(job.template_key);
  if (!template) {
    await markFailed(supabase, job.id, 'unknown_template', `No template registered for ${job.template_key}`, true);
    throw new PermanentSendError(`No template registered for ${job.template_key}`);
  }

  const unsubscribeSecret = await getUnsubscribeSecret();
  const unsubscribeUrl = buildUnsubscribeUrl(unsubscribeSecret, job.user_id, job.recipient_email);
  const rendered = template.render({ ...(job.payload ?? {}), unsubscribeUrl });

  try {
    const result = await ses.send(new SendEmailCommand({
      FromEmailAddress: FROM_EMAIL,
      Destination: { ToAddresses: [job.recipient_email] },
      Content: {
        Simple: {
          Subject: { Data: rendered.subject, Charset: 'UTF-8' },
          Body: {
            Html: { Data: rendered.html, Charset: 'UTF-8' },
            Text: { Data: rendered.text, Charset: 'UTF-8' },
          },
          // RFC 8058 one-click unsubscribe — this is what makes Gmail/Yahoo/Outlook
          // render a native "Unsubscribe" link next to the sender, independent of
          // anything in the HTML body.
          Headers: [
            { Name: 'List-Unsubscribe', Value: `<${unsubscribeUrl}>` },
            { Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click' },
          ],
        },
      },
      ConfigurationSetName: CONFIGURATION_SET_NAME,
      EmailTags: [
        { Name: 'email_job_id', Value: job.id },
        { Name: 'journey_key', Value: job.journey_key },
        { Name: 'user_ref', Value: job.user_id },
      ],
    }));

    const { error: markError } = await supabase.rpc('mark_email_job_sent', {
      p_job_id: job.id,
      p_ses_message_id: result.MessageId ?? null,
    });
    if (markError) {
      // SES already accepted the send — do NOT retry (would double-send).
      // Log loudly; the job stays 'sending', picked up by the
      // delivery_unknown reconciliation described in the plan.
      console.error('SES accepted but mark_email_job_sent failed — job left in sending state', {
        jobId: job.id,
        sesMessageId: result.MessageId,
        error: markError,
      });
    }
  } catch (sendError) {
    // We don't know if SES accepted the message before the error (network
    // timeout etc.) — mark ambiguous rather than blindly retrying, which
    // could double-send. A human/reconciliation job resolves 'sending'
    // rows that never receive a matching SES event.
    console.error('SES send failed or outcome ambiguous', { jobId: job.id, error: sendError });
    await markFailed(supabase, job.id, 'ses_send_error', String(sendError), false);
    throw sendError;
  }
}

async function markFailed(
  supabase: SupabaseClient,
  jobId: string,
  code: string,
  message: string,
  permanent: boolean,
): Promise<void> {
  const { error } = await supabase.rpc('mark_email_job_failed', {
    p_job_id: jobId,
    p_error_code: code,
    p_error: message,
    p_permanent: permanent,
  });
  if (error) console.error('mark_email_job_failed also failed', { jobId, error });
}

export async function handler(event: { Records: SQSRecordLike[] }): Promise<{ batchItemFailures: { itemIdentifier: string }[] }> {
  const supabase = await getSupabase();
  const batchItemFailures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    let message: QueueMessage;
    try {
      message = JSON.parse(record.body);
    } catch {
      console.error('Unparseable SQS message body, dropping', { messageId: record.messageId });
      continue; // poison message — don't retry, don't fail the batch for it
    }

    try {
      await processOne(supabase, message.email_job_id);
    } catch (error) {
      if (error instanceof PermanentSendError) {
        // Already marked permanent_failure — don't ask SQS to retry.
        console.error('Permanent send failure, not retrying', { jobId: message.email_job_id, error });
        continue;
      }
      console.error('Send failed, will retry via SQS redelivery', { jobId: message.email_job_id, error });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
}
