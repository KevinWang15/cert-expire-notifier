import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  LockKeyhole,
  Mail,
  Shield,
  UserRound,
} from "lucide-react";

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export default function SignupPage() {
  useDocumentTitle("Sign Up");
  const { signup } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [successMessage, setSuccessMessage] = useState("");
  const [successEmail, setSuccessEmail] = useState("");
  const [devVerificationUrl, setDevVerificationUrl] = useState("");
  const [deliveryStatus, setDeliveryStatus] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setSuccessMessage("");
    setDevVerificationUrl("");
    setDeliveryStatus("");

    const normalizedName = name.trim();
    if (!normalizedName) {
      setError("Name is required");
      return;
    }

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
      const result = await signup(email, password, normalizedName);
      setSuccessMessage(result.message);
      setSuccessEmail(result.email);
      setDevVerificationUrl(result.devVerificationUrl || "");
      setDeliveryStatus(result.emailDeliveryStatus || "");
      setPassword("");
      setConfirmPassword("");
    } catch (err: unknown) {
      setError(getErrorMessage(err, "Signup failed"));
    } finally {
      setLoading(false);
    }
  };

  if (successMessage) {
    return (
      <div className="relative flex min-h-screen overflow-hidden bg-slate-950 px-4 py-8 text-white sm:px-6 lg:px-8">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_10%_10%,rgba(34,211,238,0.24),transparent_28rem),radial-gradient(circle_at_85%_25%,rgba(16,185,129,0.18),transparent_26rem)]" />
        <section className="relative mx-auto w-full max-w-md self-center rounded-[2rem] border border-white/10 bg-white p-6 text-slate-950 shadow-2xl shadow-cyan-950/40 sm:p-8">
          <div className="text-center">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-600 ring-1 ring-emerald-200">
              <CheckCircle2 className="h-7 w-7" />
            </div>
            <h1 className="mt-5 text-3xl font-black tracking-tight">Check your inbox</h1>
            <p className="mt-2 text-sm text-slate-500">
              We created the account for{" "}
              <span className="font-bold text-slate-700">{successEmail}</span>.
            </p>
          </div>

          <div
            className={`mt-8 rounded-2xl border p-4 text-sm ${
              deliveryStatus === "SENT"
                ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                : "border-amber-200 bg-amber-50 text-amber-800"
            }`}
          >
            {successMessage}
          </div>

          {devVerificationUrl ? (
            <a
              href={devVerificationUrl}
              className="mt-3 block rounded-2xl border border-cyan-200 bg-cyan-50 p-3 text-sm font-bold text-cyan-800 underline underline-offset-4"
            >
              Open development verification link
            </a>
          ) : null}

          <div className="mt-6 grid gap-3">
            <Link
              to={`/verify-email?email=${encodeURIComponent(successEmail)}`}
              className="inline-flex h-12 items-center justify-center rounded-2xl bg-slate-950 text-sm font-black text-white shadow-lg shadow-slate-300 transition hover:bg-slate-800"
            >
              Resend or verify email
            </Link>
            <Link
              to="/login"
              className="inline-flex h-12 items-center justify-center rounded-2xl border border-slate-200 text-sm font-black text-slate-700 transition hover:bg-slate-50"
            >
              Back to sign in
            </Link>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="relative flex min-h-screen overflow-hidden bg-slate-950 px-4 py-8 text-white sm:px-6 lg:px-8">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_10%_10%,rgba(34,211,238,0.24),transparent_28rem),radial-gradient(circle_at_85%_25%,rgba(16,185,129,0.18),transparent_26rem)]" />
      <div className="relative mx-auto grid w-full max-w-6xl items-center gap-10 lg:grid-cols-[0.95fr_1.05fr]">
        <section className="mx-auto w-full max-w-md rounded-[2rem] border border-white/10 bg-white p-6 text-slate-950 shadow-2xl shadow-cyan-950/40 sm:p-8">
          <div className="text-center">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-950 text-cyan-200 shadow-lg shadow-slate-300">
              <Shield className="h-7 w-7" />
            </div>
            <h1 className="mt-5 text-3xl font-black tracking-tight">Create your workspace</h1>
            <p className="mt-2 text-sm text-slate-500">
              Verify your email before receiving certificate alerts.
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
              <span className="text-xs font-bold uppercase tracking-wide text-slate-500">Name</span>
              <div className="mt-1 flex items-center gap-2 rounded-2xl border border-slate-200 bg-slate-50 px-3 shadow-inner transition focus-within:border-slate-400 focus-within:bg-white focus-within:ring-4 focus-within:ring-slate-200/70">
                <UserRound className="h-4 w-4 text-slate-400" />
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="h-12 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-slate-400"
                  placeholder="Your name"
                />
              </div>
            </label>

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
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="h-12 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-slate-400"
                  placeholder="Repeat your password"
                />
              </div>
            </label>

            <button
              type="submit"
              disabled={loading}
              className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-slate-950 text-sm font-black text-white shadow-lg shadow-slate-300 transition hover:bg-slate-800 disabled:opacity-50"
            >
              {loading ? "Creating account..." : "Create account"}
              <ArrowRight className="h-4 w-4" />
            </button>
          </form>

          <p className="mt-6 text-center text-sm text-slate-500">
            Already have an account?{" "}
            <Link
              to="/login"
              className="font-black text-slate-950 underline decoration-cyan-300 decoration-2 underline-offset-4"
            >
              Sign in
            </Link>
          </p>
        </section>

        <section className="hidden lg:block">
          <div className="inline-flex items-center gap-2 rounded-full border border-emerald-200/20 bg-emerald-200/10 px-3 py-1 text-xs font-bold uppercase tracking-[0.18em] text-emerald-100">
            <CheckCircle2 className="h-4 w-4" />
            Renewal-ready dashboard
          </div>
          <h2 className="mt-6 max-w-2xl text-5xl font-black leading-tight tracking-tight">
            Build a living SSL inventory before the next certificate incident.
          </h2>
          <p className="mt-5 max-w-xl text-base leading-7 text-slate-300">
            Add domains, run certificate checks, filter by risk, keep markdown renewal notes, and
            audit every outgoing email.
          </p>
          <div className="mt-8 grid max-w-xl gap-3 sm:grid-cols-3">
            {["Email verification", "Password recovery", "Past email log"].map((item) => (
              <div
                key={item}
                className="rounded-2xl border border-white/10 bg-white/5 p-4 backdrop-blur"
              >
                <CheckCircle2 className="h-5 w-5 text-emerald-200" />
                <p className="mt-3 text-sm font-semibold text-slate-100">{item}</p>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
