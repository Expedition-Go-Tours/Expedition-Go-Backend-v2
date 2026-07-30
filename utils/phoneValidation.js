const { parsePhoneNumber, isValidPhoneNumber, AsYouType, getCountryCallingCode, getCountries } = require('libphonenumber-js');

function validatePhone(value) {
  if (!value || typeof value !== 'string') {
    return { isValid: false, error: 'Phone number is required' };
  }

  const cleaned = value.trim();

  if (!cleaned.startsWith('+')) {
    return { isValid: false, error: 'Phone number must start with country code (e.g., +1)' };
  }

  try {
    const phoneNumber = parsePhoneNumber(cleaned);

    if (!phoneNumber) {
      return { isValid: false, error: 'Could not parse phone number' };
    }

    if (!isValidPhoneNumber(cleaned)) {
      return { isValid: false, error: 'Invalid phone number' };
    }

    return {
      isValid: true,
      error: null,
      phoneNumber: phoneNumber.number,
      nationalNumber: phoneNumber.nationalNumber,
      country: phoneNumber.country,
      countryCallingCode: phoneNumber.countryCallingCode,
      formatInternational: phoneNumber.formatInternational(),
      formatNational: phoneNumber.formatNational(),
      uri: phoneNumber.getURI(),
    };
  } catch (err) {
    return { isValid: false, error: 'Invalid phone number format' };
  }
}

function normalizeToE164(value) {
  if (!value || typeof value !== 'string') return null;

  const cleaned = value.trim();
  if (!cleaned) return null;

  try {
    const phoneNumber = parsePhoneNumber(cleaned);
    if (phoneNumber && isValidPhoneNumber(cleaned)) {
      return phoneNumber.number;
    }
  } catch {}

  if (cleaned.startsWith('+')) {
    const digits = cleaned.replace(/\D/g, '');
    if (digits.length >= 8 && digits.length <= 16) {
      return `+${digits}`;
    }
  }

  return null;
}

function extractCountryFromE164(value) {
  if (!value || typeof value !== 'string') return null;
  try {
    const phoneNumber = parsePhoneNumber(value);
    return (phoneNumber && phoneNumber.country) ? phoneNumber.country : null;
  } catch {
    return null;
  }
}

function extractNationalNumber(value) {
  if (!value || typeof value !== 'string') return '';
  try {
    const phoneNumber = parsePhoneNumber(value);
    return phoneNumber ? phoneNumber.nationalNumber : '';
  } catch {
    return value.replace(/[^\d]/g, '');
  }
}

function getCountryOptions() {
  try {
    return getCountries()
      .map((code) => ({
        value: code,
        label: `${code} +${getCountryCallingCode(code)}`,
        callingCode: `+${getCountryCallingCode(code)}`,
      }))
      .sort((a, b) => {
        const aCode = parseInt(a.callingCode.replace('+', ''), 10);
        const bCode = parseInt(b.callingCode.replace('+', ''), 10);
        return aCode - bCode;
      });
  } catch {
    return [];
  }
}

module.exports = {
  validatePhone,
  normalizeToE164,
  extractCountryFromE164,
  extractNationalNumber,
  getCountryOptions,
  parsePhoneNumber,
  isValidPhoneNumber,
  AsYouType,
};
