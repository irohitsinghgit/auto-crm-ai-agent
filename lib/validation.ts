export class ValidationError extends Error {
  field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'ValidationError';
    this.field = field;
  }
}

function required(field: string, value: unknown): string {
  const text = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  if (!text) throw new ValidationError(field, `${field} is required.`);
  return text;
}

// Accepts +91, 0 and spaced or hyphenated forms; returns the bare 10-digit mobile number.
export function phone(value: unknown, field = 'phone'): string {
  const digits = required(field, value).replace(/\D/g, '');
  const local = digits.length === 12 && digits.startsWith('91') ? digits.slice(2)
    : digits.length === 11 && digits.startsWith('0') ? digits.slice(1)
    : digits;
  if (!/^[6-9]\d{9}$/.test(local)) {
    throw new ValidationError(field, 'Enter a valid 10-digit Indian mobile number starting with 6, 7, 8 or 9.');
  }
  return local;
}

export function email(value: unknown, field = 'email'): string {
  const text = required(field, value).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(text)) {
    throw new ValidationError(field, 'Enter a valid email address, for example name@example.com.');
  }
  return text;
}

export function personName(value: unknown, field: string): string {
  const text = required(field, value).replace(/\s+/g, ' ');
  if (!/^[\p{L}][\p{L} .'-]{0,49}$/u.test(text)) {
    throw new ValidationError(field, `${field} should contain letters only.`);
  }
  return text;
}

export function text(value: unknown, field: string, maxLength = 200): string {
  const result = required(field, value).replace(/\s+/g, ' ');
  if (result.length > maxLength) {
    throw new ValidationError(field, `${field} must be at most ${maxLength} characters.`);
  }
  return result;
}

export function bookingId(value: unknown, field = 'booking_id'): string {
  const result = required(field, value).toUpperCase().replace(/\s+/g, '');
  const match = /^MAH-?(\d{4,6})$/.exec(result);
  if (!match) {
    throw new ValidationError(field, 'Booking IDs look like MAH-9921 (MAH followed by 4 to 6 digits).');
  }
  return `MAH-${match[1]}`;
}

// Zoho record ids are long numeric strings.
export function recordId(value: unknown, field: string): string {
  const result = required(field, value).replace(/\s+/g, '');
  if (!/^\d{10,20}$/.test(result)) {
    throw new ValidationError(field, `${field} should be the numeric ID from the CRM.`);
  }
  return result;
}

export function registrationNo(value: unknown, field = 'registration_no'): string {
  const result = required(field, value).toUpperCase().replace(/[\s-]/g, '');
  const standard = /^[A-Z]{2}\d{1,2}[A-Z]{0,3}\d{4}$/;
  const bharat = /^\d{2}BH\d{4}[A-Z]{1,2}$/;
  if (!standard.test(result) && !bharat.test(result)) {
    throw new ValidationError(field, 'Enter a valid registration number, for example MH12AB1234 or 22BH1234AA.');
  }
  return result;
}

export function odometer(value: unknown, field = 'odometer'): number {
  const digits = required(field, value).replace(/[,\s]|km/gi, '');
  const km = Number(digits);
  if (!Number.isInteger(km) || km < 0 || km > 999999) {
    throw new ValidationError(field, 'Enter the odometer reading in kilometres, for example 12500.');
  }
  return km;
}
