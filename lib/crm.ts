import { zoho, ZohoError } from './zoho';

export const BOOKED_STAGE = 'Closed Won';

type ZohoRecord = Record<string, any>;
interface ListResponse {
  data: ZohoRecord[];
}
interface WriteResponse {
  data: { status: string; code: string; message: string; details: { id: string } }[];
}

export interface Lead {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  city: string | null;
  vehicleModel: string | null;
}

export interface Contact {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  city: string | null;
}

export interface Deal {
  id: string;
  name: string;
  stage: string;
  amount: number | null;
  closingDate: string | null;
  contact: { id: string; name: string } | null;
  vehicleModel: string | null;
  bookingId: string | null;
  allocationStatus: string | null;
  testDriveTime: string | null;
  followUpPreference: string | null;
  vin: string | null;
  expectedDelivery: string | null;
  balanceAmount: number | null;
}

export interface ServiceCase {
  id: string;
  caseNumber: string | null;
  status: string;
}

const LEAD_FIELDS = 'Full_Name,Phone,Mobile,Email,City,Preferred_City,Vehicle_Model';
const CONTACT_FIELDS = 'Full_Name,Phone,Mobile,Email,Mailing_City';
// Owner is deliberately not fetched: the CRM user behind a record is never shown to customers.
const DEAL_FIELDS = [
  'Deal_Name', 'Stage', 'Amount', 'Closing_Date', 'Contact_Name',
  'Vehicle_Model', 'Booking_ID', 'Allocation_Status', 'Test_Drive_Time', 'Follow_Up_Preference',
  'VIN', 'Expected_Delivery', 'Balance_Amount',
].join(',');

function toLead(r: ZohoRecord): Lead {
  return {
    id: r.id,
    name: r.Full_Name,
    phone: r.Phone ?? r.Mobile ?? null,
    email: r.Email ?? null,
    city: r.Preferred_City ?? r.City ?? null,
    vehicleModel: r.Vehicle_Model ?? null,
  };
}

function toContact(r: ZohoRecord): Contact {
  return { id: r.id, name: r.Full_Name, phone: r.Phone ?? r.Mobile ?? null, email: r.Email ?? null, city: r.Mailing_City ?? null };
}

function toDeal(r: ZohoRecord): Deal {
  return {
    id: r.id,
    name: r.Deal_Name,
    stage: r.Stage,
    amount: r.Amount ?? null,
    closingDate: r.Closing_Date ?? null,
    contact: r.Contact_Name ? { id: r.Contact_Name.id, name: r.Contact_Name.name } : null,
    vehicleModel: r.Vehicle_Model ?? null,
    bookingId: r.Booking_ID ?? null,
    allocationStatus: r.Allocation_Status ?? null,
    testDriveTime: r.Test_Drive_Time ?? null,
    followUpPreference: r.Follow_Up_Preference ?? null,
    vin: r.VIN ?? null,
    expectedDelivery: r.Expected_Delivery ?? null,
    balanceAmount: r.Balance_Amount ?? null,
  };
}

// Zoho criteria values must escape parentheses, commas and backslashes.
function criteria(field: string, value: string): string {
  return `(${field}:equals:${value.replace(/[\\(),]/g, '\\$&')})`;
}

function createdId(res: WriteResponse | null): string {
  const result = res?.data?.[0];
  if (!result || result.status !== 'success') {
    throw new ZohoError(result?.message ?? 'Zoho did not confirm the write', { code: result?.code });
  }
  return result.details.id;
}

export async function findLeadsByPhone(phone: string): Promise<Lead[]> {
  const res = await zoho.get<ListResponse>('/Leads/search', { phone, fields: LEAD_FIELDS });
  return (res?.data ?? []).map(toLead);
}

export async function createLead(input: {
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  city: string;
  vehicleModel: string;
  description?: string;
}): Promise<string> {
  const res = await zoho.post<WriteResponse>('/Leads', {
    data: [
      {
        First_Name: input.firstName,
        Last_Name: input.lastName,
        Phone: input.phone,
        Mobile: input.phone,
        Email: input.email,
        City: input.city,
        Preferred_City: input.city,
        Vehicle_Model: input.vehicleModel,
        Lead_Source: 'Chat',
        Lead_Status: 'Not Contacted',
        Description: input.description,
      },
    ],
  });
  return createdId(res);
}

export async function findContactsByPhone(phone: string): Promise<Contact[]> {
  const res = await zoho.get<ListResponse>('/Contacts/search', { phone, fields: CONTACT_FIELDS });
  return (res?.data ?? []).map(toContact);
}

export async function getContact(id: string): Promise<Contact | null> {
  const res = await zoho.get<ListResponse>(`/Contacts/${id}`, { fields: CONTACT_FIELDS });
  return res?.data?.[0] ? toContact(res.data[0]) : null;
}

export async function createContact(input: { firstName: string; lastName: string; phone: string; email?: string; city?: string }): Promise<string> {
  const res = await zoho.post<WriteResponse>('/Contacts', {
    data: [
      {
        First_Name: input.firstName,
        Last_Name: input.lastName,
        Phone: input.phone,
        Mobile: input.phone,
        Email: input.email,
        Mailing_City: input.city,
      },
    ],
  });
  return createdId(res);
}

export async function updateContactCity(contactId: string, city: string): Promise<void> {
  const res = await zoho.put<WriteResponse>(`/Contacts/${contactId}`, { data: [{ Mailing_City: city }] });
  createdId(res);
}

export async function getDeal(id: string): Promise<Deal | null> {
  try {
    const res = await zoho.get<ListResponse>(`/Deals/${id}`, { fields: DEAL_FIELDS });
    return res?.data?.[0] ? toDeal(res.data[0]) : null;
  } catch (err) {
    // Unknown record ids come back as INVALID_DATA rather than 404.
    if (err instanceof ZohoError && (err.status === 404 || err.code === 'INVALID_DATA')) return null;
    throw err;
  }
}

export async function findDealsByContact(contactId: string): Promise<Deal[]> {
  const res = await zoho.get<ListResponse>(`/Contacts/${contactId}/Deals`, { fields: DEAL_FIELDS });
  return (res?.data ?? []).map(toDeal);
}

export async function findDealsByBookingId(bookingId: string): Promise<Deal[]> {
  const res = await zoho.get<ListResponse>('/Deals/search', { criteria: criteria('Booking_ID', bookingId), fields: DEAL_FIELDS });
  return (res?.data ?? []).map(toDeal);
}

export async function findDealsByName(name: string): Promise<Deal[]> {
  const res = await zoho.get<ListResponse>('/Deals/search', { criteria: criteria('Deal_Name', name), fields: DEAL_FIELDS });
  return (res?.data ?? []).map(toDeal);
}

export interface DealInput {
  name: string;
  stage: string;
  contactId: string;
  amount?: number;
  closingDate?: string;
  vehicleModel?: string;
  bookingId?: string;
  allocationStatus?: string;
  testDriveTime?: string;
  followUpPreference?: string;
  vin?: string;
  expectedDelivery?: string;
  balanceAmount?: number;
}

// Undefined values are dropped by JSON serialisation, so partial updates only touch the fields given.
function toDealRecord(input: Partial<DealInput>) {
  return {
    Deal_Name: input.name,
    Stage: input.stage,
    Contact_Name: input.contactId ? { id: input.contactId } : undefined,
    Amount: input.amount,
    Closing_Date: input.closingDate,
    Vehicle_Model: input.vehicleModel,
    Booking_ID: input.bookingId,
    Allocation_Status: input.allocationStatus,
    Test_Drive_Time: input.testDriveTime,
    Follow_Up_Preference: input.followUpPreference,
    VIN: input.vin,
    Expected_Delivery: input.expectedDelivery,
    Balance_Amount: input.balanceAmount,
  };
}

export async function createDeal(input: DealInput): Promise<string> {
  const res = await zoho.post<WriteResponse>('/Deals', { data: [toDealRecord(input)] });
  return createdId(res);
}

export async function updateDeal(dealId: string, changes: Partial<DealInput>): Promise<void> {
  const res = await zoho.put<WriteResponse>(`/Deals/${dealId}`, { data: [toDealRecord(changes)] });
  createdId(res);
}

export async function createServiceCase(input: {
  contactId: string;
  subject: string;
  description: string;
  type?: string;
  registrationNo: string;
  odometer: string;
  serviceCenter: string;
}): Promise<ServiceCase> {
  const res = await zoho.post<WriteResponse>('/Cases', {
    data: [
      {
        Subject: input.subject,
        Description: input.description,
        Status: 'New',
        Case_Origin: 'Web',
        Type: input.type,
        Related_To: { id: input.contactId },
        Registration_No: input.registrationNo,
        Odometer: input.odometer,
        Service_Center: input.serviceCenter,
      },
    ],
  });
  const id = createdId(res);

  const created = await zoho.get<ListResponse>(`/Cases/${id}`, { fields: 'Case_Number,Status' });
  const record = created?.data?.[0];
  return { id, caseNumber: record?.Case_Number ?? null, status: record?.Status ?? 'New' };
}

export async function deleteRecord(module: 'Leads' | 'Cases', id: string): Promise<void> {
  await zoho.delete(`/${module}`, { ids: id });
}
