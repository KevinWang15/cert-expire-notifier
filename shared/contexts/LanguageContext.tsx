import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import type { LanguageCode } from "@shared/types/app";

type LanguageContextValue = {
  language: LanguageCode;
  setLanguage: (value: LanguageCode) => void;
};

const STORAGE_KEY = "language";
const LanguageContext = createContext<LanguageContextValue | undefined>(undefined);

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<LanguageCode>(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "zh" || saved === "ja" || saved === "en") {
      return saved;
    }
    return "en";
  });

  const setLanguage = (value: LanguageCode) => {
    localStorage.setItem(STORAGE_KEY, value);
    setLanguageState(value);
  };

  const value = useMemo(() => ({ language, setLanguage }), [language]);
  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage() {
  const context = useContext(LanguageContext);
  if (!context) {
    throw new Error("useLanguage must be used inside LanguageProvider");
  }
  return context;
}
