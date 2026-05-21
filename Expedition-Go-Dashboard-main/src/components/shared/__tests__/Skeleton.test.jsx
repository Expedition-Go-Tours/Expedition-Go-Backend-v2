import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import Skeleton, { TableSkeleton, CardSkeleton, ChartSkeleton } from '../Skeleton';

describe('Skeleton', () => {
  describe('Base Skeleton', () => {
    it('should render with default props', () => {
      const { container } = render(<Skeleton />);
      const skeleton = container.firstChild;
      
      expect(skeleton).toBeInTheDocument();
      expect(skeleton).toHaveClass('animate-pulse');
    });

    it('should render with custom height', () => {
      const { container } = render(<Skeleton height={100} />);
      const skeleton = container.firstChild;
      
      expect(skeleton).toHaveStyle({ height: '100px' });
    });

    it('should render with custom width', () => {
      const { container } = render(<Skeleton width={200} />);
      const skeleton = container.firstChild;
      
      expect(skeleton).toHaveStyle({ width: '200px' });
    });

    it('should render with percentage width', () => {
      const { container } = render(<Skeleton width="50%" />);
      const skeleton = container.firstChild;
      
      expect(skeleton).toHaveStyle({ width: '50%' });
    });

    it('should render text variant', () => {
      const { container } = render(<Skeleton variant="text" />);
      const skeleton = container.firstChild;
      
      expect(skeleton).toHaveClass('h-4');
      expect(skeleton).toHaveClass('rounded');
    });

    it('should render circular variant', () => {
      const { container } = render(<Skeleton variant="circular" />);
      const skeleton = container.firstChild;
      
      expect(skeleton).toHaveClass('rounded-full');
    });

    it('should render rectangular variant', () => {
      const { container } = render(<Skeleton variant="rectangular" />);
      const skeleton = container.firstChild;
      
      expect(skeleton).toHaveClass('rounded-lg');
    });

    it('should render multiple skeletons when count > 1', () => {
      const { container } = render(<Skeleton count={3} />);
      const skeletons = container.querySelectorAll('.animate-pulse');
      
      expect(skeletons).toHaveLength(3);
    });

    it('should apply custom className', () => {
      const { container } = render(<Skeleton className="custom-class" />);
      const skeleton = container.firstChild;
      
      expect(skeleton).toHaveClass('custom-class');
    });
  });

  describe('TableSkeleton', () => {
    it('should render with default rows and columns', () => {
      const { container } = render(<TableSkeleton />);
      const wrapper = container.querySelector('.bg-white.rounded-lg.border');
      
      expect(wrapper).toBeInTheDocument();
    });

    it('should render with custom rows', () => {
      const { container } = render(<TableSkeleton rows={3} />);
      const allRows = container.querySelectorAll('.border-b');
      // Should have header row + 3 body rows = 4 total
      expect(allRows.length).toBeGreaterThanOrEqual(3);
    });

    it('should render with custom columns', () => {
      const { container } = render(<TableSkeleton columns={4} />);
      const headerRow = container.querySelector('.border-b.p-4');
      const headerCells = headerRow.querySelectorAll('.animate-pulse');
      
      expect(headerCells).toHaveLength(4);
    });

    it('should have table structure', () => {
      const { container } = render(<TableSkeleton />);
      
      expect(container.querySelector('.rounded-lg.border')).toBeInTheDocument();
    });
  });

  describe('CardSkeleton', () => {
    it('should render with default count', () => {
      const { container } = render(<CardSkeleton />);
      const cards = container.querySelectorAll('.bg-white.rounded-lg');
      
      expect(cards).toHaveLength(1);
    });

    it('should render with custom count', () => {
      const { container } = render(<CardSkeleton count={4} />);
      const cards = container.querySelectorAll('.bg-white.rounded-lg');
      
      expect(cards).toHaveLength(4);
    });

    it('should have grid layout', () => {
      const { container } = render(<CardSkeleton count={4} />);
      const grid = container.firstChild;
      
      expect(grid).toHaveClass('grid');
    });
  });

  describe('ChartSkeleton', () => {
    it('should render with default height', () => {
      const { container } = render(<ChartSkeleton />);
      const skeletons = container.querySelectorAll('.animate-pulse');
      // Should have 2 skeletons: title and chart
      expect(skeletons.length).toBeGreaterThanOrEqual(2);
    });

    it('should render with custom height', () => {
      const { container } = render(<ChartSkeleton height={400} />);
      const skeletons = container.querySelectorAll('.animate-pulse');
      // Should have 2 skeletons: title and chart
      expect(skeletons.length).toBeGreaterThanOrEqual(2);
    });

    it('should have card wrapper', () => {
      const { container } = render(<ChartSkeleton />);
      
      expect(container.querySelector('.bg-white.rounded-lg')).toBeInTheDocument();
    });
  });
});
