import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import EmptyState, { EmptySearchResults, EmptyFilterResults } from '../EmptyState';

describe('EmptyState', () => {
  describe('Base EmptyState', () => {
    it('should render with title', () => {
      render(<EmptyState title="No data available" />);
      
      expect(screen.getByText('No data available')).toBeInTheDocument();
    });

    it('should render with description', () => {
      render(
        <EmptyState
          title="No data"
          description="This is a description"
        />
      );
      
      expect(screen.getByText('This is a description')).toBeInTheDocument();
    });

    it('should render with action button', () => {
      render(
        <EmptyState
          title="No data"
          action={<button>Create New</button>}
        />
      );
      
      expect(screen.getByRole('button', { name: 'Create New' })).toBeInTheDocument();
    });

    it('should render with default icon', () => {
      const { container } = render(<EmptyState title="No data" />);
      const icon = container.querySelector('svg');
      
      expect(icon).toBeInTheDocument();
    });

    it('should render with custom icon', () => {
      render(<EmptyState icon="search" title="No results" />);
      
      // Icon should be rendered (we can't easily test which specific icon)
      const { container } = render(<EmptyState icon="search" title="No results" />);
      expect(container.querySelector('svg')).toBeInTheDocument();
    });

    it('should render with small size', () => {
      const { container } = render(<EmptyState title="No data" size="sm" />);
      
      expect(container.firstChild).toHaveClass('py-8');
    });

    it('should render with medium size', () => {
      const { container } = render(<EmptyState title="No data" size="md" />);
      
      expect(container.firstChild).toHaveClass('py-12');
    });

    it('should render with large size', () => {
      const { container } = render(<EmptyState title="No data" size="lg" />);
      
      expect(container.firstChild).toHaveClass('py-16');
    });

    it('should apply custom className', () => {
      const { container } = render(
        <EmptyState title="No data" className="custom-class" />
      );
      
      expect(container.firstChild).toHaveClass('custom-class');
    });
  });

  describe('EmptySearchResults', () => {
    it('should render with search query', () => {
      render(<EmptySearchResults searchQuery="test query" />);
      
      expect(screen.getByText(/test query/i)).toBeInTheDocument();
    });

    it('should render without search query', () => {
      render(<EmptySearchResults />);
      
      expect(screen.getByText(/No results found/i)).toBeInTheDocument();
    });

    it('should call onClear when clear button is clicked', async () => {
      const user = userEvent.setup();
      const onClear = vi.fn();
      
      render(<EmptySearchResults searchQuery="test" onClear={onClear} />);
      
      const clearButton = screen.getByRole('button', { name: /clear search/i });
      await user.click(clearButton);
      
      expect(onClear).toHaveBeenCalledTimes(1);
    });

    it('should not render clear button when onClear is not provided', () => {
      render(<EmptySearchResults searchQuery="test" />);
      
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });
  });

  describe('EmptyFilterResults', () => {
    it('should render filter empty state', () => {
      render(<EmptyFilterResults />);
      
      expect(screen.getByText(/No matches found/i)).toBeInTheDocument();
    });

    it('should call onClear when clear button is clicked', async () => {
      const user = userEvent.setup();
      const onClear = vi.fn();
      
      render(<EmptyFilterResults onClear={onClear} />);
      
      const clearButton = screen.getByRole('button', { name: /clear all filters/i });
      await user.click(clearButton);
      
      expect(onClear).toHaveBeenCalledTimes(1);
    });

    it('should not render clear button when onClear is not provided', () => {
      render(<EmptyFilterResults />);
      
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });
  });
});
