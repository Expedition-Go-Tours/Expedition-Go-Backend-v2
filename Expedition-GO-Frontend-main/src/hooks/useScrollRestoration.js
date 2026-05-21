import { useEffect } from "react";
import { useLocation } from "react-router-dom";

const HOMEPAGE_SCROLL_KEY = "homepage_scroll_position";

/**
 * Custom scroll restoration hook
 * - Homepage: Restores previous scroll position when returning
 * - All other pages: Scroll to top on entry
 */
export function useScrollRestoration() {
  const location = useLocation();
  const isHomePage = location.pathname === "/";

  useEffect(() => {
    if (isHomePage) {
      // Homepage: Restore previous scroll position immediately
      const savedPosition = sessionStorage.getItem(HOMEPAGE_SCROLL_KEY);
      if (savedPosition) {
        // Immediate scroll - no setTimeout delay
        window.scrollTo(0, parseInt(savedPosition, 10));
      }
    } else {
      // All other pages: Scroll to top immediately
      window.scrollTo(0, 0);
    }
  }, [location.pathname, isHomePage]);

  useEffect(() => {
    if (!isHomePage) return;

    // Save homepage scroll position when navigating away
    const saveScrollPosition = () => {
      sessionStorage.setItem(HOMEPAGE_SCROLL_KEY, window.scrollY.toString());
    };

    // Save on scroll (debounced)
    let scrollTimeout;
    const handleScroll = () => {
      clearTimeout(scrollTimeout);
      scrollTimeout = setTimeout(saveScrollPosition, 100);
    };

    window.addEventListener("scroll", handleScroll, { passive: true });

    return () => {
      window.removeEventListener("scroll", handleScroll);
      clearTimeout(scrollTimeout);
      // Save one final time when leaving homepage
      saveScrollPosition();
    };
  }, [isHomePage]);
}
