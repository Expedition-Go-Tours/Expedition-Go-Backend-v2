import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { devWarn } from "@/lib/logger";

const RecentlyViewedContext = createContext({
  recentlyViewed: [],
  addToRecentlyViewed: () => {},
  clearRecentlyViewed: () => {},
});

const MAX_RECENT_ITEMS = 12;

export function RecentlyViewedProvider({ children }) {
  const { user } = useAuth();
  const [recentlyViewed, setRecentlyViewed] = useState(() => {
    // Initialize from localStorage immediately
    const storageKey = user ? `recentlyViewed_${user.uid}` : 'recentlyViewed_guest';
    const stored = localStorage.getItem(storageKey);
    if (stored) {
      try {
        return JSON.parse(stored);
      } catch (error) {
        devWarn("[recentlyViewed] Failed to parse localStorage", error);
        return [];
      }
    }
    return [];
  });

  // Save to localStorage whenever it changes
  useEffect(() => {
    const storageKey = user ? `recentlyViewed_${user.uid}` : 'recentlyViewed_guest';
    if (recentlyViewed.length > 0) {
      localStorage.setItem(storageKey, JSON.stringify(recentlyViewed));
    }
  }, [recentlyViewed, user]);

  const addToRecentlyViewed = useCallback((item) => {
    setRecentlyViewed((prev) => {
      // Remove if already exists
      const filtered = prev.filter((i) => i.title !== item.title);
      // Add to beginning
      const updated = [item, ...filtered];
      // Keep only MAX_RECENT_ITEMS
      return updated.slice(0, MAX_RECENT_ITEMS);
    });
  }, []);

  const clearRecentlyViewed = useCallback(() => {
    setRecentlyViewed([]);
    const storageKey = user ? `recentlyViewed_${user.uid}` : 'recentlyViewed_guest';
    localStorage.removeItem(storageKey);
  }, [user]);

  const value = useMemo(
    () => ({
      recentlyViewed,
      addToRecentlyViewed,
      clearRecentlyViewed,
    }),
    [recentlyViewed, addToRecentlyViewed, clearRecentlyViewed]
  );

  return (
    <RecentlyViewedContext.Provider value={value}>
      {children}
    </RecentlyViewedContext.Provider>
  );
}

export function useRecentlyViewed() {
  return useContext(RecentlyViewedContext);
}
