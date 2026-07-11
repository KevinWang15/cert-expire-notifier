import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { api } from "@/lib/api";
import { AlertTriangle, ArrowRight, CheckCircle2, Mail, RefreshCw, Shield } from "lucide-react";

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export default function VerifyEmailPage() {
  useDocumentTitle("Verify Email");
  const { verifyEmail } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") || "";
  const submittedRef = useRef(false);
  const [status, setStatus] = useState<"idle" | "verifying" | "verified" | "error">(
    token ? "verifying" : "idle",
  );
  const [email, setEmail] = useState(searchParams.get("email") || "");
  const [message, setMessage] = useState(
    token ? "Verifying your email..." : "Enter your email to request a fresh verification link.",
  );
  const [devVerificationUrl, setDevVerificationUrl] = useState("");
  const [resendLoading, setResendLoading] = useState(false);

  useEffect(() => {
    if (!token || submittedRef.current) {
      return;
    }

    submittedRef.current = true;
    setStatus("verifying");
    verifyEmail(token)
      .then(() => {
        setStatus("verified");
        setMessage("Email verified. Taking you to your dashboard...");
        setTimeout(() => navigate("/", { replace: true }), 800);
      })
      .catch((err: unknown) => {
        setStatus("error");
        setMessage(getErrorMessage(err, "Verification link is invalid or expired"));
      });
  }, [navigate, token, verifyEmail]);

  const handleResend = async (event: FormEvent) => {
    event.preventDefault();
    setResendLoading(true);
    setDevVerificationUrl("");
    try {
      const data = await api.post<{ message: string; devVerificationUrl?: string }>(
        "/auth/resend-verification",
        { email },
      );
      setStatus("idle");
      setMessage(data.message);
      setDevVerificationUrl(data.devVerificationUrl || "");
    } catch (err: unknown) {
      setStatus("error");
      setMessage(getErrorMessage(err, "Failed to resend verification email"));
    } finally {
      setResendLoading(false);
    }
  };

  const isPositive = status === "verified" || (!!message && status === "idle" && !token);

  return (
    <div className="relative flex min-h-screen overflow-hidden bg-slate-950 px-4 py-8 text-white sm:px-6 lg:px-8">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_15%_20%,rgba(34,211,238,0.24),transparent_28rem),radial-gradient(circle_at_85%_10%,rgba(129,140,248,0.22),transparent_26rem)]" />
      <section className="relative mx-auto w-full max-w-md self-center rounded-[2rem] border border-white/10 bg-white p-6 text-slate-950 shadow-2xl shadow-cyan-950/40 sm:p-8">
        <div className="text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-950 text-cyan-200 shadow-lg shadow-slate-300">
            <Shield className="h-7 w-7" />
          </div>
          <h1 className="mt-5 text-3xl font-black tracking-tight">Email verification</h1>
          <p className="mt-2 text-sm text-slate-500">
            Confirm your address before accessing certificate alerts.
          </p>
        </div>

        <div
          className={`mt-8 flex items-start gap-2 rounded-2xl border p-3 text-sm ${
            status === "error"
              ? "border-rose-200 bg-rose-50 text-rose-700"
              : "border-emerald-200 bg-emerald-50 text-emerald-700"
          }`}
        >
          {status === "verifying" ? (
            <RefreshCw className="mt-0.5 h-4 w-4 flex-none animate-spin" />
          ) : status === "error" ? (
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" />
          ) : isPositive ? (
            <CheckCircle2 className="mt-0.5 h-4 w-4 flex-none" />
          ) : (
            <Mail className="mt-0.5 h-4 w-4 flex-none" />
          )}
          <span>{message}</span>
        </div>

        {devVerificationUrl ? (
          <a
            href={devVerificationUrl}
            className="mt-3 block rounded-2xl border border-cyan-200 bg-cyan-50 p-3 text-sm font-bold text-cyan-800 underline underline-offset-4"
          >
            Open development verification link
          </a>
        ) : null}

        {status !== "verifying" && status !== "verified" ? (
          <form onSubmit={handleResend} className="mt-6 space-y-4">
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
                  onChange={(event) => setEmail(event.target.value)}
                  className="h-12 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-slate-400"
                  placeholder="you@example.com"
                />
              </div>
            </label>
            <button
              type="submit"
              disabled={resendLoading}
              className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-slate-950 text-sm font-black text-white shadow-lg shadow-slate-300 transition hover:bg-slate-800 disabled:opacity-50"
            >
              {resendLoading ? "Sending..." : "Send verification link"}
              <ArrowRight className="h-4 w-4" />
            </button>
          </form>
        ) : null}

        <p className="mt-6 text-center text-sm text-slate-500">
          Already verified?{" "}
          <Link
            to="/login"
            className="font-black text-slate-950 underline decoration-cyan-300 decoration-2 underline-offset-4"
          >
            Sign in
          </Link>
        </p>
      </section>
    </div>
  );
}
