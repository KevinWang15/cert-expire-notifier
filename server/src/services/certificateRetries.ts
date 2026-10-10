import { setTimeout as wait } from "node:timers/promises";
import type { CertificateResult } from "@shared/types/certificates";
import { probeCertificate, type CertificateTarget } from "./certificateProbe";

const RETRY_INTERVAL_MS = 10000;

function succeeded(result: CertificateResult<Date>): boolean {
  return !result.error && result.expiresAt !== null;
}

async function retryRoute(
  target: CertificateTarget,
  proxyUrl: string | undefined,
  attempts: number,
  signal: AbortSignal,
  initialResult: CertificateResult<Date>,
): Promise<CertificateResult<Date>> {
  let result = initialResult;
  for (let attempt = 0; attempt < attempts && !signal.aborted; attempt += 1) {
    result = await probeCertificate(target, proxyUrl, signal);
    if (succeeded(result) || signal.aborted) return result;
    if (attempt < attempts - 1) {
      try {
        await wait(RETRY_INTERVAL_MS, undefined, { signal });
      } catch (error) {
        if (!signal.aborted) throw error;
        return result;
      }
    }
  }
  return result;
}

/** One fast direct check, then independent direct/proxy recovery for this IP. */
export async function checkCertificateWithRetries(
  target: CertificateTarget,
  proxyUrls: string[],
  attempts: number,
): Promise<CertificateResult<Date>> {
  const initialResult = await probeCertificate(target);
  if (succeeded(initialResult)) return initialResult;

  const routes = [undefined, ...proxyUrls];
  const controller = new AbortController();
  const failures: CertificateResult<Date>[] = [];

  return new Promise((resolve) => {
    let pending = routes.length;
    let settled = false;
    const finish = (result: CertificateResult<Date>) => {
      if (settled) return;
      settled = true;
      // Also cancels sleeping retries and unfinished proxy handshakes.
      controller.abort();
      resolve(result);
    };

    routes.forEach((proxyUrl, index) => {
      retryRoute(target, proxyUrl, attempts, controller.signal, initialResult)
        .then((result) => {
          failures[index] = result;
          if (succeeded(result)) finish(result);
        })
        .catch((error: unknown) => {
          failures[index] = {
            expiresAt: null,
            issuer: null,
            error: error instanceof Error ? error.message : "Certificate check failed",
          };
        })
        .finally(() => {
          pending -= 1;
          if (pending === 0 && !settled) {
            finish({
              expiresAt: null,
              issuer: null,
              error: `All ${routes.length} connection routes failed: ${failures
                .map(
                  (result, route) =>
                    `${route === 0 ? "direct" : `proxy ${route}`} (${result.error || "No certificate expiry"})`,
                )
                .join("; ")}`,
            });
          }
        });
    });
  });
}
