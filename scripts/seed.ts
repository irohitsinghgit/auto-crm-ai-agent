import * as crm from '../lib/crm';

// Safe to run repeatedly: records are looked up first and created only when missing. On existing
// records, fields that are empty in the CRM are filled in; values already set are never overwritten.

interface SeedContact {
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  city: string;
  deal?: Omit<crm.DealInput, 'contactId'>;
}

const BACKFILL_DEAL_FIELDS = [
  'vehicleModel', 'bookingId', 'allocationStatus', 'testDriveTime', 'vin', 'expectedDelivery', 'balanceAmount',
] as const;

const LEAD = {
  firstName: 'Rajesh',
  lastName: 'Sharma',
  phone: '9876500001',
  email: 'rajesh.sharma@example.com',
  city: 'Mumbai',
  vehicleModel: 'Thar',
  description: 'Demo lead',
};

const CONTACTS: SeedContact[] = [
  {
    firstName: 'Priya',
    lastName: 'Patel',
    phone: '9876500002',
    email: 'priya.patel@example.com',
    city: 'Mumbai',
    deal: {
      name: 'Priya Patel - XUV700',
      stage: 'Qualification',
      amount: 2200000,
      closingDate: '2026-10-30',
      vehicleModel: 'XUV700',
      testDriveTime: '30 Sep 2026, 11:00 AM',
    },
  },
  {
    firstName: 'Vikram',
    lastName: 'Mehta',
    phone: '9876543210',
    email: 'vikram.mehta@example.com',
    city: 'Pune',
    deal: {
      name: 'Vikram Mehta - Scorpio-N Z8L',
      stage: crm.BOOKED_STAGE,
      amount: 2100000,
      closingDate: '2026-09-28',
      vehicleModel: 'Scorpio-N Z8L',
      bookingId: 'MAH-9921',
      allocationStatus: 'In Transit',
      vin: 'MA1TA2NE4P1234567',
      expectedDelivery: '2026-10-10',
      balanceAmount: 1600000,
    },
  },
  {
    firstName: 'Amit',
    lastName: 'Verma',
    phone: '9876543201',
    email: 'amit@example.com',
    city: 'Mumbai',
  },
];

function log(action: 'exists' | 'created' | 'updated', label: string, id: string, detail = '') {
  console.log(`${action.padEnd(8)} ${label} (${id})${detail ? `  ${detail}` : ''}`);
}

async function seedLead() {
  const [existing] = await crm.findLeadsByPhone(LEAD.phone);
  if (existing) return log('exists', `Lead ${existing.name}`, existing.id);
  log('created', `Lead ${LEAD.firstName} ${LEAD.lastName}`, await crm.createLead(LEAD));
}

async function seedContact({ deal, ...contact }: SeedContact) {
  const label = `Contact ${contact.firstName} ${contact.lastName}`;
  const [existing] = await crm.findContactsByPhone(contact.phone);
  let contactId: string;

  if (!existing) {
    contactId = await crm.createContact(contact);
    log('created', label, contactId);
  } else if (!existing.city) {
    contactId = existing.id;
    await crm.updateContactCity(contactId, contact.city);
    log('updated', label, contactId, `Mailing_City=${contact.city}`);
  } else {
    contactId = existing.id;
    log('exists', label, contactId);
  }

  if (deal) await seedDeal(deal, contactId);
}

async function seedDeal(deal: Omit<crm.DealInput, 'contactId'>, contactId: string) {
  const [existing] = await crm.findDealsByName(deal.name);
  if (!existing) {
    return log('created', `Deal ${deal.name}`, await crm.createDeal({ ...deal, contactId }));
  }

  const missing = BACKFILL_DEAL_FIELDS.filter((key) => deal[key] != null && existing[key] == null);
  if (!missing.length) return log('exists', `Deal ${deal.name}`, existing.id);

  await crm.updateDeal(existing.id, Object.fromEntries(missing.map((key) => [key, deal[key]])));
  log('updated', `Deal ${deal.name}`, existing.id, missing.join(', '));
}

try {
  await seedLead();
  for (const contact of CONTACTS) {
    await seedContact(contact);
  }
  console.log('\nSeed complete');
} catch (err) {
  console.error(`Seed failed: ${(err as Error).message}`);
  process.exitCode = 1;
}
