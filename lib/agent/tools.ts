import type { ChatCompletionTool } from 'groq-sdk/resources/chat/completions';
import * as crm from '../crm';
import * as validate from '../validation';
import { ValidationError } from '../validation';
import { ZohoError } from '../zoho';
import { getVehicleInfo, vehicleLabel, MODEL_NAMES } from '../catalog';

export type Stage = 'new_lead' | 'pipeline' | 'booked' | 'service';

export interface ToolContext {
  knownContactIds: Set<string>;
  knownDealIds: Set<string>;
  // Records created in this session, keyed by content, so a repeated tool call cannot create duplicates.
  createdRecords: Map<string, Record<string, unknown>>;
  remember: (details: Record<string, string | undefined>) => void;
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

const ALLOCATION_MEANING: Record<string, string> = {
  'dispatch pending': 'A vehicle is allocated against the booking and is awaiting dispatch from the plant.',
  'in transit': 'The vehicle has been dispatched from the plant and is on its way to the dealership.',
  'at dealership': 'The vehicle has reached the dealership and is being prepared for delivery.',
  delivered: 'The vehicle has been delivered to the customer.',
};

const rupees = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });

const notFound = (message: string): ToolResult => ({ ok: false, error: 'not_found', message });

function describeDeal(deal: crm.Deal) {
  return {
    deal_id: deal.id,
    deal_name: deal.name,
    customer_name: deal.contact?.name ?? null,
    stage: deal.stage,
    vehicle_model: deal.vehicleModel,
    test_drive_time: deal.testDriveTime,
    quotation: deal.amount != null ? rupees.format(deal.amount) : null,
    follow_up_preference: deal.followUpPreference,
    dealer_contact: deal.owner,
    booking_id: deal.bookingId,
  };
}

function describeBooking(deal: crm.Deal) {
  const status = deal.allocationStatus;
  return {
    booking_id: deal.bookingId,
    customer_name: deal.contact?.name ?? null,
    vehicle_model: deal.vehicleModel,
    booking_value: deal.amount != null ? rupees.format(deal.amount) : null,
    booked_on: deal.closingDate,
    allocation_status: status,
    allocation_status_meaning: status ? ALLOCATION_MEANING[status.toLowerCase()] ?? null : null,
    dealer_contact: deal.owner,
    not_in_crm: 'VIN, expected delivery date and balance payment amount are not recorded in the CRM; the dealer shares these directly.',
  };
}

async function contactsByPhone(phone: string, ctx: ToolContext) {
  const contacts = await crm.findContactsByPhone(phone);
  contacts.forEach((c) => ctx.knownContactIds.add(c.id));
  if (contacts[0]) ctx.remember({ customer_name: contacts[0].name, phone });
  return contacts;
}

async function dealsByPhone(phone: string, ctx: ToolContext) {
  const contacts = await contactsByPhone(phone, ctx);
  const deals = (await Promise.all(contacts.map((c) => crm.findDealsByContact(c.id)))).flat();
  return { contacts, deals };
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
      if (!info.found) return { ok: false, error: 'not_found', ...info };
      ctx.remember({ vehicle_interest: 'variant' in info ? `${info.model} ${info.variant.name}` : info.model });
      return { ok: true, ...info };
    },
  },

  create_lead: {
    stage: 'new_lead',
    status: 'Creating lead',
    definition: {
      name: 'create_lead',
      description: 'Register a new sales lead for a test drive or purchase enquiry. Call only after the customer has confirmed all details.',
      parameters: {
        type: 'object',
        properties: {
          first_name: { type: 'string' },
          last_name: { type: 'string' },
          phone: { type: 'string', description: '10-digit Indian mobile number' },
          email: { type: 'string' },
          city: { type: 'string', description: 'Preferred city for test drive and dealership' },
          vehicle_model: { type: 'string', description: 'Model of interest, optionally with variant, e.g. "XUV700 AX7"' },
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

      const [existing] = await crm.findLeadsByPhone(lead.phone);
      if (existing) {
        return {
          ok: true,
          status: 'already_registered',
          message: 'An enquiry with this phone number already exists; the sales team will use it.',
          lead: { name: existing.name, vehicle_model: existing.vehicleModel, city: existing.city },
        };
      }

      const leadId = await crm.createLead({ ...lead, description: 'Test drive enquiry from the website chat assistant.' });
      const result = { status: 'created', lead_id: leadId, vehicle_model: lead.vehicleModel, city: lead.city };
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

      if (args.deal_id) {
        const deal = await crm.getDeal(validate.recordId(args.deal_id, 'deal_id'));
        if (!deal) return notFound('No deal exists with this ID.');
        deals = [deal];
      } else {
        const phone = validate.phone(args.phone);
        const result = await dealsByPhone(phone, ctx);
        if (!result.contacts.length) return notFound('No customer is registered with this phone number.');
        if (!result.deals.length) return notFound('The customer exists but has no deals on record.');
        deals = result.deals;
      }

      deals.forEach((d) => ctx.knownDealIds.add(d.id));
      ctx.remember({ customer_name: deals[0].contact?.name, deal_id: deals.length === 1 ? deals[0].id : undefined });
      return { ok: true, deals: deals.map(describeDeal) };
    },
  },

  update_deal_followup: {
    stage: 'pipeline',
    status: 'Updating follow-up preference',
    definition: {
      name: 'update_deal_followup',
      description: 'Save how and when the customer wants the dealer to follow up (e.g. "WhatsApp, weekday evenings"). The deal must have been found with find_deal first.',
      parameters: {
        type: 'object',
        properties: {
          deal_id: { type: 'string', description: 'deal_id returned by find_deal' },
          preference: { type: 'string', description: 'Preferred channel and time for follow-up' },
        },
        required: ['deal_id', 'preference'],
      },
    },
    async handler(args, ctx) {
      const dealId = validate.recordId(args.deal_id, 'deal_id');
      const preference = validate.text(args.preference, 'preference', 100);
      if (!ctx.knownDealIds.has(dealId)) {
        return { ok: false, error: 'unverified_deal', message: 'Look up the deal with find_deal before updating it.' };
      }
      await crm.updateDealFollowUp(dealId, preference);
      return { ok: true, status: 'updated', deal_id: dealId, follow_up_preference: preference };
    },
  },

  get_booking_status: {
    stage: 'booked',
    status: 'Checking booking status',
    definition: {
      name: 'get_booking_status',
      description: 'Get delivery and vehicle allocation status for a confirmed booking. Provide booking_id (format MAH-1234) or phone.',
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

      if (args.booking_id) {
        const bookingId = validate.bookingId(args.booking_id);
        deals = await crm.findDealsByBookingId(bookingId);
        if (!deals.length) return notFound(`No booking found with ID ${bookingId}.`);
      } else {
        const { contacts, deals: all } = await dealsByPhone(validate.phone(args.phone), ctx);
        if (!contacts.length) return notFound('No customer is registered with this phone number.');
        deals = all;
      }

      const booked = deals.filter((d) => d.stage === crm.BOOKED_STAGE);
      if (!booked.length) {
        return notFound(`No confirmed booking on record. Current deal stage: ${deals[0]?.stage ?? 'none'}.`);
      }

      booked.forEach((d) => ctx.knownDealIds.add(d.id));
      ctx.remember({ customer_name: booked[0].contact?.name, booking_id: booked[0].bookingId ?? undefined });
      return { ok: true, bookings: booked.map(describeBooking) };
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
      const contacts = await contactsByPhone(phone, ctx);
      if (!contacts.length) return notFound('No registered owner found with this phone number.');
      ctx.remember({ contact_id: contacts.length === 1 ? contacts[0].id : undefined });
      return { ok: true, contacts: contacts.map((c) => ({ contact_id: c.id, name: c.name, email: c.email })) };
    },
  },

  create_service_case: {
    stage: 'service',
    status: 'Creating service request',
    definition: {
      name: 'create_service_case',
      description: 'Log a service booking or complaint for a registered owner. Call only after find_contact and after the customer has confirmed the details.',
      parameters: {
        type: 'object',
        properties: {
          contact_id: { type: 'string', description: 'contact_id returned by find_contact' },
          registration_no: { type: 'string', description: 'Vehicle registration number, e.g. MH12AB1234' },
          odometer: { type: 'string', description: 'Odometer reading in km' },
          issue: { type: 'string', description: 'Customer\'s description of the issue or work needed' },
          service_type: { type: 'string', enum: SERVICE_TYPES },
          service_center: { type: 'string', description: 'Preferred service center or area' },
        },
        required: ['contact_id', 'registration_no', 'odometer', 'issue', 'service_type', 'service_center'],
      },
    },
    async handler(args, ctx) {
      const contactId = validate.recordId(args.contact_id, 'contact_id');
      if (!ctx.knownContactIds.has(contactId)) {
        return { ok: false, error: 'unverified_contact', message: 'Look up the owner with find_contact before creating a case.' };
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
