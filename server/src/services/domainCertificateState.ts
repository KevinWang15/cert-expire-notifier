import prisma from "../prisma";
import { checkCertForDomainWithRetries } from "./certChecker";

function certificateCheckError(
  domainName: string,
  result: Awaited<ReturnType<typeof checkCertForDomainWithRetries>>,
) {
  if (result.error) {
    return result.error;
  }

  if (!result.expiresAt) {
    console.warn(
      `[CertChecker] ${domainName} check returned no expiry and no checker error; marking as failed`,
    );
    return "Certificate check returned no expiry";
  }

  return null;
}

export async function updateDomainCertificateState(id: number, domainName: string) {
  const result = await checkCertForDomainWithRetries(domainName);
  const certError = certificateCheckError(domainName, result);

  return prisma.domain.update({
    where: { id },
    data: certError
      ? {
          lastCheckedAt: new Date(),
          certError,
        }
      : {
          lastCheckedAt: new Date(),
          certExpiresAt: result.expiresAt,
          certIssuer: result.issuer || null,
          certError: null,
        },
  });
}
