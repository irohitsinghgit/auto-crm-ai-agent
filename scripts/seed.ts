import * as crm from '../lib/crm';

// Safe to run repeatedly: every record is looked up first and only created when missing.

interface SeedContact {
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  deal?: Omit<Parameters<typeof crm.createDeal>[0], 'contactId'>;
}

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
    deal: {
      name: 'Vikram Mehta - Scorpio-N Z8L',
      stage: crm.BOOKED_STAGE,
      amount: 2100000,
      closingDate: '2026-09-28',
      vehicleModel: 'Scorpio-N Z8L',
      bookingId: 'MAH-9921',
      allocationStatus: 'In Transit',
    },
  },
  {
    firstName: 'Amit',
    lastName: 'Verma',
    phone: '9876543201',
    email: 'amit@example.com',
  },
];

function log(action: 'exists' | 'created', label: string, id: string) {
  console.log(`${action.padEnd(8)} ${label} (${id})`);
}

async function seedLead() {
  const [existing] = await crm.findLeadsByPhone(LEAD.phone);
  if (existing) return log('exists', `Lead ${existing.name}`, existing.id);
  log('created', `Lead ${LEAD.firstName} ${LEAD.lastName}`, await crm.createLead(LEAD));
}

async function seedContact({ deal, ...contact }: SeedContact) {
  const label = `${contact.firstName} ${contact.lastName}`;
  const [existing] = await crm.findContactsByPhone(contact.phone);
  const contactId = existing?.id ?? (await crm.createContact(contact));
  log(existing ? 'exists' : 'created', `Contact ${label}`, contactId);

  if (!deal) return;
  const [existingDeal] = await crm.findDealsByName(deal.name);
  if (existingDeal) return log('exists', `Deal ${deal.name}`, existingDeal.id);
  log('created', `Deal ${deal.name}`, await crm.createDeal({ ...deal, contactId }));
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
