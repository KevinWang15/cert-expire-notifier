import https from "https";
import tls from "tls";
import net, { isIP } from "net";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksClient } from "socks";
import type { CertificateResult } from "@shared/types/certificates";
import { DEFAULT_CERT_PORT } from "../utils/domain";

export const CERT_CHECK_TIMEOUT_MS = 10000;

export interface CertificateTarget {
  hostname: string;
  address: string;
  port: number;
}

function readCertificate(socket: tls.TLSSocket): CertificateResult<Date> {
  const cert = socket.getPeerCertificate();
  if (!cert?.valid_to) {
    return { expiresAt: null, issuer: null, error: "No certificate found" };
  }
  const expiresAt = new Date(cert.valid_to);
  if (Number.isNaN(expiresAt.getTime())) {
    return { expiresAt: null, issuer: null, error: "Invalid certificate expiry" };
  }
  return {
    expiresAt,
    issuer: cert.issuer
      ? [cert.issuer.O, cert.issuer.CN].filter(Boolean).join(" - ") || null
      : null,
    error: null,
  };
}

/** The destination is always an IP, including through proxies; SNI remains the domain. */
export function probeCertificate(
  target: CertificateTarget,
  proxyUrl?: string,
  signal?: AbortSignal,
): Promise<CertificateResult<Date>> {
  return new Promise((resolve) => {
    let settled = false;
    let socket: tls.TLSSocket | undefined;
    let transport: net.Socket | undefined;
    let request: ReturnType<typeof https.request> | undefined;
    let agent: HttpsProxyAgent<string> | undefined;
    const controller = new AbortController();

    const done = (result: CertificateResult<Date>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      // Before assignment, only the agent owns the connection. Once wrapped in
      // TLS, close the TLS socket rather than aborting its underlying transport.
      if (!socket) {
        controller.abort();
        transport?.destroy();
      }
      socket?.destroy();
      request?.destroy();
      agent?.destroy();
      resolve(result);
    };
    const fail = (error: unknown) =>
      done({
        expiresAt: null,
        issuer: null,
        error: error instanceof Error ? error.message : "Certificate check failed",
      });
    const onAbort = () => fail(new Error("Certificate check cancelled"));
    const timeout = setTimeout(() => fail(new Error("Connection timeout")), CERT_CHECK_TIMEOUT_MS);
    const read = (connected: tls.TLSSocket) => {
      try {
        done(readCertificate(connected));
      } catch (error) {
        fail(error);
      }
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      // Do not send an IP literal as SNI when monitoring a literal IPv4 target.
      const servername = isIP(target.hostname) ? undefined : target.hostname;
      const connectTls = (tunnel?: net.Socket) => {
        if (settled) {
          tunnel?.destroy();
          return;
        }
        socket = tls.connect(
          {
            ...(tunnel ? { socket: tunnel } : { host: target.address, port: target.port }),
            servername,
            rejectUnauthorized: false,
          },
          () => read(socket!),
        );
        socket.on("error", fail);
        socket.on("close", () =>
          fail(new Error("Connection closed before receiving a certificate")),
        );
      };
      if (!proxyUrl) {
        connectTls();
        return;
      }

      const proxy = new URL(proxyUrl);
      if (proxy.protocol.startsWith("socks")) {
        const host = proxy.hostname.replace(/^\[|\]$/g, "");
        const port = Number(proxy.port) || 1080;
        const userId = decodeURIComponent(proxy.username);
        const password = decodeURIComponent(proxy.password);
        // Own the TCP socket before negotiation so cancellation can close it.
        // SOCKS agents do not expose their socket until negotiation finishes.
        transport = net.connect({ host, port });
        transport.on("error", fail);
        transport.on("close", () => fail(new Error("SOCKS connection closed")));
        transport.once("connect", () => {
          SocksClient.createConnection({
            command: "connect",
            proxy: {
              host,
              port,
              type: proxy.protocol.startsWith("socks4") ? 4 : 5,
              userId,
              password,
            },
            destination: { host: target.address, port: target.port },
            existing_socket: transport,
            timeout: CERT_CHECK_TIMEOUT_MS,
          })
            .then(({ socket }) => connectTls(socket))
            .catch(fail);
        });
        return;
      }

      agent = new HttpsProxyAgent(proxy, {
        timeout: CERT_CHECK_TIMEOUT_MS,
        signal: controller.signal,
      });
      request = https.request({
        host: target.address,
        port: target.port,
        path: "/",
        method: "HEAD",
        agent,
        rejectUnauthorized: false,
        servername,
        headers: {
          Host:
            target.port === DEFAULT_CERT_PORT
              ? target.hostname
              : `${target.hostname}:${target.port}`,
        },
      });
      request.on("socket", (connected) => {
        if (settled) {
          connected.destroy();
          return;
        }
        if (!(connected instanceof tls.TLSSocket)) {
          fail(new Error("Proxy did not expose a TLS socket"));
          return;
        }
        socket = connected;
        socket.on("error", fail);
        socket.on("close", () =>
          fail(new Error("Connection closed before receiving a certificate")),
        );
        // Each probe owns a fresh agent/socket. Read only after its TLS handshake,
        // when OpenSSL has finished populating the peer certificate.
        socket.once("secureConnect", () => read(connected));
      });
      request.on("error", fail);
      request.end();
    } catch (error) {
      fail(error);
    }
  });
}
