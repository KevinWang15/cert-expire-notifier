import { createContext, useContext, type ReactNode } from "react";
import type { SiteVariant } from "@shared/types/app";

type SiteContextValue = {
  site: SiteVariant;
};

const SiteContext = createContext<SiteContextValue | undefined>(undefined);

export function SiteProvider({ children, site }: { children: ReactNode; site: SiteVariant }) {
  return <SiteContext.Provider value={{ site }}>{children}</SiteContext.Provider>;
}

export function useSite() {
  const context = useContext(SiteContext);
  if (!context) {
    throw new Error("useSite must be used inside SiteProvider");
  }
  return context;
}
