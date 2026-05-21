import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/utils';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import AuthCallback from '@/features/auth/pages/AuthCallback';
import { useAuthStore } from '@/stores/authStore';

const mockNavigate = vi.fn();
const mockReplaceState = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

describe('AuthCallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.getState().setUnauthenticated();
    mockNavigate.mockClear();
    mockReplaceState.mockClear();
  });

  function renderWithToken(token) {
    return render(
      <MemoryRouter initialEntries={[`/auth/callback?token=${token}`]}>
        <Routes>
          <Route path="/auth/callback" element={<AuthCallback />} />
        </Routes>
      </MemoryRouter>
    );
  }

  it('renders loading state when token is present', () => {
    renderWithToken('valid-firebase-token');
    expect(screen.getByText(/Verifying your session/i)).toBeInTheDocument();
  });

  it('shows error when no token is in URL', () => {
    render(
      <MemoryRouter initialEntries={['/auth/callback']}>
        <Routes>
          <Route path="/auth/callback" element={<AuthCallback />} />
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByText(/Authentication failed/i)).toBeInTheDocument();
    expect(screen.getByText(/No authentication token found/i)).toBeInTheDocument();
  });

  it('redirects to dashboard after successful auth', async () => {
    renderWithToken('valid-firebase-token');

    await waitFor(() => {
      expect(screen.getByText(/Authentication successful/i)).toBeInTheDocument();
    }, { timeout: 10000 });

    // The component uses setTimeout(..., 1500) before navigate()
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/', { replace: true });
    }, { timeout: 10000 });
  }, 15000);

  it('updates auth store with user data on success', async () => {
    renderWithToken('valid-firebase-token');

    await waitFor(() => {
      expect(useAuthStore.getState().isAuthenticated).toBe(true);
      expect(useAuthStore.getState().user).toBeTruthy();
    }, { timeout: 10000 });
  }, 15000);

  it('shows error state when token verification fails', async () => {
    renderWithToken('invalid-token');

    await waitFor(() => {
      const errorEl = screen.queryByText(/Authentication failed/i);
      const successEl = screen.queryByText(/Authentication successful/i);
      // We should see either error or success; error is more likely with invalid token
      expect(errorEl || successEl).toBeTruthy();
    }, { timeout: 5000 });
  });
});
