// Run: node scripts/restore-supplier.js
// Restores Gideon Wilson's full profile to local DB

const prisma = require('../utils/prismaClient');

async function main() {
  const email = 'rxsieon@gmail.com';

  // Check if user exists in local DB
  let user = await prisma.user.findUnique({ where: { email } });

  if (!user) {
    // Create the user with Supabase data
    user = await prisma.user.create({
      data: {
        id: 'cmpvddkrf0000aasjd6gsvqev',
        firebaseUid: 'nkf2QYbJ5TXAGT6ZnDniPeEV5jF3',
        name: 'Gideon Wilson',
        email: 'rxsieon@gmail.com',
        photoURL: 'https://lh3.googleusercontent.com/a/ACg8ocJn1eM8pG9xWvmkEFOh4WYanf_sdeGDguVKchZ-R-_HagiVueRA=s96-c',
        phone: '0256674138',
        roles: ['supplier'],
        language: 'en',
        timezone: 'UTC',
        active: true,
        emailVerified: false,
        authProvider: 'google',
        logoUrl: 'https://res.cloudinary.com/dfpagrtoy/image/upload/v1780670572/user-photos/vdrxzjwlzxhqs091mg5a.png',
        notificationPreferences: '{"pushNotifications": {"reviews": true, "bookings": true, "payments": true, "systemAlerts": true}, "emailNotifications": {"reviews": true, "bookings": true, "payments": true, "systemAlerts": true}}',
      },
    });
    console.log('User created:', user.email);
  } else {
    // Update existing user with supplier role
    user = await prisma.user.update({
      where: { email },
      data: {
        roles: { set: ['supplier'] },
        photoURL: 'https://lh3.googleusercontent.com/a/ACg8ocJn1eM8pG9xWvmkEFOh4WYanf_sdeGDguVKchZ-R-_HagiVueRA=s96-c',
        logoUrl: 'https://res.cloudinary.com/dfpagrtoy/image/upload/v1780670572/user-photos/vdrxzjwlzxhqs091mg5a.png',
      },
    });
    console.log('User updated:', user.email);
  }

  // Check if supplier profile exists
  const existing = await prisma.supplierProfile.findUnique({
    where: { userId: user.id },
  });

  if (!existing) {
    await prisma.supplierProfile.create({
      data: {
        userId: user.id,
        status: 'ACTIVE',
        businessInfo: JSON.stringify({
          city: 'Accra',
          phone: '+233501234567',
          state: 'Greater Accra',
          taxId: 'TIN-GH-98765432',
          region: '',
          address: '42 Liberation Road, Accra',
          country: 'Ghana',
          twitter: '',
          website: 'https://gideonexpeditions.com',
          facebook: '',
          instagram: '',
          description: 'Premier tour operator specializing in authentic Ghanaian cultural experiences, wildlife safaris, and coastal adventures. With over 8 years of experience, we deliver unforgettable journeys across Ghana and West Africa.',
          businessName: 'Gideon Expeditions',
          businessType: 'Individual',
          operatingHours: '',
          registrationNumber: 'CS1234567890',
        }),
        operatingInfo: JSON.stringify({
          hours: { friday: '08:00-18:00', monday: '08:00-18:00', sunday: 'closed', tuesday: '08:00-18:00', saturday: '09:00-15:00', thursday: '08:00-18:00', wednesday: '08:00-18:00' },
          regions: ['West Africa', 'Ghana'],
          capacity: { maxGroupSize: 25, monthlyBookings: 80 },
          languages: ['English', 'Twi', 'Ga'],
          serviceArea: 'Local & Regional',
          destinations: ['Accra', 'Kumasi', 'Cape Coast', 'Kakum', 'Elmina', 'Ada', 'Volta Region'],
          operatingSince: '2018',
        }),
        representativeInfo: JSON.stringify({
          email: 'rxsieon@gmail.com',
          phone: '+233501234567',
          idType: 'Passport',
          address: '42 Liberation Road, Accra, Ghana',
          fullName: 'Gideon Wilson',
          idNumber: 'GH-PP-87654321',
          position: 'Owner & Lead Guide',
        }),
        businessDocuments: JSON.stringify({
          insurance: 'https://cloudinary.com/gideon/insurance.pdf',
          identification: 'https://cloudinary.com/gideon/id.pdf',
          taxCertificate: 'https://cloudinary.com/gideon/tax.pdf',
          certificateOfRegistration: 'https://cloudinary.com/gideon/registration.pdf',
        }),
        payoutInfo: JSON.stringify({
          method: 'bank_transfer',
          bankCode: '013',
          bankName: 'GCB Bank',
          currency: 'GHS',
          accountName: 'Gideon Wilson',
          accountNumber: '1234567890123',
        }),
        compliance: JSON.stringify({
          termsAccepted: true,
          privacyAccepted: true,
          termsAcceptedAt: '2026-01-15T00:00:00.000Z',
          marketingConsent: true,
          codeOfConductAccepted: true,
          dataProcessingAccepted: true,
        }),
        totalEarnings: 48750.00,
        totalBookings: 47,
        averageRating: 4.70,
      },
    });
    console.log('Supplier profile created');
  } else {
    console.log('Supplier profile already exists');
  }

  console.log('Done! You can now sign in as rxsieon@gmail.com');
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  prisma.$disconnect();
  process.exit(1);
});
