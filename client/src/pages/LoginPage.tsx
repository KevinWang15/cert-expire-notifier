import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { AlertTriangle, ArrowRight, CheckCircle2, LockKeyhole, Mail, Shield } from "lucide-react";

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export default function LoginPage() {
  useDocumentTitle("Login");
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await login(email, password);
      navigate("/");
    } catch (err: unknown) {
      setError(getErrorMessage(err, "Login failed"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative flex min-h-screen overflow-hidden bg-slate-950 px-4 py-8 text-white sm:px-6 lg:px-8">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_15%_20%,rgba(34,211,238,0.24),transparent_28rem),radial-gradient(circle_at_85%_10%,rgba(129,140,248,0.22),transparent_26rem)]" />
      <div className="relative mx-auto grid w-full max-w-6xl items-center gap-10 lg:grid-cols-[1.05fr_0.95fr]">
        <section className="hidden lg:block">
          <div className="inline-flex items-center gap-2 rounded-full border border-cyan-200/20 bg-cyan-200/10 px-3 py-1 text-xs font-bold uppercase tracking-[0.18em] text-cyan-100">
            <Shield className="h-4 w-4" />
            Certificate operations
          </div>
          <h1 className="mt-6 max-w-2xl text-5xl font-black leading-tight tracking-tight">
            Prevent surprise SSL outages with a sharper renewal command center.
          </h1>
          <p className="mt-5 max-w-xl text-base leading-7 text-slate-300">
            Track risk, issuer data, check freshness, renewal notes, and email delivery from one
            dense dashboard built for operators.
          </p>
          <div className="mt-8 grid max-w-xl gap-3 sm:grid-cols-3">
            {["Verified alerts", "Reset recovery", "Email audit trail"].map((item) => (
              <div
                key={item}
                className="rounded-2xl border border-white/10 bg-white/5 p-4 backdrop-blur"
              >
                <CheckCircle2 className="h-5 w-5 text-cyan-200" />
                <p className="mt-3 text-sm font-semibold text-slate-100">{item}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="mx-auto w-full max-w-md rounded-[2rem] border border-white/10 bg-white p-6 text-slate-950 shadow-2xl shadow-cyan-950/40 sm:p-8">
          <div className="text-center">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-950 text-cyan-200 shadow-lg shadow-slate-300">
              <Shield className="h-7 w-7" />
            </div>
            <h2 className="mt-5 text-3xl font-black tracking-tight">Welcome back</h2>
            <p className="mt-2 text-sm text-slate-500">
              Sign in to monitor certificates and renewal notes.
            </p>
          </div>

          <form onSubmit={handleSubmit} className="mt-8 space-y-4">
            {error ? (
              <div className="flex items-start gap-2 rounded-2xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
                <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" />
                <span>{error}</span>
              </div>
            ) : null}

            <label className="block">
              <span className="text-xs font-bold uppercase tracking-wide text-slate-500">
                Email
              </span>
              <div className="mt-1 flex items-center gap-2 rounded-2xl border border-slate-200 bg-slate-50 px-3 shadow-inner transition focus-within:border-slate-400 focus-within:bg-white focus-within:ring-4 focus-within:ring-slate-200/70">
                <Mail className="h-4 w-4 text-slate-400" />
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="h-12 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-slate-400"
                  placeholder="you@example.com"
                />
              </div>
            </label>

            <label className="block">
              <span className="text-xs font-bold uppercase tracking-wide text-slate-500">
                Password
              </span>
              <div className="mt-1 flex items-center gap-2 rounded-2xl border border-slate-200 bg-slate-50 px-3 shadow-inner transition focus-within:border-slate-400 focus-within:bg-white focus-within:ring-4 focus-within:ring-slate-200/70">
                <LockKeyhole className="h-4 w-4 text-slate-400" />
                <input
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="h-12 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-slate-400"
                  placeholder="Enter your password"
                />
              </div>
            </label>

            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <Link
                to="/forgot-password"
                className="font-bold text-slate-700 underline decoration-cyan-300 decoration-2 underline-offset-4 hover:text-slate-950"
              >
                Forgot password?
              </Link>
              <Link
                to={`/verify-email${email ? `?email=${encodeURIComponent(email)}` : ""}`}
                className="font-bold text-slate-500 hover:text-slate-950"
              >
                Resend verification
              </Link>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-slate-950 text-sm font-black text-white shadow-lg shadow-slate-300 transition hover:bg-slate-800 disabled:opacity-50"
            >
              {loading ? "Signing in..." : "Sign in"}
              <ArrowRight className="h-4 w-4" />
            </button>
          </form>

          <p className="mt-6 text-center text-sm text-slate-500">
            Don&apos;t have an account?{" "}
            <Link
              to="/signup"
              className="font-black text-slate-950 underline decoration-cyan-300 decoration-2 underline-offset-4"
            >
              Create one
            </Link>
          </p>
        </section>
      </div>
    </div>
  );
}
