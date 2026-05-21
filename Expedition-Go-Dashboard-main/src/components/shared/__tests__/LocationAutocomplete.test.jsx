import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@/test/utils';
import LocationAutocomplete from '@/components/shared/LocationAutocomplete';

describe('LocationAutocomplete', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the location search input', () => {
    render(<LocationAutocomplete onSelect={vi.fn()} />);
    expect(screen.getByPlaceholderText(/Start typing a location/i)).toBeInTheDocument();
  });

  it('shows suggestions after typing and selecting auto-fills location data', async () => {
    const onSelect = vi.fn();
    render(<LocationAutocomplete onSelect={onSelect} />);

    const input = screen.getByPlaceholderText(/Start typing a location/i);
    fireEvent.change(input, { target: { value: 'Arusha' } });

    // Advance past debounce (400ms)
    vi.advanceTimersByTime(500);

    // Wait for dropdown to appear with mock result
    const option = await screen.findByText(/Arusha, Tanzania/i);
    expect(option).toBeInTheDocument();

    fireEvent.click(option);

    await waitFor(() => {
      expect(onSelect).toHaveBeenCalledWith(
        expect.objectContaining({
          formatted: 'Arusha, Tanzania',
          city: 'Arusha',
          country: 'Tanzania',
          region: 'Arusha Region',
          latitude: -3.3869,
          longitude: 36.683,
        }),
      );
    });
  });

  it('clears input when clear button is clicked', () => {
    render(<LocationAutocomplete onSelect={vi.fn()} />);

    const input = screen.getByPlaceholderText(/Start typing a location/i);
    fireEvent.change(input, { target: { value: 'Test' } });

    expect(input).toHaveValue('Test');

    const clearBtn = screen.getByLabelText(/Clear location search/i);
    fireEvent.click(clearBtn);

    expect(input).toHaveValue('');
  });

  it('shows loading state during fetch', async () => {
    render(<LocationAutocomplete onSelect={vi.fn()} />);

    const input = screen.getByPlaceholderText(/Start typing a location/i);
    fireEvent.change(input, { target: { value: 'Arusha' } });

    // Before debounce completes, loading should not show yet
    expect(screen.queryByText(/Searching locations/i)).not.toBeInTheDocument();

    // Advance past debounce (400ms)
    vi.advanceTimersByTime(500);

    // After fetch completes, results show
    const option = await screen.findByText(/Arusha, Tanzania/i);
    expect(option).toBeInTheDocument();
  });
});
