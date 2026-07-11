/* eslint-disable react-refresh/only-export-components, react-hooks/set-state-in-effect */
import { createContext, useContext, useState, useEffect, type ReactNode } from "react";
import { api, setToken, clearToken, isAuthenticated } from "@/lib/api";

interface User {
  id: number;
  email: string;
  name: string | null;
  emailVerifiedAt: string | null;
  notificationThresholdDays: number | null;
}

interface SignupResult {
  success: boolean;
  message: string;
  email: string;
  emailDeliveryStatus?: "PENDING" | "SENT" | "FAILED" | "SKIPPED";
  devVerificationUrl?: string;
}

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  signup: (email: string, password: string, name: string) => Promise<SignupResult>;
  verifyEmail: (token: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (isAuthenticated()) {
      api
        .get<{ user: User }>("/auth/me")
        .then((data) => setUser(data.user))
        .catch(() => {
          clearToken();
          setUser(null);
        })
        .finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, []);

  const login = async (email: string, password: string) => {
    const data = await api.post<{ token: string; user: User }>("/auth/login", {
      email,
      password,
    });
    setToken(data.token);
    setUser(data.user);
  };

  const signup = async (email: string, password: string, name: string) => {
    return api.post<SignupResult>("/auth/signup", {
      email,
      password,
      name,
    });
  };

  const verifyEmail = async (verificationToken: string) => {
    const data = await api.post<{ token: string; user: User }>("/auth/verify-email", {
      token: verificationToken,
    });
    setToken(data.token);
    setUser(data.user);
  };

  const logout = () => {
    clearToken();
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, signup, verifyEmail, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used inside AuthProvider");
  }
  return context;
}
