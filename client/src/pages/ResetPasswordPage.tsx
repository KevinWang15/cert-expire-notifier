import { useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "@/lib/api";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { AlertTriangle, ArrowRight, CheckCircle2, LockKeyhole, Shield } from "lucide-react";

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export default function ResetPasswordPage() {
  useDocumentTitle("Reset Password");
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") || "";
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState(token ? "" : "Reset token is missing. Request a new link.");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setMessage("");

    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }

    if (password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }

    setLoading(true);
    try {
      const data = await api.post<{ message: string }>("/auth/reset-password", {
        token,
        password,
      });
      setMessage(data.message);
      setPassword("");
      setConfirmPassword("");
    } catch (err: unknown) {
      setError(getErrorMessage(err, "Failed to reset password"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative flex min-h-screen overflow-hidden bg-slate-950 px-4 py-8 text-white sm:px-6 lg:px-8">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_15%_20%,rgba(34,211,238,0.24),transparent_28rem),radial-gradient(circle_at_85%_10%,rgba(129,140,248,0.22),transparent_26rem)]" />
      <section className="relative mx-auto w-full max-w-md self-center rounded-[2rem] border border-white/10 bg-white p-6 text-slate-950 shadow-2xl shadow-cyan-950/40 sm:p-8">
        <div className="text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-950 text-cyan-200 shadow-lg shadow-slate-300">
            <Shield className="h-7 w-7" />
          </div>
          <h1 className="mt-5 text-3xl font-black tracking-tight">Choose a new password</h1>
          <p className="mt-2 text-sm text-slate-500">
            Reset links are single-use and expire automatically.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="mt-8 space-y-4">
          {error ? (
            <div className="flex items-start gap-2 rounded-2xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" />
              <span>{error}</span>
            </div>
          ) : null}
          {message ? (
            <div className="flex items-start gap-2 rounded-2xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700">
              <CheckCircle2 className="mt-0.5 h-4 w-4 flex-none" />
              <span>{message}</span>
            </div>
          ) : null}

          <label className="block">
            <span className="text-xs font-bold uppercase tracking-wide text-slate-500">
              New password
            </span>
            <div className="mt-1 flex items-center gap-2 rounded-2xl border border-slate-200 bg-slate-50 px-3 shadow-inner transition focus-within:border-slate-400 focus-within:bg-white focus-within:ring-4 focus-within:ring-slate-200/70">
              <LockKeyhole className="h-4 w-4 text-slate-400" />
              <input
                type="password"
                required
                disabled={!token || !!message}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="h-12 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-slate-400 disabled:opacity-60"
                placeholder="At least 8 characters"
              />
            </div>
          </label>

          <label className="block">
            <span className="text-xs font-bold uppercase tracking-wide text-slate-500">
              Confirm password
            </span>
            <div className="mt-1 flex items-center gap-2 rounded-2xl border border-slate-200 bg-slate-50 px-3 shadow-inner transition focus-within:border-slate-400 focus-within:bg-white focus-within:ring-4 focus-within:ring-slate-200/70">
              <LockKeyhole className="h-4 w-4 text-slate-400" />
              <input
                type="password"
                required
                disabled={!token || !!message}
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                className="h-12 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-slate-400 disabled:opacity-60"
                placeholder="Repeat your password"
              />
            </div>
          </label>

          <button
            type="submit"
            disabled={loading || !token || !!message}
            className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-slate-950 text-sm font-black text-white shadow-lg shadow-slate-300 transition hover:bg-slate-800 disabled:opacity-50"
          >
            {loading ? "Saving..." : "Reset password"}
            <ArrowRight className="h-4 w-4" />
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-slate-500">
          {message ? "Password updated. " : null}
          <Link
            to={message ? "/login" : "/forgot-password"}
            className="font-black text-slate-950 underline decoration-cyan-300 decoration-2 underline-offset-4"
          >
            {message ? "Sign in" : "Request a new link"}
          </Link>
        </p>
      </section>
    </div>
  );
}
