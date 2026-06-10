jest.mock('cloudinary', () => ({
  v2: { uploader: { destroy: jest.fn() } },
}));

const cloudinary = require('cloudinary').v2;
const helper = require('../../utils/cloudinaryHelper');

describe('cloudinaryHelper', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
  });
});
