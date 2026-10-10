import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import type { IpCertificateResult } from "@shared/types/certificates";
import { formatDate, formatRelativeDate, getExpiryColor } from "@/lib/utils";

interface Props {
  results: IpCertificateResult[];
  earliestIp: string | null;
  domain: string;
  needsAttention: boolean;
}

export function IpCertificatesBadge({ results, earliestIp, domain, needsAttention }: Props) {
  const id = useId();
  const anchorRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const failedCount = results.filter((result) => result.error).length;
  const countLabel = `${results.length} ${results.length === 1 ? "IP" : "IPs"}`;
  const summary = failedCount ? `${failedCount} failed` : "All checked";
  const sortedResults = [...results].sort(
    (a, b) =>
      Number(!!b.error) - Number(!!a.error) ||
      (a.expiresAt ? new Date(a.expiresAt).getTime() : Infinity) -
        (b.expiresAt ? new Date(b.expiresAt).getTime() : Infinity) ||
      a.ip.localeCompare(b.ip),
  );

  const show = () => {
    clearTimeout(closeTimer.current);
    setOpen(true);
  };
  const scheduleClose = () => {
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => {
      if (document.activeElement !== anchorRef.current) setOpen(false);
    }, 120);
  };
  const positionPopover = useCallback(() => {
    const anchor = anchorRef.current;
    const popover = popoverRef.current;
    if (!anchor || !popover) return;
    const margin = 12;
    const width = Math.min(400, window.innerWidth - margin * 2);
    popover.style.width = `${width}px`;
    const rect = anchor.getBoundingClientRect();
    const gap = 8;
    const height = popover.scrollHeight + 2;
    const spaceBelow = Math.max(0, window.innerHeight - rect.bottom - gap - margin);
    const spaceAbove = Math.max(0, rect.top - gap - margin);
    const placeBelow = height <= spaceBelow || spaceBelow >= spaceAbove;
    // Long lists scroll on the roomier side without covering the trigger. Covering
    // it can immediately reopen a dismissed tooltip under the stationary pointer.
    popover.style.maxHeight = `${Math.min(window.innerHeight - margin * 2, placeBelow ? spaceBelow : spaceAbove)}px`;
    const top = placeBelow ? rect.bottom + gap : rect.top - popover.offsetHeight - gap;
    popover.style.top = `${Math.max(margin, Math.min(top, window.innerHeight - popover.offsetHeight - margin))}px`;
    popover.style.left = `${Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin))}px`;
    popover.style.visibility = "visible";
  }, []);

  useLayoutEffect(() => {
    if (open) positionPopover();
  }, [open, results, positionPopover]);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (
        !anchorRef.current?.contains(event.target as Node) &&
        !popoverRef.current?.contains(event.target as Node)
      )
        setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("resize", positionPopover);
    window.addEventListener("scroll", positionPopover, true);
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("resize", positionPopover);
      window.removeEventListener("scroll", positionPopover, true);
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, [open, positionPopover]);
  useEffect(() => () => clearTimeout(closeTimer.current), []);

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        aria-label={`${countLabel}: ${summary}. Show certificate details for ${domain}`}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onMouseEnter={show}
        onMouseLeave={scheduleClose}
        onFocus={show}
        onBlur={scheduleClose}
        onClick={show}
        className={`inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-md border px-2 text-[11px] font-bold transition-colors ${
          needsAttention
            ? "border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100"
            : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
        }`}
      >
        <span
          className={`h-1.5 w-1.5 rounded-full ${needsAttention ? "bg-rose-500" : "bg-emerald-500"}`}
        />
        {countLabel}
      </button>
      {open
        ? createPortal(
            <div
              ref={popoverRef}
              id={id}
              role="tooltip"
              onMouseEnter={show}
              onMouseLeave={scheduleClose}
              style={{ visibility: "hidden", maxHeight: "calc(100dvh - 24px)" }}
              className="fixed z-[100] overflow-y-auto rounded-lg border border-slate-200 bg-white text-left shadow-xl"
            >
              <div className="sticky top-0 border-b border-slate-100 bg-slate-50 px-3 py-2">
                <div className="flex items-center justify-between gap-3 text-xs font-semibold">
                  <span className="text-slate-700">Certificates by IP</span>
                  <span className={failedCount ? "text-rose-700" : "text-slate-500"}>
                    {summary}
                  </span>
                </div>
                <p className="mt-1 break-all text-xs text-slate-500">{domain}</p>
              </div>
              <div className="divide-y divide-slate-100 px-3">
                {sortedResults.map((result) => (
                  <div key={result.ip} className="py-2.5 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex min-w-0 items-center gap-1.5 font-mono font-semibold text-slate-700">
                        {result.error ? (
                          <AlertTriangle className="h-3.5 w-3.5 flex-none text-rose-600" />
                        ) : (
                          <CheckCircle2
                            className={`h-3.5 w-3.5 flex-none ${getExpiryColor(result.expiresAt)}`}
                          />
                        )}
                        <span className="break-all">{result.ip}</span>
                      </span>
                      {result.ip === earliestIp ? (
                        <span className="flex-none font-semibold text-amber-700">
                          Earliest expiry
                        </span>
                      ) : null}
                    </div>
                    {result.expiresAt ? (
                      <div className="mt-1 pl-5">
                        <p className={getExpiryColor(result.expiresAt)}>
                          {formatRelativeDate(result.expiresAt)}
                        </p>
                        <p className="mt-0.5 text-slate-500">{formatDate(result.expiresAt)}</p>
                        <p className="mt-0.5 break-words text-slate-600">
                          {result.issuer || "Unknown issuer"}
                        </p>
                      </div>
                    ) : null}
                    {result.error ? (
                      <p className="mt-1 break-words pl-5 leading-4 text-rose-600">
                        {result.error}
                      </p>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
