import { zoho, getAccessToken } from '../lib/zoho';
import * as crm from '../lib/crm';

const REQUIRED_FIELDS: Record<string, string[]> = {
  Leads: ['Vehicle_Model', 'Preferred_City'],
  Deals: [
    'Vehicle_Model', 'Booking_ID', 'Allocation_Status', 'Test_Drive_Time', 'Follow_Up_Preference', 'Contact_Name',
    'VIN', 'Expected_Delivery', 'Balance_Amount',
  ],
  Cases: ['Registration_No', 'Odometer', 'Service_Center', 'Related_To'],
};

let failures = 0;

async function check(name: string, fn: () => Promise<string | void>) {
  try {
    const detail = await fn();
    console.log(`PASS  ${name}${detail ? `  (${detail})` : ''}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${name}  ${(err as Error).message}`);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

await check('token refresh', async () => {
  const token = await getAccessToken(true);
  assert(token.length > 20, 'empty access token');
});

await check('retry once on 401 with a stale token', async () => {
  const cache = (globalThis as any).__zohoToken;
  cache.token = 'invalid-token';
  cache.expiresAt = Date.now() + 3_600_000;
  const contacts = await crm.findContactsByPhone('9876500002');
  assert(contacts.length > 0, 'request did not recover after 401');
});

for (const [module, fields] of Object.entries(REQUIRED_FIELDS)) {
  await check(`${module} custom fields exist`, async () => {
    const res = await zoho.get<{ fields: { api_name: string }[] }>('/settings/fields', { module });
    const names = new Set(res?.fields.map((f) => f.api_name));
    const missing = fields.filter((f) => !names.has(f));
    assert(missing.length === 0, `missing ${missing.join(', ')}`);
  });
}

await check('search contact by phone', async () => {
  const [contact] = await crm.findContactsByPhone('9876500002');
  assert(contact, 'Priya Patel not found');
  const deals = await crm.findDealsByContact(contact.id);
  assert(deals.length > 0, 'no deals linked to contact');
  return `${contact.name}, ${deals.length} deal(s), stage ${deals[0].stage}`;
});

await check('search with no match returns empty (HTTP 204)', async () => {
  const contacts = await crm.findContactsByPhone('9000000000');
  assert(contacts.length === 0, 'expected no matches');
});

await check('search deal by booking id', async () => {
  const [deal] = await crm.findDealsByBookingId('MAH-9921');
  assert(deal, 'booking MAH-9921 not found');
  return `${deal.name}, ${deal.allocationStatus}`;
});

await check('unknown deal id returns null', async () => {
  const deal = await crm.getDeal('1000000000000000001');
  assert(deal === null, 'expected null');
});

await check('create and delete a lead', async () => {
  const id = await crm.createLead({
    firstName: 'Smoke',
    lastName: 'Test',
    phone: '9000000001',
    email: 'smoke.test@example.com',
    city: 'Pune',
    vehicleModel: 'XUV700',
    description: 'Created by scripts/test-zoho.ts',
  });
  // Read back by id: the search index lags a few seconds behind new records.
  try {
    const res = await zoho.get<{ data: { Vehicle_Model: string; Preferred_City: string }[] }>(`/Leads/${id}`, {
      fields: 'Vehicle_Model,Preferred_City',
    });
    const lead = res?.data[0];
    assert(lead?.Vehicle_Model === 'XUV700' && lead.Preferred_City === 'Pune', 'custom fields not saved');
  } finally {
    await crm.deleteRecord('Leads', id);
  }
  return `lead ${id} created, verified and removed`;
});

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exitCode = failures ? 1 : 0;
