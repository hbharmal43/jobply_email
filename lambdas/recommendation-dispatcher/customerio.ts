export interface CustomerIoCreds { siteId: string; apiKey: string }

/**
 * Customer.io Track API v1 (US region). `customerId` is the Supabase user
 * UUID, which is the `id` the Jobply User Sync assigns to every profile.
 */
export async function sendCustomerIoEvent(
  creds: CustomerIoCreds,
  customerId: string,
  name: string,
  data: object,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const res = await fetchImpl(
    `https://track.customer.io/api/v1/customers/${encodeURIComponent(customerId)}/events`,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${creds.siteId}:${creds.apiKey}`).toString('base64')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name, data }),
    },
  );
  if (!res.ok) throw new Error(`Customer.io track ${res.status}: ${(await res.text()).slice(0, 200)}`);
}
