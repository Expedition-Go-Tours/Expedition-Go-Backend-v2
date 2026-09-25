/**
 * Multipart → Prisma normalisation for supplier documents/vehicles/guides.
 * The important guarantee here: only valid `DocumentType` values reach Prisma
 * (an unknown type used to throw inside the application transaction), and files
 * that are not real Cloudinary uploads are dropped rather than stored.
 */
const {
  parseDocuments,
  parseGuides,
  parseVehiclePhotos,
  parseVehicles,
  upsertVerificationRecords,
} = require('../../src/core/services/supplierVerification');

const cloudinaryUrl = (name) => `https://res.cloudinary.com/demo/image/upload/v1/supplier-documents/${name}`;

const file = (name, path = cloudinaryUrl(name)) => ({ path, originalname: name });

describe('supplierVerification', () => {
  describe('parseDocuments', () => {
    it('pairs files with documentMeta and keeps the supplier as owner', () => {
      const docs = parseDocuments({
        files: { documents: [file('id.png')] },
        body: { documentMeta: JSON.stringify([{ type: 'GHANA_CARD', ownerType: 'SUPPLIER' }]) },
      });

      expect(docs).toEqual([
        {
          url: cloudinaryUrl('id.png'),
          type: 'GHANA_CARD',
          ownerType: 'SUPPLIER',
          ownerKey: undefined,
          expiryDate: undefined,
          filename: 'id.png',
        },
      ]);
    });

    it('normalises casing and falls back to OTHER for unknown types', () => {
      const docs = parseDocuments({
        files: { documents: [file('a.png'), file('b.png'), file('c.png')] },
        body: {
          documentMeta: JSON.stringify([{ type: 'ghana_card' }, { type: 'NOT_A_REAL_TYPE' }, {}]),
        },
      });

      expect(docs.map((doc) => doc.type)).toEqual(['GHANA_CARD', 'OTHER', 'OTHER']);
    });

    it('drops files that are not Cloudinary uploads', () => {
      const docs = parseDocuments({
        files: { documents: [file('id.png', 'https://evil.example.com/id.png'), file('ok.png')] },
        body: { documentMeta: JSON.stringify([{ type: 'GHANA_CARD' }, { type: 'GHANA_CARD' }]) },
      });

      expect(docs).toHaveLength(1);
      expect(docs[0].url).toBe(cloudinaryUrl('ok.png'));
    });

    it('returns an empty array when nothing was uploaded', () => {
      expect(parseDocuments({ body: {} })).toEqual([]);
    });
  });

  describe('vehicle photos, vehicles and guides', () => {
    it('groups vehicle photos by vehicleKey', () => {
      const map = parseVehiclePhotos({
        files: { vehiclePhotos: [file('1.png'), file('2.png'), file('3.png')] },
        body: {
          vehiclePhotoMeta: JSON.stringify([{ vehicleKey: 'v1' }, { vehicleKey: 'v1' }, { vehicleKey: 'v2' }]),
        },
      });

      expect(map).toEqual({
        v1: [cloudinaryUrl('1.png'), cloudinaryUrl('2.png')],
        v2: [cloudinaryUrl('3.png')],
      });
    });

    it('keeps only complete vehicles and named guides', () => {
      expect(
        parseVehicles({
          vehicles: JSON.stringify([
            { key: 'v1', make: 'Toyota', model: 'Hiace', year: '2019', registrationNumber: 'GT-1234-19' },
            { key: 'v2', make: 'Toyota', model: 'Hiace' },
          ]),
        })
      ).toEqual([{ key: 'v1', make: 'Toyota', model: 'Hiace', year: 2019, registrationNumber: 'GT-1234-19' }]);

      expect(parseGuides({ guides: JSON.stringify([{ key: 'g1', fullName: 'Ama' }, { phone: '0200' }]) })).toEqual([
        { key: 'g1', fullName: 'Ama', phone: null, email: null },
      ]);
    });
  });

  describe('upsertVerificationRecords', () => {
    it('resolves vehicle/guide ownerKeys and creates the documents + event', async () => {
      const tx = {
        vehicle: { create: jest.fn(async () => ({ id: 'veh-1' })) },
        guide: { create: jest.fn(async () => ({ id: 'guide-1' })) },
        supplierDocument: { create: jest.fn(async () => ({})) },
        verificationEvent: { create: jest.fn(async () => ({})) },
      };

      await upsertVerificationRecords(tx, {
        profileId: 'sp-1',
        vehicles: [{ key: 'v1', make: 'Toyota', model: 'Hiace' }],
        guides: [{ key: 'g1', fullName: 'Ama' }],
        documents: [
          { url: cloudinaryUrl('id.png'), type: 'GHANA_CARD', ownerType: 'SUPPLIER' },
          { url: cloudinaryUrl('photo.png'), type: 'PROFILE_PHOTO', ownerType: 'VEHICLE', ownerKey: 'v1' },
          { url: cloudinaryUrl('licence.png'), type: 'TOUR_GUIDE_LICENCE', ownerType: 'GUIDE', ownerKey: 'g1' },
        ],
        action: 'APPLICATION_SUBMITTED',
      });

      expect(tx.supplierDocument.create).toHaveBeenCalledTimes(3);
      expect(tx.supplierDocument.create).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ data: expect.objectContaining({ ownerType: 'SUPPLIER', ownerId: 'sp-1' }) })
      );
      expect(tx.supplierDocument.create).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ data: expect.objectContaining({ ownerType: 'VEHICLE', ownerId: 'veh-1' }) })
      );
      expect(tx.supplierDocument.create).toHaveBeenNthCalledWith(
        3,
        expect.objectContaining({ data: expect.objectContaining({ ownerType: 'GUIDE', ownerId: 'guide-1' }) })
      );
      expect(tx.verificationEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ action: 'APPLICATION_SUBMITTED' }) })
      );
    });

    it('falls back to the supplier owner when a vehicle/guide key cannot be resolved', async () => {
      const tx = {
        vehicle: { create: jest.fn() },
        guide: { create: jest.fn() },
        supplierDocument: { create: jest.fn(async () => ({})) },
        verificationEvent: { create: jest.fn(async () => ({})) },
      };

      await upsertVerificationRecords(tx, {
        profileId: 'sp-1',
        documents: [
          { url: cloudinaryUrl('x.png'), type: 'VEHICLE_INSURANCE', ownerType: 'VEHICLE', ownerKey: 'missing' },
        ],
      });

      expect(tx.supplierDocument.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ ownerType: 'SUPPLIER', ownerId: 'sp-1' }) })
      );
    });
  });
});
