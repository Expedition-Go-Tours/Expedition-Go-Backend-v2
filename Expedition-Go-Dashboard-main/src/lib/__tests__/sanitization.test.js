import { describe, it, expect } from 'vitest';
import {
  sanitizeString,
  sanitizeHTML,
  sanitizeFilename,
  sanitizeURL,
  sanitizeEmail,
  sanitizePhone,
  validateFileUpload,
  escapeSQLLike,
  sanitizeObject,
} from '../sanitization';

describe('sanitization', () => {
  describe('sanitizeString', () => {
    it('should remove < and > characters', () => {
      const result = sanitizeString('<script>alert("xss")</script>');
      expect(result).not.toContain('<');
      expect(result).not.toContain('>');
    });

    it('should trim whitespace', () => {
      const result = sanitizeString('  hello  ');
      expect(result).toBe('hello');
    });

    it('should handle non-string input', () => {
      expect(sanitizeString(123)).toBe('');
      expect(sanitizeString(null)).toBe('');
      expect(sanitizeString(undefined)).toBe('');
    });
  });

  describe('sanitizeHTML', () => {
    it('should remove script tags', () => {
      const result = sanitizeHTML('<p>Hello</p><script>alert("xss")</script>');
      expect(result).not.toContain('<script>');
      expect(result).toContain('<p>Hello</p>');
    });

    it('should remove event handlers', () => {
      const result = sanitizeHTML('<div onclick="alert(\'xss\')">Click me</div>');
      expect(result).not.toContain('onclick');
    });

    it('should handle non-string input', () => {
      expect(sanitizeHTML(123)).toBe('');
      expect(sanitizeHTML(null)).toBe('');
    });
  });

  describe('sanitizeFilename', () => {
    it('should replace special characters with underscore', () => {
      const result = sanitizeFilename('my file!@#$.txt');
      expect(result).toBe('my_file____.txt');
    });

    it('should remove multiple dots', () => {
      const result = sanitizeFilename('file...txt');
      expect(result).toBe('file.txt');
    });

    it('should remove leading dots', () => {
      const result = sanitizeFilename('...file.txt');
      expect(result).toBe('file.txt');
    });

    it('should limit length to 255 characters', () => {
      const longName = 'a'.repeat(300) + '.txt';
      const result = sanitizeFilename(longName);
      expect(result.length).toBeLessThanOrEqual(255);
    });
  });

  describe('sanitizeURL', () => {
    it('should accept valid http URL', () => {
      const result = sanitizeURL('http://example.com');
      expect(result).toBe('http://example.com/');
    });

    it('should accept valid https URL', () => {
      const result = sanitizeURL('https://example.com');
      expect(result).toBe('https://example.com/');
    });

    it('should reject javascript: protocol', () => {
      const result = sanitizeURL('javascript:alert("xss")');
      expect(result).toBeNull();
    });

    it('should reject data: protocol', () => {
      const result = sanitizeURL('data:text/html,<script>alert("xss")</script>');
      expect(result).toBeNull();
    });

    it('should handle invalid URL', () => {
      const result = sanitizeURL('not a url');
      expect(result).toBeNull();
    });

    it('should handle non-string input', () => {
      expect(sanitizeURL(123)).toBeNull();
      expect(sanitizeURL(null)).toBeNull();
    });
  });

  describe('sanitizeEmail', () => {
    it('should lowercase email', () => {
      const result = sanitizeEmail('TEST@EXAMPLE.COM');
      expect(result).toBe('test@example.com');
    });

    it('should trim whitespace', () => {
      const result = sanitizeEmail('  test@example.com  ');
      expect(result).toBe('test@example.com');
    });

    it('should remove invalid characters', () => {
      const result = sanitizeEmail('test!#$@example.com');
      expect(result).toMatch(/^[a-z0-9@.+-]+$/);
    });

    it('should handle non-string input', () => {
      expect(sanitizeEmail(123)).toBe('');
    });
  });

  describe('sanitizePhone', () => {
    it('should keep valid phone characters', () => {
      const result = sanitizePhone('+1 (555) 123-4567');
      expect(result).toBe('+1 (555) 123-4567');
    });

    it('should remove invalid characters', () => {
      const result = sanitizePhone('+1abc555def1234567');
      expect(result).toBe('+15551234567');
    });

    it('should handle non-string input', () => {
      expect(sanitizePhone(123)).toBe('');
    });
  });

  describe('validateFileUpload', () => {
    it('should accept valid file', () => {
      const file = new File(['content'], 'test.jpg', { type: 'image/jpeg' });
      const result = validateFileUpload(file);
      
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.sanitizedName).toBe('test.jpg');
    });

    it('should reject invalid file type', () => {
      const file = new File(['content'], 'test.exe', { type: 'application/exe' });
      const result = validateFileUpload(file);
      
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should reject file exceeding size limit', () => {
      const largeContent = new Array(6 * 1024 * 1024).fill('a').join('');
      const file = new File([largeContent], 'large.jpg', { type: 'image/jpeg' });
      const result = validateFileUpload(file);
      
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('size'))).toBe(true);
    });

    it('should accept custom allowed types', () => {
      const file = new File(['content'], 'test.pdf', { type: 'application/pdf' });
      const result = validateFileUpload(file, {
        allowedTypes: ['application/pdf'],
      });
      
      expect(result.valid).toBe(true);
    });

    it('should accept custom max size', () => {
      const content = new Array(2 * 1024 * 1024).fill('a').join('');
      const file = new File([content], 'test.jpg', { type: 'image/jpeg' });
      const result = validateFileUpload(file, {
        maxSize: 1 * 1024 * 1024, // 1MB
      });
      
      expect(result.valid).toBe(false);
    });
  });

  describe('escapeSQLLike', () => {
    it('should escape backslash', () => {
      const result = escapeSQLLike('test\\value');
      expect(result).toBe('test\\\\value');
    });

    it('should escape percent', () => {
      const result = escapeSQLLike('test%value');
      expect(result).toBe('test\\%value');
    });

    it('should escape underscore', () => {
      const result = escapeSQLLike('test_value');
      expect(result).toBe('test\\_value');
    });

    it('should escape all special characters', () => {
      const result = escapeSQLLike('test\\%_value');
      expect(result).toBe('test\\\\\\%\\_value');
    });

    it('should handle non-string input', () => {
      expect(escapeSQLLike(123)).toBe('');
    });
  });

  describe('sanitizeObject', () => {
    it('should remove null values', () => {
      const result = sanitizeObject({ a: 1, b: null, c: 3 });
      expect(result).toEqual({ a: 1, c: 3 });
    });

    it('should remove undefined values', () => {
      const result = sanitizeObject({ a: 1, b: undefined, c: 3 });
      expect(result).toEqual({ a: 1, c: 3 });
    });

    it('should remove empty strings', () => {
      const result = sanitizeObject({ a: 1, b: '', c: 3 });
      expect(result).toEqual({ a: 1, c: 3 });
    });

    it('should keep zero values', () => {
      const result = sanitizeObject({ a: 0, b: null });
      expect(result).toEqual({ a: 0 });
    });

    it('should keep false values', () => {
      const result = sanitizeObject({ a: false, b: null });
      expect(result).toEqual({ a: false });
    });

    it('should handle non-object input', () => {
      expect(sanitizeObject(null)).toEqual({});
      expect(sanitizeObject(123)).toEqual({});
      expect(sanitizeObject('string')).toEqual({});
    });
  });
});
