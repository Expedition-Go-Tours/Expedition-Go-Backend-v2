/**
 * Seed: Supplier verification pipeline test data.
 *
 * Creates suppliers across every status + supplier type, with granular
 * documents (pending/approved/rejected/replacement-requested/expired), expiry
 * windows (60/30/7 days and already-expired), vehicles and guides — so the
 * admin Quality-Control dashboard, per-document review, expiry reminders and
 * the supplier verification pages can all be tested end to end.
 *
 * Idempotent: re-running deletes the previous test records (matched by email).
 * All users get the same login password (see LOGIN_PASSWORD below) so you can
 * log into the supplier app with any of them.
 *
 * Usage: node prisma/seedVerification.js
 */

const bcrypt = require('bcrypt');
const prisma = require('../utils/prismaClient');

const LOGIN_PASSWORD = 'VerifTest123!';
const DOC_URL = (n) => `https://res.cloudinary.com/demo/image/upload/v1/supplier-docs/${n}.jpg`;

const now = Date.now();
const daysFromNow = (d) => new Date(now + d * 24 * 60 * 60 * 1000);

function daysAgo(d) {
  return new Date(now - d * 24 * 60 * 60 * 1000);
}

function baseSupplierPayload(name, email, type, status) {
  return {
    user: {
      name,
      email,
      passwordHash: null,
      roles: ['supplier'],
      active: true,
      emailVerified: true,
      authProvider: 'local',
    },
    profile: {
      status,
      supplierType: type,
      businessInfo: {
        legalBusinessName: name,
        displayName: name,
        businessType: type === 'TOUR_GUIDE' ? 'individual' : 'company',
        country: 'GH',
        address: { line1: '12 Independence Ave', city: 'Accra', state: 'Greater Accra', postalCode: 'GA-123' },
        website: `https://${email.split('@')[0]}.example.com`,
        phoneNumber: '+233200000000',
      },
      operatingInfo: {
        tourCategories: ['Cultural', 'Adventure'],
        destinations: ['Accra', 'Cape Coast'],
        languages: ['English'],
        yearsInBusiness: 3,
        cancellationPolicy: 'Free cancellation up to 24 hours before',
        meetingStyle: 'pickup',
      },
      representativeInfo: {
        fullName: name,
        email,
        dateOfBirth: '1990-01-01',
        address: { line1: '12 Independence Ave', city: 'Accra', state: 'Greater Accra', postalCode: 'GA-123' },
        idType: 'national_id',
      },
      payoutInfo: { bankAccountName: name, bankCountry: 'GH', payoutCurrency: 'GHS' },
      compliance: { termsAccepted: true, agreedToPayoutTerms: true },
      businessDocuments: { registrationDocumentUrl: DOC_URL(`${email.split('@')[0]}-legacy-reg`) },
    },
  };
}

async function createSupplier(key, name, email, type, status, { docs = [], vehicles = [], guides = [], createdAt = daysAgo(2), tours = [] } = {}) {
  await prisma.user.deleteMany({ where: { email } });

  const passwordHash = await bcrypt.hash(LOGIN_PASSWORD, 10);
  const user = await prisma.user.create({
    data: { ...baseSupplierPayload(name, email, type, status).user, passwordHash, createdAt },
  });

  const profile = await prisma.supplierProfile.create({
    data: {
      userId: user.id,
      status,
      supplierType: type,
      ...baseSupplierPayload(name, email, type, status).profile,
      createdAt,
    },
  });

  const docRows = docs.map((d) => ({
    supplierId: profile.id,
    ownerType: d.ownerType || 'SUPPLIER',
    ownerId: d.ownerId || profile.id,
    type: d.type,
    url: d.url || DOC_URL(`${key}-${d.type.toLowerCase()}`),
    status: d.status || 'PENDING',
    expiryDate: d.expiryDate || null,
    reviewNote: d.note || null,
    reviewedBy: d.reviewedBy || (d.status && d.status !== 'PENDING' ? 'seed-admin' : null),
    reviewedAt: d.status && d.status !== 'PENDING' ? daysAgo(1) : null,
  }));

  for (const v of vehicles) {
    const vehicle = await prisma.vehicle.create({
      data: {
        supplierId: profile.id,
        make: v.make,
        model: v.model,
        year: v.year || 2022,
        registrationNumber: v.reg,
        photos: v.photos || [DOC_URL(`${key}-vehicle-${v.reg.toLowerCase().replace(/\s/g, '')}-1`)],
        status: v.status || 'PENDING',
        reviewNote: v.note || null,
      },
    });
    for (const dt of v.docTypes || []) {
      docRows.push({
        supplierId: profile.id,
        ownerType: 'VEHICLE',
        ownerId: vehicle.id,
        type: dt,
        url: DOC_URL(`${key}-${v.reg.toLowerCase().replace(/\s/g, '')}-${dt.toLowerCase()}`),
        status: v.status === 'VERIFIED' ? 'APPROVED' : 'PENDING',
      });
    }
  }

  for (const g of guides) {
    const guide = await prisma.guide.create({
      data: {
        supplierId: profile.id,
        fullName: g.fullName,
        phone: g.phone || '+233200000001',
        email: g.email || null,
        status: g.status || 'PENDING',
        reviewNote: g.note || null,
      },
    });
    for (const dt of ['TOUR_GUIDE_LICENCE', 'DRIVERS_LICENCE']) {
      docRows.push({
        supplierId: profile.id,
        ownerType: 'GUIDE',
        ownerId: guide.id,
        type: dt,
        url: DOC_URL(`${key}-${g.fullName.split(' ')[0].toLowerCase()}-${dt.toLowerCase()}`),
        status: g.status === 'VERIFIED' ? 'APPROVED' : 'PENDING',
      });
    }
  }

  if (docRows.length > 0) {
    await prisma.supplierDocument.createMany({ data: docRows });
  }

  await prisma.verificationEvent.createMany({
    data: [
      { supplierId: profile.id, entityType: 'SUPPLIER', entityId: profile.id, action: 'APPLICATION_SUBMITTED', createdAt: createdAt },
      { supplierId: profile.id, entityType: 'SUPPLIER', entityId: profile.id, action: status === 'REJECTED' ? 'REJECTED' : 'STATUS_CHANGE', actorId: 'seed-admin', note: `Seeded as ${status}`, createdAt: daysAgo(1) },
    ],
  });

  for (const t of tours) {
    await prisma.tour.create({
      data: {
        supplierId: user.id,
        title: t.title,
        description: t.description || 'A seeded tour for pipeline testing.',
        slug: t.slug || `${email.split('@')[0]}-${t.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`,
        status: 'ACTIVE',
        categorization: { category: 'Cultural', activityType: 'Guided Tour' },
        theme: { primary: 'History & Culture' },
        productContent: { location: { city: 'Accra', country: 'Ghana' }, duration: '3 hours' },
        schedulesAndPricing: {},
        bookingAndTickets: {},
        city: 'Accra',
        country: 'Ghana',
        coverPhoto: t.coverPhoto || DOC_URL(`${key}-cover`),
      },
    });
  }

  console.log(`  ${status.padEnd(16)} ${type.padEnd(22)} ${name} (${email})  docs=${docRows.length} vehicles=${vehicles.length} guides=${guides.length} tours=${tours.length}`);
}

async function main() {
  console.log('Seeding supplier verification pipeline test data...\n');

  // 1. PENDING tour guide — all documents pending review.
  await createSupplier('pending-guide', 'Ama Pending', 'verif.guide.pending@example.com', 'TOUR_GUIDE', 'PENDING', {
    docs: [
      { type: 'GHANA_CARD' },
      { type: 'TOUR_GUIDE_LICENCE' },
      { type: 'DRIVERS_LICENCE' },
      { type: 'PROOF_OF_ADDRESS' },
      { type: 'PROFILE_PHOTO' },
    ],
  });

  // 2. UNDER_REVIEW tour company — mixed docs + guides (one verified, one pending).
  await createSupplier('review-company', 'Kwame Review Co', 'verif.company.review@example.com', 'TOUR_COMPANY', 'UNDER_REVIEW', {
    docs: [
      { type: 'BUSINESS_CERTIFICATE', status: 'PENDING' },
      { type: 'GTA_CERTIFICATE', status: 'REPLACEMENT_REQUESTED', note: 'The copy is blurred — please re-upload a clearer scan.' },
      { type: 'PROOF_OF_ADDRESS', status: 'APPROVED', expiryDate: daysFromNow(400) },
      { type: 'PROFILE_PHOTO', status: 'APPROVED' },
    ],
    guides: [
      { fullName: 'Yaw Verif', status: 'VERIFIED' },
      { fullName: 'Akosua New', status: 'PENDING' },
    ],
  });

  // 3. APPROVED transportation provider — docs approved with expiring licences
  //    (45 / 20 / 5 days) + one verified vehicle and one pending vehicle.
  await createSupplier('approved-transport', 'Danquah Transport', 'verif.transport.approved@example.com', 'TRANSPORTATION_PROVIDER', 'APPROVED', {
    docs: [
      { type: 'BUSINESS_CERTIFICATE', status: 'APPROVED', expiryDate: daysFromNow(450) },
      { type: 'PASSENGER_TRANSPORT_LICENCE', status: 'APPROVED', expiryDate: daysFromNow(45) },
      { type: 'GTA_CERTIFICATE', status: 'APPROVED', expiryDate: daysFromNow(20) },
      { type: 'PROOF_OF_ADDRESS', status: 'APPROVED', expiryDate: daysFromNow(365) },
    ],
    vehicles: [
      { make: 'Toyota', model: 'Hiace', year: 2021, reg: 'GR 4521-20', status: 'VERIFIED' },
      { make: 'Hyundai', model: 'H1', year: 2019, reg: 'GW 7712-21', status: 'PENDING' },
    ],
    tours: [{ title: 'Accra City Tour', coverPhoto: DOC_URL('approved-transport-cover') }],
  });

  // 4. ACTIVE vehicle operator — fully verified, docs far from expiry.
  await createSupplier('active-operator', 'Naa Shuttle Services', 'verif.operator.active@example.com', 'VEHICLE_OPERATOR', 'ACTIVE', {
    createdAt: daysAgo(60),
    docs: [
      { type: 'BUSINESS_CERTIFICATE', status: 'APPROVED', expiryDate: daysFromNow(700) },
      { type: 'PASSENGER_TRANSPORT_LICENCE', status: 'APPROVED', expiryDate: daysFromNow(500) },
      { type: 'PROOF_OF_ADDRESS', status: 'APPROVED', expiryDate: daysFromNow(365) },
      { type: 'PROFILE_PHOTO', status: 'APPROVED' },
    ],
    vehicles: [
      { make: 'Mercedes', model: 'Sprinter', year: 2022, reg: 'GE 9010-22', status: 'VERIFIED' },
      { make: 'Toyota', model: 'Corolla', year: 2020, reg: 'GT 3344-19', status: 'VERIFIED' },
    ],
    tours: [
      { title: 'Cape Coast Day Trip', coverPhoto: DOC_URL('active-operator-cover-1') },
      { title: 'Kakum Canopy Walk', coverPhoto: DOC_URL('active-operator-cover-2') },
    ],
  });

  // 5. SUSPENDED company — an expired document sitting alongside approved ones.
  await createSupplier('suspended-company', 'Zongo Ventures', 'verif.company.suspended@example.com', 'TOUR_COMPANY', 'SUSPENDED', {
    createdAt: daysAgo(30),
    docs: [
      { type: 'BUSINESS_CERTIFICATE', status: 'APPROVED', expiryDate: daysFromNow(300) },
      { type: 'GTA_CERTIFICATE', status: 'EXPIRED', expiryDate: daysAgo(3), note: 'Certificate expired on this date.' },
      { type: 'PROOF_OF_ADDRESS', status: 'APPROVED', expiryDate: daysFromNow(200) },
    ],
  });

  // 6. REJECTED tour guide — rejected documents with review notes.
  await createSupplier('rejected-guide', 'Kojo Rejected', 'verif.guide.rejected@example.com', 'TOUR_GUIDE', 'REJECTED', {
    createdAt: daysAgo(10),
    docs: [
      { type: 'GHANA_CARD', status: 'REJECTED', note: 'Unable to verify the identity document.' },
      { type: 'TOUR_GUIDE_LICENCE', status: 'REJECTED', note: 'Licence appears to be a copy of a copy.' },
      { type: 'DRIVERS_LICENCE', status: 'REJECTED', note: 'Expired at the time of submission.' },
    ],
  });

  // 7. EXPIRED transportation provider — licence already past expiry (auto-suspend case).
  await createSupplier('expired-transport', 'Tema Express', 'verif.transport.expired@example.com', 'TRANSPORTATION_PROVIDER', 'EXPIRED', {
    createdAt: daysAgo(120),
    docs: [
      { type: 'BUSINESS_CERTIFICATE', status: 'APPROVED', expiryDate: daysFromNow(250) },
      { type: 'PASSENGER_TRANSPORT_LICENCE', status: 'EXPIRED', expiryDate: daysAgo(5), note: 'Passenger transport licence expired.' },
    ],
    vehicles: [{ make: 'Toyota', model: 'Hilux', year: 2018, reg: 'GR 6678-18', status: 'VERIFIED' }],
  });

  // 8. PENDING company with a replacement-requested document (tests re-upload flow).
  await createSupplier('replacement-company', 'Accra Adventure Hub', 'verif.company.replacement@example.com', 'TOUR_COMPANY', 'PENDING', {
    createdAt: daysAgo(4),
    docs: [
      { type: 'BUSINESS_CERTIFICATE', status: 'REPLACEMENT_REQUESTED', note: 'Please upload the registration certificate with the Registrar stamp.' },
      { type: 'PROOF_OF_ADDRESS', status: 'APPROVED', expiryDate: daysFromNow(180) },
    ],
  });

  console.log('\nSeed complete.');
  console.log(`Login password for all seeded suppliers: ${LOGIN_PASSWORD}`);
  console.log('Open the admin Quality-Control page and the supplier list to review the pipeline.');
}

main()
  .catch((err) => {
    console.error('Seeding failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
