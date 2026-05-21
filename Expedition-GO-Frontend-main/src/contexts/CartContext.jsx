import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { devWarn } from "@/lib/logger";

const CART_STORAGE_KEY = "cart_items_v1";
const CART_ITEM_TTL_MS = 25 * 60 * 1000;

const CartContext = createContext();

const getItemKey = (item) =>
  `${item.title}__${item.selectedDate}${item.selectedDateEnd ? `__${item.selectedDateEnd}` : ""}`;

const removeExpiredItems = (items) => {
  const now = Date.now();
  return items.filter((item) => Number(item.expiresAt) > now);
};

export function CartProvider({ children }) {
  const [cart, setCart] = useState(() => {
    const raw = localStorage.getItem(CART_STORAGE_KEY);
    if (!raw) return [];

    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return removeExpiredItems(parsed);
    } catch (error) {
      devWarn("[cart] Failed to parse localStorage", error);
      return [];
    }
  });

  useEffect(() => {
    localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(cart));
  }, [cart]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setCart((prev) => removeExpiredItems(prev));
    }, 30 * 1000);

    return () => window.clearInterval(intervalId);
  }, []);

  const addToCart = useCallback((item) => {
    if (!item?.selectedDate) {
      toast.error("Please select a date first.");
      return false;
    }

    const now = Date.now();
    const nextItem = {
      ...item,
      key: getItemKey(item),
      addedAt: now,
      expiresAt: now + CART_ITEM_TTL_MS,
    };

    setCart((prev) => {
      const withoutDuplicate = prev.filter((existing) => existing.key !== nextItem.key);
      return [...withoutDuplicate, nextItem];
    });

    toast.success("Tour added to cart");
    return true;
  }, []);

  const removeFromCart = useCallback((itemKey) => {
    setCart((prev) => prev.filter((item) => item.key !== itemKey));
  }, []);

  const clearCart = useCallback(() => {
    setCart([]);
  }, []);

  const value = useMemo(
    () => ({
      cart,
      addToCart,
      removeFromCart,
      clearCart,
      cartTtlMs: CART_ITEM_TTL_MS,
    }),
    [cart, addToCart, removeFromCart, clearCart]
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart() {
  const context = useContext(CartContext);
  if (!context) {
    throw new Error("useCart must be used within a CartProvider");
  }
  return context;
}
