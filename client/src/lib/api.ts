const API_BASE = "/api";

function getToken(): string | null {
  return localStorage.getItem("token");
}

export function setToken(token: string): void {
  localStorage.setItem("token", token);
}

export function clearToken(): void {
  localStorage.removeItem("token");
}

export function isAuthenticated(): boolean {
  return !!getToken();
}

async function parseResponseBody(res: Response): Promise<unknown> {
  const contentType = res.headers.get("content-type") || "";
  if (res.status === 204) {
    return null;
  }
  if (contentType.includes("application/json")) {
    return res.json();
  }
  return res.text();
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  });

  const data = await parseResponseBody(res);

  if (!res.ok) {
    const errorData = data && typeof data === "object" ? (data as { error?: string }) : null;

    if (res.status === 401 && token && !path.startsWith("/auth/login")) {
      clearToken();
      if (window.location.pathname !== "/login") {
        window.location.href = "/login";
      }
    }

    throw new Error(errorData?.error || "Request failed");
  }

  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: body ? JSON.stringify(body) : undefined }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "PUT", body: body ? JSON.stringify(body) : undefined }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};
