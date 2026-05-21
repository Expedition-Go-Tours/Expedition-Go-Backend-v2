import { render } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * Custom render function that wraps components with necessary providers
 * @param {React.ReactElement} ui - Component to render
 * @param {Object} options - Render options
 * @returns {Object} - Render result with utilities
 */
export function renderWithProviders(ui, options = {}) {
  const {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          cacheTime: 0,
        },
      },
    }),
    route = '/',
    ...renderOptions
  } = options;

  // Set initial route
  window.history.pushState({}, 'Test page', route);

  function Wrapper({ children }) {
    return (
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          {children}
        </BrowserRouter>
      </QueryClientProvider>
    );
  }

  return {
    ...render(ui, { wrapper: Wrapper, ...renderOptions }),
    queryClient,
  };
}

/**
 * Wait for loading to complete
 * @param {Function} callback - Callback to check if loading is complete
 * @param {Object} options - Wait options
 */
export async function waitForLoadingToFinish(callback, options = {}) {
  const { timeout = 3000 } = options;
  
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    
    const checkLoading = () => {
      if (callback()) {
        resolve();
      } else if (Date.now() - startTime > timeout) {
        reject(new Error('Timeout waiting for loading to finish'));
      } else {
        setTimeout(checkLoading, 50);
      }
    };
    
    checkLoading();
  });
}

/**
 * Create mock data for testing
 */
export const mockData = {
  user: {
    id: '1',
    name: 'Test User',
    email: 'test@example.com',
    role: 'ADMIN',
  },
  
  booking: {
    id: 'BK-2026-0001',
    bookingNumber: 'TGA-78234',
    customerName: 'John Smith',
    customerEmail: 'john@example.com',
    tourName: 'Serengeti Safari Adventure',
    travelDate: '2026-06-15',
    bookingDate: '2026-05-18',
    travelers: 4,
    total: 2400,
    status: 'CONFIRMED',
    paymentStatus: 'PAID',
    currency: 'USD',
  },
  
  product: {
    id: '1',
    title: 'Serengeti Safari Adventure',
    description: 'Experience the wildlife of Serengeti',
    category: 'safari',
    duration: 3,
    durationUnit: 'days',
    pricing: {
      basePrice: 600,
      currency: 'USD',
    },
    status: 'active',
  },
  
  review: {
    id: '1',
    tourName: 'Serengeti Safari Adventure',
    customerName: 'Jane Doe',
    rating: 5,
    comment: 'Amazing experience!',
    date: '2026-05-15',
    status: 'PENDING',
  },
};

/**
 * Create mock API responses
 */
export const mockApiResponses = {
  success: (data) => ({
    data,
    status: 200,
    statusText: 'OK',
  }),
  
  error: (message = 'An error occurred', status = 500) => ({
    response: {
      data: { message },
      status,
      statusText: 'Error',
    },
  }),
  
  validationError: (errors) => ({
    response: {
      data: { errors },
      status: 422,
      statusText: 'Validation Error',
    },
  }),
};

// Re-export everything from @testing-library/react
export * from '@testing-library/react';
export { default as userEvent } from '@testing-library/user-event';
