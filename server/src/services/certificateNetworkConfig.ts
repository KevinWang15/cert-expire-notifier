/** IPv6 certificate checks require an explicit opt-in. */
export function isCertCheckIpv4Only(): boolean {
  return process.env.CERT_CHECK_IPV4_ONLY?.trim().toLowerCase() !== "false";
}
