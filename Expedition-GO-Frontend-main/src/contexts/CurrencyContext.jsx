import { createContext, useContext, useState, useEffect } from "react";

const CurrencyContext = createContext();

// Currency conversion rates (relative to USD) - Updated April 2026
const exchangeRates = {
  USD: { symbol: "$", rate: 1.00, name: "US Dollar" },
  EUR: { symbol: "€", rate: 0.95, name: "Euro" },
  GBP: { symbol: "£", rate: 0.82, name: "British Pound" },
  JPY: { symbol: "¥", rate: 155.00, name: "Japanese Yen" },
  AUD: { symbol: "A$", rate: 1.58, name: "Australian Dollar" },
  CAD: { symbol: "C$", rate: 1.42, name: "Canadian Dollar" },
  CHF: { symbol: "CHF", rate: 0.91, name: "Swiss Franc" },
  CNY: { symbol: "¥", rate: 7.45, name: "Chinese Yuan" },
  INR: { symbol: "₹", rate: 84.50, name: "Indian Rupee" },
  SGD: { symbol: "S$", rate: 1.38, name: "Singapore Dollar" },
  HKD: { symbol: "HK$", rate: 7.85, name: "Hong Kong Dollar" },
  THB: { symbol: "฿", rate: 37.50, name: "Thai Baht" }
};

export function CurrencyProvider({ children }) {
  const [currency, setCurrency] = useState(() => {
    return localStorage.getItem('currency') || 'USD';
  });

  useEffect(() => {
    localStorage.setItem('currency', currency);
  }, [currency]);

  const convertPrice = (priceInUSD) => {
    const numericPrice = typeof priceInUSD === 'string' 
      ? parseFloat(priceInUSD.replace(/[^0-9.]/g, ''))
      : priceInUSD;
    
    const rate = exchangeRates[currency].rate;
    const convertedPrice = numericPrice * rate;
    
    // Format based on currency - some currencies use decimals, others don't
    let formatted;
    if (['JPY', 'CNY', 'INR', 'THB'].includes(currency)) {
      // No decimals for these currencies
      formatted = `${exchangeRates[currency].symbol}${Math.round(convertedPrice)}`;
    } else {
      // 2 decimals for other currencies
      formatted = `${exchangeRates[currency].symbol}${convertedPrice.toFixed(2)}`;
    }
    
    return {
      amount: convertedPrice,
      formatted: formatted,
      symbol: exchangeRates[currency].symbol,
      code: currency
    };
  };

  const getCurrencyInfo = () => {
    return exchangeRates[currency];
  };

  return (
    <CurrencyContext.Provider
      value={{
        currency,
        setCurrency,
        convertPrice,
        getCurrencyInfo,
        availableCurrencies: Object.keys(exchangeRates).map(code => ({
          code,
          ...exchangeRates[code]
        }))
      }}
    >
      {children}
    </CurrencyContext.Provider>
  );
}

export function useCurrency() {
  const context = useContext(CurrencyContext);
  if (!context) {
    throw new Error("useCurrency must be used within a CurrencyProvider");
  }
  return context;
}
