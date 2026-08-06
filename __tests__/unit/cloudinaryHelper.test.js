jest.mock('cloudinary', () => ({
  v2: { uploader: { destroy: jest.fn() } },
}));

jest.mock('../../utils/prismaClient', () => ({
  tour: { findFirst: jest.fn() },
  user: { findFirst: jest.fn() },
  review: { findFirst: jest.fn() },
  article: { findFirst: jest.fn() },
  message: { findFirst: jest.fn() },
}));

const cloudinary = require('cloudinary').v2;
const helper = require('../../utils/cloudinaryHelper');
const prisma = require('../../utils/prismaClient');

describe('cloudinaryHelper', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.tour.findFirst.mockResolvedValue(null);
    prisma.user.findFirst.mockResolvedValue(null);
    prisma.review.findFirst.mockResolvedValue(null);
    prisma.article.findFirst.mockResolvedValue(null);
    prisma.message.findFirst.mockResolvedValue(null);
  });

  describe('extractPublicIdFromUrl', () => {
    it('extracts public ID from simple URL', () => {
      const result = helper.extractPublicIdFromUrl('https://res.cloudinary.com/demo/image/upload/v123/user-photos/abc.jpg');
      expect(result).toBe('user-photos/abc');
    });

    it('extracts public ID from URL with transformations', () => {
      const result = helper.extractPublicIdFromUrl('https://res.cloudinary.com/demo/image/upload/w_1400,q_80,f_auto/v123/user-photos/abc.jpg');
      expect(result).toBe('user-photos/abc');
    });

    it('extracts public ID from URL without version', () => {
      const result = helper.extractPublicIdFromUrl('https://res.cloudinary.com/demo/image/upload/user-photos/abc.jpg');
      expect(result).toBe('user-photos/abc');
    });

    it('returns null for empty string', () => {
      expect(helper.extractPublicIdFromUrl('')).toBeNull();
    });

    it('returns null for non-string input', () => {
      expect(helper.extractPublicIdFromUrl(123)).toBeNull();
    });

    it('returns null if no /upload/ marker', () => {
      expect(helper.extractPublicIdFromUrl('https://example.com/photo.jpg')).toBeNull();
    });

    it('returns null if fewer than 2 path parts', () => {
      const result = helper.extractPublicIdFromUrl('https://res.cloudinary.com/demo/image/upload/abc.jpg');
      expect(result).toBeNull();
    });
  });

  describe('deleteCloudinaryImage', () => {
    it('deletes image when public ID can be extracted', async () => {
      cloudinary.uploader.destroy.mockResolvedValue({ result: 'ok' });
      await helper.deleteCloudinaryImage('https://res.cloudinary.com/demo/image/upload/v123/tours/photo.jpg');
      expect(cloudinary.uploader.destroy).toHaveBeenCalledWith('tours/photo');
    });

    it('skips delete when public ID cannot be extracted', async () => {
      await helper.deleteCloudinaryImage('');
      expect(cloudinary.uploader.destroy).not.toHaveBeenCalled();
    });

    it('handles cloudinary errors without throwing', async () => {
      cloudinary.uploader.destroy.mockRejectedValue(new Error('API error'));
      await expect(helper.deleteCloudinaryImage('https://res.cloudinary.com/demo/image/upload/v123/tours/photo.jpg')).resolves.not.toThrow();
    });

    it('skips delete when asset is still referenced by a tour', async () => {
      prisma.tour.findFirst.mockResolvedValue({ id: 'tour-1' });
      await helper.deleteCloudinaryImage('https://res.cloudinary.com/demo/image/upload/v123/tours/photo.jpg');
      expect(cloudinary.uploader.destroy).not.toHaveBeenCalled();
    });

    it('skips delete when asset is still referenced by a user avatar', async () => {
      prisma.user.findFirst.mockResolvedValue({ id: 'user-1' });
      await helper.deleteCloudinaryImage('https://res.cloudinary.com/demo/image/upload/v123/user-photos/photo.jpg');
      expect(cloudinary.uploader.destroy).not.toHaveBeenCalled();
    });

    it('skips delete when the reference check fails (fail closed)', async () => {
      prisma.tour.findFirst.mockRejectedValue(new Error('DB down'));
      await helper.deleteCloudinaryImage('https://res.cloudinary.com/demo/image/upload/v123/tours/photo.jpg');
      expect(cloudinary.uploader.destroy).not.toHaveBeenCalled();
    });

    it('deletes when referenced only by the excluded record', async () => {
      prisma.tour.findFirst.mockResolvedValue(null);
      cloudinary.uploader.destroy.mockResolvedValue({ result: 'ok' });
      await helper.deleteCloudinaryImage('https://res.cloudinary.com/demo/image/upload/v123/tours/photo.jpg', 3, { tourId: 'tour-1' });
      expect(cloudinary.uploader.destroy).toHaveBeenCalledWith('tours/photo');
    });
  });

  describe('isUrlReferenced', () => {
    it('returns false when no record references the URL', async () => {
      prisma.tour.findFirst.mockResolvedValue(null);
      prisma.user.findFirst.mockResolvedValue(null);
      prisma.review.findFirst.mockResolvedValue(null);
      prisma.article.findFirst.mockResolvedValue(null);
      prisma.message.findFirst.mockResolvedValue(null);
      await expect(helper.isUrlReferenced('https://res.cloudinary.com/demo/image/upload/v123/tours/photo.jpg')).resolves.toBe(false);
    });

    it('returns true when a review references the URL', async () => {
      prisma.review.findFirst.mockResolvedValue({ id: 'review-1' });
      await expect(helper.isUrlReferenced('https://res.cloudinary.com/demo/image/upload/v123/reviews/photo.jpg')).resolves.toBe(true);
    });

    it('returns false for empty input without querying', async () => {
      await expect(helper.isUrlReferenced('')).resolves.toBe(false);
    });
  });
});
