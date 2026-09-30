export type DeliveryResult = 'sent' | 'duplicate' | 'schedule_failed' | 'send_failed';

/**
 * Record today's dedupe row first, then send. A rerun on the same day hits
 * the dedupe conflict (null id) and sends nothing; a send failure after the
 * row is written means the user misses today rather than getting a duplicate.
 */
export async function deliverDigest(steps: {
  schedule: () => Promise<string | null>;
  send: () => Promise<void>;
}): Promise<DeliveryResult> {
  let jobId: string | null;
  try {
    jobId = await steps.schedule();
  } catch (error) {
    console.error('digest dedupe write failed', { error: String(error) });
    return 'schedule_failed';
  }
  if (!jobId) return 'duplicate';

  try {
    await steps.send();
    return 'sent';
  } catch (error) {
    console.error('Customer.io event failed', { error: String(error) });
    return 'send_failed';
  }
}
