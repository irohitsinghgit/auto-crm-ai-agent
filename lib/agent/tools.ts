import type { ChatCompletionTool } from 'groq-sdk/resources/chat/completions';
import * as crm from '../crm';
import * as validate from '../validation';
import { ValidationError } from '../validation';
import { ZohoError } from '../zoho';
import { getVehicleInfo, vehicleLabel, MODEL_NAMES } from '../catalog';
import { findDealer } from '../dealers';

export type Stage = 'new_lead' | 'pipeline' | 'booked' | 'service';

export interface ToolContext {
  knownContactIds: Set<string>;
  knownDealIds: Set<string>;
  // Phones searched without a match; only these may be registered as new contacts.
  unmatchedPhones: Set<string>;
  // Phones that matched a CRM contact in this chat, mapped to that contact's name.
  matchedPhones: Map<string, string>;
  // Create requests awaiting customer approval, mapped to the turn the summary was produced in.
  pendingConfirmations: Map<string, number>;
  turn: number;
  // Records created in this session, keyed by content, so a repeated tool call cannot create duplicates.
  createdRecords: Map<string, Record<string, unknown>>;
  // 'customer' for details the customer stated; 'lookups' for records found in the CRM, which may be another person's.
  remember: (details: Record<string, string | undefined>, source?: 'customer' | 'lookups') => void;
}

type Args = Record<string, unknown>;
type ToolResult = Record<string, unknown>;

interface Tool {
  stage: Stage;
  status: string;
  definition: ChatCompletionTool['function'];
  handler: (args: Args, ctx: ToolContext) => Promise<ToolResult>;
}

const SERVICE_TYPES = ['Periodic Service', 'Repair / Complaint', 'Warranty Claim', 'Accident Repair', 'General Check-up'];
const PROBLEM_SERVICE_TYPES = new Set(['Repair / Complaint', 'Warranty Claim', 'Accident Repair']);
const FOLLOW_UP_CHANNELS = ['Phone call', 'WhatsApp', 'SMS', 'Email'];

const ALLOCATION_MEANING: Record<string, string> = {
  'dispatch pending': 'A vehicle is allocated against the booking and is awaiting dispatch from the plant.',
  'in transit': 'The vehicle has been dispatched from the plant and is on its way to the dealership.',
  'at dealership': 'The vehicle has reached the dealership and is being prepared for delivery.',
  delivered: 'The vehicle has been delivered to the customer.',
};

const PAYMENT_LINK_BASE = 'https://pay.example.com/booking/';

const rupees = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });

// Zoho dates are plain YYYY-MM-DD; format them as calendar dates in IST.
const formatDate = (isoDate: string) =>
  new Date(`${isoDate}T00:00:00+05:30`).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });

const notFound = (message: string, nextStep: string): ToolResult => ({ ok: false, error: 'not_found', message, next_step: nextStep });

// The first miss on a number asks for a recheck; a repeat miss moves on to the fallback so the customer is not asked twice.
function phoneNotFound(repeatMiss: boolean, fallback: string): ToolResult {
  return notFound(
    'No customer is registered with this phone number.',
    repeatMiss
      ? `The customer has already rechecked this number; do not ask again. Instead, ${fallback}`
      : `Read the number back and ask the customer to recheck it. If they confirm it is correct, ${fallback}`,
  );
}

// Dealer details come from the dealership directory by the customer's city, never from CRM record owners.
function dealerInfo(city: string | null | undefined) {
  const dealer = findDealer(city);
  return dealer
    ? { dealer_contact: dealer }
    : { dealer_contact: null, dealer_note: 'No dealership is mapped for this customer; say the dealership will reach out to them directly.' };
}

async function dealerForDeal(deal: crm.Deal, knownContacts: crm.Contact[] = []) {
  if (!deal.contact) return dealerInfo(null);
  const contact = knownContacts.find((c) => c.id === deal.contact!.id) ?? (await crm.getContact(deal.contact.id));
  return dealerInfo(contact?.city);
}

async function describeDeal(deal: crm.Deal, knownContacts?: crm.Contact[]) {
  return {
    deal_id: deal.id,
    deal_name: deal.name,
    customer_name: deal.contact?.name ?? null,
    stage: deal.stage,
    vehicle_model: deal.vehicleModel,
    test_drive_time: deal.testDriveTime,
    quotation: deal.amount != null ? rupees.format(deal.amount) : null,
    currently_saved_follow_up: deal.followUpPreference,
    booking_id: deal.bookingId,
    ...(await dealerForDeal(deal, knownContacts)),
  };
}

async function describeBooking(deal: crm.Deal, knownContacts?: crm.Contact[]) {
  const status = deal.allocationStatus;
  const balance = deal.balanceAmount;
  const details = {
    vin: deal.vin,
    expected_delivery: deal.expectedDelivery ? formatDate(deal.expectedDelivery) : null,
    balance_due: balance != null ? rupees.format(balance) : null,
  };
  const notRecorded = Object.entries(details).filter(([, value]) => value == null).map(([key]) => key);

  return {
    booking_id: deal.bookingId,
    customer_name: deal.contact?.name ?? null,
    vehicle_model: deal.vehicleModel,
    booking_value: deal.amount != null ? rupees.format(deal.amount) : null,
    booked_on: deal.closingDate ? formatDate(deal.closingDate) : null,
    allocation_status: status,
    allocation_status_meaning: status ? ALLOCATION_MEANING[status.toLowerCase()] ?? null : null,
    ...details,
    ...(balance && balance > 0 && deal.bookingId ? { payment_link: `${PAYMENT_LINK_BASE}${encodeURIComponent(deal.bookingId)}` } : {}),
    ...(notRecorded.length ? { not_yet_recorded: notRecorded } : {}),
    ...(await dealerForDeal(deal, knownContacts)),
  };
}

async function contactsByPhone(phone: string, ctx: ToolContext) {
  const repeatMiss = ctx.unmatchedPhones.has(phone);
  const contacts = await crm.findContactsByPhone(phone);
  contacts.forEach((c) => ctx.knownContactIds.add(c.id));
  if (contacts[0]) {
    ctx.matchedPhones.set(phone, contacts[0].name);
    ctx.remember({ record_name: contacts[0].name, record_phone: phone }, 'lookups');
  } else {
    ctx.unmatchedPhones.add(phone);
  }
  return { contacts, repeatMiss };
}

async function dealsByPhone(phone: string, ctx: ToolContext) {
  const { contacts, repeatMiss } = await contactsByPhone(phone, ctx);
  const deals = (await Promise.all(contacts.map((c) => crm.findDealsByContact(c.id)))).flat();
  return { contacts, deals, repeatMiss };
}

const CONFIRMED_PARAM = {
  type: 'boolean',
  description: 'Set true only on the call after the customer replied yes to the summary returned as confirmation_required.',
} as const;

// A create runs only after the customer approves its summary in a later message than the one that produced it,
// so the model cannot confirm on the customer's behalf. Any change to the details needs a fresh confirmation.
function confirmationGate(ctx: ToolContext, key: string, confirmed: unknown, summary: Record<string, unknown>): ToolResult | null {
  // Keys look like "lead:<phone>:<details>"; only the latest summary for a record can be approved.
  const recordPrefix = `${key.split(':').slice(0, 2).join(':')}:`;
  const clearRecord = () => {
    for (const pending of [...ctx.pendingConfirmations.keys()]) {
      if (pending.startsWith(recordPrefix)) ctx.pendingConfirmations.delete(pending);
    }
  };

  const askedInTurn = ctx.pendingConfirmations.get(key);
  if (confirmed === true && askedInTurn !== undefined && askedInTurn < ctx.turn) {
    clearRecord();
    return null;
  }
  clearRecord();
  ctx.pendingConfirmations.set(key, ctx.turn);
  return {
    ok: false,
    error: 'confirmation_required',
    summary,
    next_step: 'Nothing was saved yet. Show this summary to the customer and ask them to confirm. After they reply yes, call this tool again with the same details and customer_confirmed set to true.',
  };
}

function requireOne(args: Args, fields: string[]) {
  if (fields.every((f) => args[f] === undefined || args[f] === null || args[f] === '')) {
    throw new ValidationError(fields.join('|'), `Provide either ${fields.join(' or ')}.`);
  }
}

const tools: Record<string, Tool> = {
  get_vehicle_info: {
    stage: 'new_lead',
    status: 'Checking vehicle catalog',
    definition: {
      name: 'get_vehicle_info',
      description: 'Look up variants, ex-showroom prices, engines and features for a vehicle model from the official catalog. Use for any question about models, variants, pricing or specs.',
      parameters: {
        type: 'object',
        properties: {
          model: { type: 'string', description: `Model name. Available: ${MODEL_NAMES.join(', ')}.` },
          variant: { type: 'string', description: 'Optional variant name, e.g. AX7, LX, Z8 L.' },
        },
        required: ['model'],
      },
    },
    async handler(args, ctx) {
      const info = getVehicleInfo(validate.text(args.model, 'model', 60), args.variant ? validate.text(args.variant, 'variant', 30) : undefined);
      if (!info.found) {
        return { ok: false, error: 'not_found', ...info, next_step: 'Tell the customer which models are available and ask which one interests them.' };
      }
      ctx.remember({ vehicle_interest: 'variant' in info ? `${info.model} ${info.variant.name}` : info.model });
      return { ok: true, ...info };
    },
  },

  create_lead: {
    stage: 'new_lead',
    status: 'Creating lead',
    definition: {
      name: 'create_lead',
      description: 'Register a test drive or purchase enquiry. If the phone already has an enquiry, the request is noted on it instead. Call as soon as all details are collected; the first call returns a summary for the customer to confirm.',
      parameters: {
        type: 'object',
        properties: {
          first_name: { type: 'string' },
          last_name: { type: 'string' },
          phone: { type: 'string', description: '10-digit Indian mobile number' },
          email: { type: 'string' },
          city: { type: 'string', description: 'Preferred city for test drive and dealership' },
          vehicle_model: { type: 'string', description: 'Model of interest as the customer named it, optionally with variant, e.g. "XUV700 AX7". Resolved automatically; no catalog lookup needed.' },
          phone_confirmed: { type: 'boolean', description: 'Set true only if the customer explicitly said this number is theirs after being asked.' },
          customer_confirmed: CONFIRMED_PARAM,
        },
        required: ['first_name', 'last_name', 'phone', 'email', 'city', 'vehicle_model'],
      },
    },
    async handler(args, ctx) {
      const lead = {
        firstName: validate.personName(args.first_name, 'first_name'),
        lastName: validate.personName(args.last_name, 'last_name'),
        phone: validate.phone(args.phone),
        email: validate.email(args.email),
        city: validate.text(args.city, 'city', 60),
        vehicleModel: vehicleLabel(validate.text(args.vehicle_model, 'vehicle_model', 60)) ?? '',
      };
      if (!lead.vehicleModel) {
        throw new ValidationError('vehicle_model', `Choose one of: ${MODEL_NAMES.join(', ')}.`);
      }

      // A number found on another person's CRM record earlier in this chat must not be reused silently.
      const recordName = ctx.matchedPhones.get(lead.phone);
      const sameName = recordName?.toLowerCase() === `${lead.firstName} ${lead.lastName}`.toLowerCase();
      if (recordName && !sameName && args.phone_confirmed !== true) {
        return {
          ok: false,
          error: 'phone_belongs_to_other_record',
          message: 'This number belongs to a different customer record found earlier in this chat.',
          next_step: `Ask ${lead.firstName} for their own mobile number. Do not reveal whose record it is. Use this number only if they explicitly confirm it is theirs, then set phone_confirmed to true.`,
        };
      }
      ctx.remember({
        customer_name: `${lead.firstName} ${lead.lastName}`,
        phone: lead.phone,
        email: lead.email,
        city: lead.city,
        vehicle_interest: lead.vehicleModel,
      });

      const key = `lead:${lead.phone}`;
      const created = ctx.createdRecords.get(key);
      if (created) return { ok: true, already_created_in_this_chat: true, ...created };

      const gate = confirmationGate(ctx, `${key}:${JSON.stringify(lead)}`, args.customer_confirmed, {
        name: `${lead.firstName} ${lead.lastName}`,
        phone: lead.phone,
        email: lead.email,
        city: lead.city,
        vehicle_model: lead.vehicleModel,
      });
      if (gate) return gate;

      const [existing] = await crm.findLeadsByPhone(lead.phone);
      if (existing) {
        // Record the new request on the existing lead instead of creating a duplicate.
        await crm.addNote(
          'Leads',
          existing.id,
          'Test drive request via chat',
          `Test drive requested for ${lead.vehicleModel} in ${lead.city}. Name given: ${lead.firstName} ${lead.lastName}, email: ${lead.email}.`,
        );
        const result = {
          status: 'existing_lead_request_noted',
          customer_message: `We already have your details, and I've noted your test drive request for the ${lead.vehicleModel} in ${lead.city}.`,
          reply_guidance: 'Start the reply with customer_message. Do not say a new enquiry was registered.',
          ...dealerInfo(lead.city),
        };
        ctx.createdRecords.set(key, result);
        return { ok: true, ...result };
      }

      await crm.createLead({ ...lead, description: 'Test drive enquiry from the website chat assistant.' });
      const result = { status: 'created', vehicle_model: lead.vehicleModel, city: lead.city, ...dealerInfo(lead.city) };
      ctx.createdRecords.set(key, result);
      return { ok: true, ...result };
    },
  },

  find_deal: {
    stage: 'pipeline',
    status: 'Searching deals',
    definition: {
      name: 'find_deal',
      description: 'Find an existing prospect\'s deal to report test drive confirmation, quotation, stage and dealer contact. Provide phone or deal_id.',
      parameters: {
        type: 'object',
        properties: {
          phone: { type: 'string', description: 'Registered 10-digit mobile number' },
          deal_id: { type: 'string', description: 'Numeric CRM deal ID' },
        },
      },
    },
    async handler(args, ctx) {
      requireOne(args, ['phone', 'deal_id']);
      let deals: crm.Deal[];
      let contacts: crm.Contact[] = [];

      if (args.deal_id) {
        const deal = await crm.getDeal(validate.recordId(args.deal_id, 'deal_id'));
        if (!deal) {
          return notFound('No deal exists with this ID.', 'Ask the customer to recheck the deal ID or share their registered mobile number instead.');
        }
        deals = [deal];
      } else {
        const phone = validate.phone(args.phone);
        const result = await dealsByPhone(phone, ctx);
        if (!result.contacts.length) {
          return phoneNotFound(result.repeatMiss, 'ask for their deal ID, or offer to register a fresh test drive enquiry with create_lead.');
        }
        if (!result.deals.length) {
          return notFound(
            'The customer is registered but has no open enquiry.',
            'Offer to register a new test drive enquiry with create_lead, reusing the details already known.',
          );
        }
        deals = result.deals;
        contacts = result.contacts;
      }

      deals.forEach((d) => ctx.knownDealIds.add(d.id));
      ctx.remember({ record_name: deals[0].contact?.name, deal_id: deals.length === 1 ? deals[0].id : undefined }, 'lookups');
      return { ok: true, deals: await Promise.all(deals.map((d) => describeDeal(d, contacts))) };
    },
  },

  update_deal_followup: {
    stage: 'pipeline',
    status: 'Updating follow-up preference',
    definition: {
      name: 'update_deal_followup',
      description: 'Save how and when the customer wants the dealer to follow up, taken only from what the customer asked for in their latest message. Never reuse the currently saved preference. The deal must have been found with find_deal first.',
      parameters: {
        type: 'object',
        properties: {
          deal_id: { type: 'string', description: 'deal_id returned by find_deal' },
          channel: { type: 'string', enum: FOLLOW_UP_CHANNELS, description: 'Channel the customer asked for' },
          time_window: { type: 'string', description: 'When the customer asked to be contacted, in their words, e.g. "evening" or "weekdays after 6 pm". Use "any time" if they did not say.' },
        },
        required: ['deal_id', 'channel', 'time_window'],
      },
    },
    async handler(args, ctx) {
      const dealId = validate.recordId(args.deal_id, 'deal_id');
      const channel = validate.text(args.channel, 'channel', 20);
      if (!FOLLOW_UP_CHANNELS.includes(channel)) {
        throw new ValidationError('channel', `Choose one of: ${FOLLOW_UP_CHANNELS.join(', ')}.`);
      }
      const timeWindow = validate.text(args.time_window, 'time_window', 60);
      if (!ctx.knownDealIds.has(dealId)) {
        return { ok: false, error: 'unverified_deal', message: 'Look up the deal with find_deal before updating it.' };
      }

      await crm.updateDeal(dealId, { followUpPreference: `${channel}, ${timeWindow}` });
      // Read back so the reply reflects what the CRM actually stored.
      const saved = await crm.getDeal(dealId);
      return { ok: true, status: 'updated', saved_follow_up_preference: saved?.followUpPreference ?? null };
    },
  },

  get_booking_status: {
    stage: 'booked',
    status: 'Checking booking status',
    definition: {
      name: 'get_booking_status',
      description: 'Get allocation status, VIN, expected delivery date, balance due and payment link for a confirmed booking. Provide booking_id (format MAH-1234) or phone.',
      parameters: {
        type: 'object',
        properties: {
          booking_id: { type: 'string', description: 'Booking ID, e.g. MAH-9921' },
          phone: { type: 'string', description: 'Registered 10-digit mobile number' },
        },
      },
    },
    async handler(args, ctx) {
      requireOne(args, ['booking_id', 'phone']);
      let deals: crm.Deal[];
      let contacts: crm.Contact[] = [];

      if (args.booking_id) {
        const bookingId = validate.bookingId(args.booking_id);
        deals = await crm.findDealsByBookingId(bookingId);
        if (!deals.length) {
          return notFound(`No booking found with ID ${bookingId}.`, 'Ask the customer to recheck the booking ID or share their registered mobile number instead.');
        }
      } else {
        const result = await dealsByPhone(validate.phone(args.phone), ctx);
        if (!result.contacts.length) {
          return phoneNotFound(result.repeatMiss, 'ask for the booking ID from their booking receipt.');
        }
        deals = result.deals;
        contacts = result.contacts;
      }

      const booked = deals.filter((d) => d.stage === crm.BOOKED_STAGE);
      if (!booked.length) {
        return notFound(
          `No confirmed booking on record. Current enquiry stage: ${deals[0]?.stage ?? 'none'}.`,
          deals.length
            ? 'Tell the customer their enquiry is not yet booked and offer to share its status using find_deal.'
            : 'Offer to register a new enquiry with create_lead.',
        );
      }

      booked.forEach((d) => ctx.knownDealIds.add(d.id));
      ctx.remember({ record_name: booked[0].contact?.name, booking_id: booked[0].bookingId ?? undefined }, 'lookups');
      return { ok: true, bookings: await Promise.all(booked.map((d) => describeBooking(d, contacts))) };
    },
  },

  find_contact: {
    stage: 'service',
    status: 'Looking up customer',
    definition: {
      name: 'find_contact',
      description: 'Find a registered vehicle owner by phone number. Required before creating a service case.',
      parameters: {
        type: 'object',
        properties: { phone: { type: 'string', description: '10-digit mobile number' } },
        required: ['phone'],
      },
    },
    async handler(args, ctx) {
      const phone = validate.phone(args.phone);
      const { contacts, repeatMiss } = await contactsByPhone(phone, ctx);
      if (!contacts.length) {
        return phoneNotFound(
          repeatMiss,
          'collect their full name and email (skip any already given), confirm, register them with create_contact, then continue with the service case.',
        );
      }
      ctx.remember({ contact_id: contacts.length === 1 ? contacts[0].id : undefined }, 'lookups');
      return { ok: true, contacts: contacts.map((c) => ({ contact_id: c.id, name: c.name, email: c.email })) };
    },
  },

  create_contact: {
    stage: 'service',
    status: 'Registering customer',
    definition: {
      name: 'create_contact',
      description: 'Register a vehicle owner who is not in the CRM so a service case can be logged. Use only after find_contact found no match for a rechecked number; the first call returns a summary for the customer to confirm.',
      parameters: {
        type: 'object',
        properties: {
          first_name: { type: 'string' },
          last_name: { type: 'string' },
          phone: { type: 'string', description: 'The 10-digit mobile number that find_contact did not match' },
          email: { type: 'string' },
          customer_confirmed: CONFIRMED_PARAM,
        },
        required: ['first_name', 'last_name', 'phone', 'email'],
      },
    },
    async handler(args, ctx) {
      const contact = {
        firstName: validate.personName(args.first_name, 'first_name'),
        lastName: validate.personName(args.last_name, 'last_name'),
        phone: validate.phone(args.phone),
        email: validate.email(args.email),
      };
      if (!ctx.unmatchedPhones.has(contact.phone)) {
        return { ok: false, error: 'unverified_phone', message: 'Search this number with find_contact before registering a new customer.' };
      }

      const key = `contact:${contact.phone}`;
      const created = ctx.createdRecords.get(key);
      if (created) return { ok: true, already_created_in_this_chat: true, ...created };

      const gate = confirmationGate(ctx, `${key}:${JSON.stringify(contact)}`, args.customer_confirmed, {
        name: `${contact.firstName} ${contact.lastName}`,
        phone: contact.phone,
        email: contact.email,
      });
      if (gate) return gate;

      const [existing] = await crm.findContactsByPhone(contact.phone);
      const contactId = existing?.id ?? (await crm.createContact(contact));
      ctx.knownContactIds.add(contactId);
      ctx.remember({ customer_name: `${contact.firstName} ${contact.lastName}`, phone: contact.phone, email: contact.email });
      ctx.remember({ contact_id: contactId }, 'lookups');

      const result = { status: existing ? 'already_registered' : 'created', contact_id: contactId, name: `${contact.firstName} ${contact.lastName}` };
      ctx.createdRecords.set(key, result);
      return { ok: true, ...result };
    },
  },

  create_service_case: {
    stage: 'service',
    status: 'Creating service request',
    definition: {
      name: 'create_service_case',
      description: 'Log a service booking or complaint for an owner. Call only with a contact from find_contact or create_contact; the first call returns a summary for the customer to confirm.',
      parameters: {
        type: 'object',
        properties: {
          contact_id: { type: 'string', description: 'contact_id returned by find_contact or create_contact' },
          registration_no: { type: 'string', description: 'Vehicle registration number, e.g. MH12AB1234' },
          odometer: { type: 'string', description: 'Odometer reading in km' },
          issue: { type: 'string', description: 'Customer\'s description of the issue or work needed' },
          service_type: { type: 'string', enum: SERVICE_TYPES },
          service_center: { type: 'string', description: 'Preferred service center or area' },
          customer_confirmed: CONFIRMED_PARAM,
        },
        required: ['contact_id', 'registration_no', 'odometer', 'issue', 'service_type', 'service_center'],
      },
    },
    async handler(args, ctx) {
      const contactId = validate.recordId(args.contact_id, 'contact_id');
      if (!ctx.knownContactIds.has(contactId)) {
        return { ok: false, error: 'unverified_contact', message: 'Look up the owner with find_contact (or register them with create_contact) before creating a case.' };
      }
      const serviceType = validate.text(args.service_type, 'service_type', 40);
      if (!SERVICE_TYPES.includes(serviceType)) {
        throw new ValidationError('service_type', `Choose one of: ${SERVICE_TYPES.join(', ')}.`);
      }
      const registrationNo = validate.registrationNo(args.registration_no);
      const odometerKm = validate.odometer(args.odometer);
      const issue = validate.text(args.issue, 'issue', 500);
      const serviceCenter = validate.text(args.service_center, 'service_center', 80);
      ctx.remember({ registration_no: registrationNo });

      const key = `case:${contactId}:${registrationNo}:${serviceType}`;
      const created = ctx.createdRecords.get(key);
      if (created) return { ok: true, already_created_in_this_chat: true, ...created };

      const gate = confirmationGate(ctx, `${key}:${odometerKm}:${issue}:${serviceCenter}`, args.customer_confirmed, {
        registration_no: registrationNo,
        odometer: `${odometerKm} km`,
        issue,
        service_type: serviceType,
        service_center: serviceCenter,
      });
      if (gate) return gate;

      const serviceCase = await crm.createServiceCase({
        contactId,
        subject: `${serviceType} - ${registrationNo}`,
        description: issue,
        type: PROBLEM_SERVICE_TYPES.has(serviceType) ? 'Problem' : undefined,
        registrationNo,
        odometer: `${odometerKm} km`,
        serviceCenter,
      });
      const result = {
        status: 'created',
        case_number: serviceCase.caseNumber,
        case_status: serviceCase.status,
        service_type: serviceType,
        registration_no: registrationNo,
        service_center: serviceCenter,
      };
      ctx.createdRecords.set(key, result);
      return { ok: true, ...result };
    },
  },
};

export const toolDefinitions: ChatCompletionTool[] = Object.values(tools).map((t) => ({ type: 'function', function: t.definition }));

export const toolStage = (name: string): Stage | null => tools[name]?.stage ?? null;
export const toolStatus = (name: string): string => tools[name]?.status ?? 'Working';

export async function executeTool(name: string, rawArgs: string, ctx: ToolContext): Promise<ToolResult> {
  const tool = tools[name];
  if (!tool) return { ok: false, error: 'unknown_tool', message: `No tool named ${name}.` };

  let args: Args;
  try {
    args = rawArgs ? JSON.parse(rawArgs) : {};
  } catch {
    return { ok: false, error: 'invalid_arguments', message: 'Arguments were not valid JSON.' };
  }

  try {
    return await tool.handler(args, ctx);
  } catch (err) {
    if (err instanceof ValidationError) {
      return { ok: false, error: 'invalid_input', field: err.field, message: err.message };
    }
    if (err instanceof ZohoError) {
      console.error(`[tool:${name}] Zoho error`, err.status, err.code, err.message);
      return { ok: false, error: 'crm_unavailable', retryable: true, message: 'The CRM could not be reached. Ask the customer to try again shortly.' };
    }
    console.error(`[tool:${name}]`, err);
    return { ok: false, error: 'internal_error', message: 'Something went wrong while processing this request.' };
  }
}
