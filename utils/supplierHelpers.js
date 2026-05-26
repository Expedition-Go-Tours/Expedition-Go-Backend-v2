/**
 * Supplier Helpers - Production Ready
 * Utility functions for supplier verification and management
 * 
 * @author Tour Platform Team
 * @version 1.0.0
 */

/**
 * Validate supplier application data
 */
function validateSupplierData(data, isPartial = false) {
  const errors = [];

  if (!isPartial) {
    // Required sections for new applications
    if (!data.businessInfo) {
      errors.push('Business information is required');
    }
    if (!data.operatingInfo) {
      errors.push('Operating information is required');
    }
    if (!data.representativeInfo) {
      errors.push('Representative information is required');
    }
  }

  // Validate business info
  if (data.businessInfo) {
    const businessErrors = validateBusinessInfo(data.businessInfo);
    errors.push(...businessErrors);
  }

  // Validate operating info
  if (data.operatingInfo) {
    const operatingErrors = validateOperatingInfo(data.operatingInfo);
    errors.push(...operatingErrors);
  }

  // Validate representative info
  if (data.representativeInfo) {
    const repErrors = validateRepresentativeInfo(data.representativeInfo);
    errors.push(...repErrors);
  }

  // Validate business documents
  if (data.businessDocuments) {
    const docErrors = validateBusinessDocuments(data.businessDocuments);
    errors.push(...docErrors);
  }

  // Validate payout info (optional during application, required before activation)
  if (data.payoutInfo && Object.keys(data.payoutInfo).some(k => data.payoutInfo[k])) {
    const payoutErrors = validatePayoutInfo(data.payoutInfo);
    errors.push(...payoutErrors);
  }

  return {
    isValid: errors.length === 0,
    errors
  };
}

/**
 * Validate business information
 */
function validateBusinessInfo(businessInfo) {
  const errors = [];

  if (!businessInfo.legalBusinessName || businessInfo.legalBusinessName.trim().length === 0) {
    errors.push('Legal business name is required');
  }

  if (!businessInfo.displayName || businessInfo.displayName.trim().length === 0) {
    errors.push('Display name is required');
  }

  if (!businessInfo.businessType || !['individual', 'company', 'non_profit'].includes(businessInfo.businessType)) {
    errors.push('Valid business type is required (individual, company, or non_profit)');
  }

  if (!businessInfo.country || businessInfo.country.length !== 2) {
    errors.push('Valid 2-letter country code is required');
  }

  // Validate address
  if (!businessInfo.address) {
    errors.push('Business address is required');
  } else {
    if (!businessInfo.address.line1) errors.push('Address line 1 is required');
    if (!businessInfo.address.city) errors.push('City is required');
    if (!businessInfo.address.state) errors.push('State/Province is required');
    if (!businessInfo.address.postalCode) errors.push('Postal code is required');
  }

  // Validate phone number format
  if (businessInfo.phoneNumber && !/^\+?[\d\s\-()]+$/.test(businessInfo.phoneNumber)) {
    errors.push('Invalid phone number format');
  }

  // Validate website URL
  if (businessInfo.website && !/^https?:\/\/.+\..+/.test(businessInfo.website)) {
    errors.push('Invalid website URL format');
  }

  return errors;
}

/**
 * Validate operating information
 */
function validateOperatingInfo(operatingInfo) {
  const errors = [];

  if (!operatingInfo.tourCategories || !Array.isArray(operatingInfo.tourCategories) || operatingInfo.tourCategories.length === 0) {
    errors.push('At least one tour category is required');
  }

  if (!operatingInfo.destinations || !Array.isArray(operatingInfo.destinations) || operatingInfo.destinations.length === 0) {
    errors.push('At least one destination is required');
  }

  if (!operatingInfo.languages || !Array.isArray(operatingInfo.languages) || operatingInfo.languages.length === 0) {
    errors.push('At least one language is required');
  }

  if (operatingInfo.yearsInBusiness !== undefined) {
    if (operatingInfo.yearsInBusiness < 0 || operatingInfo.yearsInBusiness > 100) {
      errors.push('Years in business must be between 0 and 100');
    }
  }

  if (!operatingInfo.cancellationPolicy || operatingInfo.cancellationPolicy.trim().length === 0) {
    errors.push('Cancellation policy is required');
  }

  if (!operatingInfo.meetingStyle || !['pickup', 'meeting_point', 'flexible'].includes(operatingInfo.meetingStyle)) {
    errors.push('Valid meeting style is required (pickup, meeting_point, or flexible)');
  }

  return errors;
}

/**
 * Validate representative information
 */
function validateRepresentativeInfo(representativeInfo) {
  const errors = [];

  if (!representativeInfo.fullName || representativeInfo.fullName.trim().length === 0) {
    errors.push('Representative full name is required');
  }

  if (!representativeInfo.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(representativeInfo.email)) {
    errors.push('Valid email address is required');
  }

  if (!representativeInfo.dateOfBirth) {
    errors.push('Date of birth is required');
  } else {
    const dob = new Date(representativeInfo.dateOfBirth);
    const age = (new Date() - dob) / (365.25 * 24 * 60 * 60 * 1000);
    if (age < 18 || age > 100) {
      errors.push('Representative must be between 18 and 100 years old');
    }
  }

  // Validate address
  if (!representativeInfo.address) {
    errors.push('Representative address is required');
  } else {
    if (!representativeInfo.address.line1) errors.push('Representative address line 1 is required');
    if (!representativeInfo.address.city) errors.push('Representative city is required');
    if (!representativeInfo.address.state) errors.push('Representative state/province is required');
    if (!representativeInfo.address.postalCode) errors.push('Representative postal code is required');
  }

  if (representativeInfo.phoneNumber && !/^\+?[\d\s\-()]+$/.test(representativeInfo.phoneNumber)) {
    errors.push('Invalid phone number format');
  }

  if (!representativeInfo.idType || !['passport', 'drivers_license', 'national_id'].includes(representativeInfo.idType)) {
    errors.push('Valid ID type is required (passport, drivers_license, or national_id)');
  }

  if (!representativeInfo.idDocumentUrl || !isValidUrl(representativeInfo.idDocumentUrl)) {
    errors.push('Valid ID document URL is required');
  }

  return errors;
}

/**
 * Validate business documents
 */
function validateBusinessDocuments(businessDocuments) {
  const errors = [];

  if (!businessDocuments.registrationDocumentUrl || !isValidUrl(businessDocuments.registrationDocumentUrl)) {
    errors.push('Valid business registration document URL is required');
  }

  if (!businessDocuments.taxDocumentUrl || !isValidUrl(businessDocuments.taxDocumentUrl)) {
    errors.push('Valid tax document URL is required');
  }

  if (!businessDocuments.proofOfAddressUrl || !isValidUrl(businessDocuments.proofOfAddressUrl)) {
    errors.push('Valid proof of address document URL is required');
  }

  if (businessDocuments.licenses && !Array.isArray(businessDocuments.licenses)) {
    errors.push('Licenses must be an array of URLs');
  }

  if (businessDocuments.licenses) {
    for (const license of businessDocuments.licenses) {
      if (!isValidUrl(license)) {
        errors.push('All license URLs must be valid');
        break;
      }
    }
  }

  return errors;
}

/**
 * Validate payout information
 */
function validatePayoutInfo(payoutInfo) {
  const errors = [];

  if (!payoutInfo.bankAccountName || payoutInfo.bankAccountName.trim().length === 0) {
    errors.push('Bank account name is required');
  }

  if (!payoutInfo.bankCountry || payoutInfo.bankCountry.length !== 2) {
    errors.push('Valid 2-letter bank country code is required');
  }

  if (!payoutInfo.payoutCurrency || payoutInfo.payoutCurrency.length !== 3) {
    errors.push('Valid 3-letter payout currency code is required');
  }

  return errors;
}

/**
 * Check if URL is valid
 */
function isValidUrl(url) {
  try {
    new URL(url);
    return url.startsWith('http://') || url.startsWith('https://');
  } catch {
    return false;
  }
}

/**
 * Generate supplier verification checklist
 */
function generateVerificationChecklist(supplierProfile) {
  const checklist = {
    businessInfo: {
      completed: !!supplierProfile.businessInfo,
      items: [
        { name: 'Legal business name', completed: !!supplierProfile.businessInfo?.legalBusinessName },
        { name: 'Business address', completed: !!supplierProfile.businessInfo?.address?.line1 },
        { name: 'Business type', completed: !!supplierProfile.businessInfo?.businessType },
        { name: 'Contact information', completed: !!supplierProfile.businessInfo?.phoneNumber }
      ]
    },
    operatingInfo: {
      completed: !!supplierProfile.operatingInfo,
      items: [
        { name: 'Tour categories', completed: !!supplierProfile.operatingInfo?.tourCategories?.length },
        { name: 'Destinations', completed: !!supplierProfile.operatingInfo?.destinations?.length },
        { name: 'Languages', completed: !!supplierProfile.operatingInfo?.languages?.length },
        { name: 'Cancellation policy', completed: !!supplierProfile.operatingInfo?.cancellationPolicy }
      ]
    },
    representativeInfo: {
      completed: !!supplierProfile.representativeInfo,
      items: [
        { name: 'Full name', completed: !!supplierProfile.representativeInfo?.fullName },
        { name: 'Email address', completed: !!supplierProfile.representativeInfo?.email },
        { name: 'Date of birth', completed: !!supplierProfile.representativeInfo?.dateOfBirth },
        { name: 'ID document', completed: !!supplierProfile.representativeInfo?.idDocumentUrl }
      ]
    },
    businessDocuments: {
      completed: !!supplierProfile.businessDocuments,
      items: [
        { name: 'Registration document', completed: !!supplierProfile.businessDocuments?.registrationDocumentUrl },
        { name: 'Tax document', completed: !!supplierProfile.businessDocuments?.taxDocumentUrl },
        { name: 'Proof of address', completed: !!supplierProfile.businessDocuments?.proofOfAddressUrl }
      ]
    },
    payoutInfo: {
      completed: !!supplierProfile.payoutInfo,
      items: [
        { name: 'Bank account name', completed: !!supplierProfile.payoutInfo?.bankAccountName },
        { name: 'Bank country', completed: !!supplierProfile.payoutInfo?.bankCountry },
        { name: 'Payout currency', completed: !!supplierProfile.payoutInfo?.payoutCurrency }
      ]
    },

  };

  // Calculate overall completion
  const totalItems = Object.values(checklist).reduce((sum, section) => sum + section.items.length, 0);
  const completedItems = Object.values(checklist).reduce((sum, section) => 
    sum + section.items.filter(item => item.completed).length, 0
  );

  checklist.overall = {
    completed: completedItems,
    total: totalItems,
    percentage: Math.round((completedItems / totalItems) * 100)
  };

  return checklist;
}

/**
 * Get supplier tier based on performance
 */
function getSupplierTier(supplierProfile) {
  const { totalBookings, averageRating, totalEarnings } = supplierProfile;

  if (totalBookings >= 100 && averageRating >= 4.8 && totalEarnings >= 10000) {
    return {
      tier: 'platinum',
      name: 'Platinum Supplier',
      benefits: ['Lowest commission rates', 'Priority support', 'Featured listings'],
      commissionRate: 0.10
    };
  }

  if (totalBookings >= 50 && averageRating >= 4.5 && totalEarnings >= 5000) {
    return {
      tier: 'gold',
      name: 'Gold Supplier',
      benefits: ['Reduced commission rates', 'Priority support'],
      commissionRate: 0.12
    };
  }

  if (totalBookings >= 20 && averageRating >= 4.0 && totalEarnings >= 1000) {
    return {
      tier: 'silver',
      name: 'Silver Supplier',
      benefits: ['Standard commission rates', 'Regular support'],
      commissionRate: 0.14
    };
  }

  return {
    tier: 'bronze',
    name: 'New Supplier',
    benefits: ['Standard commission rates', 'Getting started support'],
    commissionRate: 0.15
  };
}

/**
 * Calculate supplier performance metrics
 */
function calculateSupplierMetrics(supplierProfile, bookings, reviews) {
  const metrics = {
    totalRevenue: supplierProfile.totalEarnings || 0,
    totalBookings: supplierProfile.totalBookings || 0,
    averageRating: supplierProfile.averageRating || 0,
    responseRate: 0,
    cancellationRate: 0,
    repeatCustomerRate: 0,
    averageBookingValue: 0
  };

  if (bookings && bookings.length > 0) {
    // Calculate cancellation rate
    const cancelledBookings = bookings.filter(b => b.status === 'CANCELLED').length;
    metrics.cancellationRate = (cancelledBookings / bookings.length) * 100;

    // Calculate average booking value
    const confirmedBookings = bookings.filter(b => b.status === 'CONFIRMED');
    if (confirmedBookings.length > 0) {
      const totalValue = confirmedBookings.reduce((sum, b) => sum + parseFloat(b.total), 0);
      metrics.averageBookingValue = totalValue / confirmedBookings.length;
    }

    // Calculate repeat customer rate
    const customerIds = bookings.map(b => b.customerId);
    const uniqueCustomers = new Set(customerIds).size;
    metrics.repeatCustomerRate = ((customerIds.length - uniqueCustomers) / customerIds.length) * 100;
  }

  if (reviews && reviews.length > 0) {
    // Calculate response rate (reviews with supplier responses)
    const reviewsWithResponses = reviews.filter(r => r.supplierResponse).length;
    metrics.responseRate = (reviewsWithResponses / reviews.length) * 100;
  }

  return metrics;
}

module.exports = {
  validateSupplierData,
  generateVerificationChecklist,
  getSupplierTier,
  calculateSupplierMetrics
};