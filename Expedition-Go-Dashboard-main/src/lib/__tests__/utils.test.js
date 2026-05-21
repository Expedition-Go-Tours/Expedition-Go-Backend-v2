import { describe, it, expect } from 'vitest';
import { cn, formatCurrency, formatDate } from '../utils';

describe('utils', () => {
  describe('cn (className utility)', () => {
    it('should merge class names', () => {
      const result = cn('text-red-500', 'bg-blue-500');
      expect(result).toContain('text-red-500');
      expect(result).toContain('bg-blue-500');
    });

    it('should handle conditional classes', () => {
      const result = cn('base-class', true && 'conditional-class', false && 'hidden-class');
      expect(result).toContain('base-class');
      expect(result).toContain('conditional-class');
      expect(result).not.toContain('hidden-class');
    });

    it('should handle undefined and null', () => {
      const result = cn('base-class', undefined, null);
      expect(result).toBe('base-class');
    });
  });

  describe('formatCurrency', () => {
    it('should format USD currency', () => {
      const result = formatCurrency(1234.56, 'USD');
      expect(result).toBe('$1,234.56');
    });

    it('should format EUR currency', () => {
      const result = formatCurrency(1234.56, 'EUR');
      expect(result).toBe('€1,234.56');
    });

    it('should handle zero', () => {
      const result = formatCurrency(0, 'USD');
      expect(result).toBe('$0.00');
    });

    it('should handle negative numbers', () => {
      const result = formatCurrency(-1234.56, 'USD');
      expect(result).toBe('-$1,234.56');
    });

    it('should default to USD', () => {
      const result = formatCurrency(100);
      expect(result).toContain('$');
    });
  });

  describe('formatDate', () => {
    it('should format date string', () => {
      const result = formatDate('2026-05-20');
      expect(result).toMatch(/May 20, 2026/);
    });

    it('should format Date object', () => {
      const date = new Date('2026-05-20');
      const result = formatDate(date);
      expect(result).toMatch(/May 20, 2026/);
    });

    it('should handle invalid date', () => {
      const result = formatDate('invalid-date');
      expect(result).toBe('Invalid Date');
    });

    it('should handle null', () => {
      const result = formatDate(null);
      expect(result).toBe('');
    });

    it('should handle undefined', () => {
      const result = formatDate(undefined);
      expect(result).toBe('');
    });
  });
});
