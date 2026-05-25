-- Restore deleted supplier profile
INSERT INTO "SupplierProfile" (id, "userId", status, "businessInfo", "operatingInfo", "representativeInfo", "businessDocuments", "payoutInfo", compliance, "createdAt", "updatedAt")
VALUES (
  'cmpct6opw00013yl1dg725h5p',
  'cmp2taahz0002uhqrmazvmmsc',
  'ACTIVE',
  '{"city":"Lagos","phone":"+2348000000000","state":"Lagos","taxId":"TIN12345678","address":"12 Example Street","country":"Nigeria","website":"https://travioafrica.com","description":"Tour operator providing unforgettable experiences across Africa.","businessName":"Richard Tours","businessType":"Individual","registrationNumber":"RC1234567"}'::jsonb,
  '{"hours":{"friday":"08:00-18:00","monday":"08:00-18:00","sunday":"closed","tuesday":"08:00-18:00","saturday":"09:00-15:00","thursday":"08:00-18:00","wednesday":"08:00-18:00"},"regions":["West Africa"],"capacity":{"maxGroupSize":20,"monthlyBookings":50},"languages":["English"],"serviceArea":"Local","destinations":["Lagos","Abuja","Calabar"],"operatingSince":"2024"}'::jsonb,
  '{"email":"qwabs94@gmail.com","phone":"+2348000000000","idType":"Passport","address":"12 Example Street, Lagos","fullName":"Richard Boachie","idNumber":"A12345678","position":"Owner"}'::jsonb,
  '{"insurance":"https://example.com/docs/insurance.pdf","identification":"https://example.com/docs/id.pdf","taxCertificate":"https://example.com/docs/tax.pdf","certificateOfRegistration":"https://example.com/docs/registration.pdf"}'::jsonb,
  '{"method":"bank_transfer","bankCode":"011","bankName":"Example Bank","currency":"NGN","accountName":"Richard Boachie","accountNumber":"0123456789"}'::jsonb,
  '{"termsAccepted":true,"privacyAccepted":true,"termsAcceptedAt":"2026-05-19T15:49:43.456Z","marketingConsent":false,"codeOfConductAccepted":true,"dataProcessingAccepted":true}'::jsonb,
  '2026-05-19 15:49:43.46'::timestamp,
  '2026-05-19 15:49:43.46'::timestamp
);
