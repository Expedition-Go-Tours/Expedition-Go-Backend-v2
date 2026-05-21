import { createContext, useContext, useState, useEffect, useMemo, useCallback } from "react";
import { toast } from "sonner";

import { devWarn } from "@/lib/logger";

const WishlistContext = createContext();

export function WishlistProvider({ children }) {
  const [wishlist, setWishlist] = useState(() => {
    const savedWishlist = localStorage.getItem("wishlist");
    if (!savedWishlist) return [];
    try {
      return JSON.parse(savedWishlist);
    } catch (error) {
      devWarn("[wishlist] Failed to parse localStorage", error);
      return [];
    }
  });

  // Save wishlist to localStorage whenever it changes
  useEffect(() => {
    localStorage.setItem("wishlist", JSON.stringify(wishlist));
  }, [wishlist]);

  const addToWishlist = useCallback((item) => {
    setWishlist((prev) => {
      const exists = prev.some((i) => i.title === item.title);
      if (exists) return prev;
      return [...prev, { ...item, addedAt: new Date().toISOString() }];
    });
  }, []);

  const removeFromWishlist = useCallback((itemTitle) => {
    setWishlist((prev) => prev.filter((item) => item.title !== itemTitle));
  }, []);

  const wishlistTitles = useMemo(() => new Set(wishlist.map((item) => item.title)), [wishlist]);

  const isInWishlist = useCallback((itemTitle) => wishlistTitles.has(itemTitle), [wishlistTitles]);

  const toggleWishlist = useCallback((item) => {
    const exists = wishlistTitles.has(item.title);

    setWishlist((prev) => {
      if (exists) {
        return prev.filter((i) => i.title !== item.title);
      }
      return [...prev, { ...item, addedAt: new Date().toISOString() }];
    });

    if (exists) {
      toast.error("Removed from WishList", {
        style: {
          background: "#FEF2F2",
          color: "#B91C1C",
          border: "1px solid rgba(185, 28, 28, 0.25)",
        },
      });
    } else {
      toast.success("Added to Wishlist");
    }
  }, [wishlistTitles]);

  const value = useMemo(
    () => ({
      wishlist,
      addToWishlist,
      removeFromWishlist,
      isInWishlist,
      toggleWishlist,
    }),
    [wishlist, addToWishlist, removeFromWishlist, isInWishlist, toggleWishlist]
  );

  return (
    <WishlistContext.Provider value={value}>
      {children}
    </WishlistContext.Provider>
  );
}

export function useWishlist() {
  const context = useContext(WishlistContext);
  if (!context) {
    throw new Error("useWishlist must be used within a WishlistProvider");
  }
  return context;
}
