export interface CertificateResult<TDate = string> {
  expiresAt: TDate | null;
  issuer: string | null;
  error: string | null;
}

/** One address from the latest check; dates are ISO strings in storage and the API. */
export interface IpCertificateResult<TDate = string> extends CertificateResult<TDate> {
  ip: string;
}
