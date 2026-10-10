import prisma from "../prisma";
import { checkCertForDomainWithRetries } from "./certChecker";

export async function updateDomainCertificateState(id: number, domainName: string) {
  const result = await checkCertForDomainWithRetries(domainName);
  return prisma.domain.update({
    where: { id },
    // Replace the snapshot and its summary atomically, including partial/total failures.
    data: {
      lastCheckedAt: new Date(),
      certExpiresAt: result.expiresAt,
      certIssuer: result.issuer,
      certIp: result.ip,
      certError: result.error,
      lastIpResults: result.ipResults.map((entry) => ({
        ...entry,
        expiresAt: entry.expiresAt?.toISOString() ?? null,
      })),
    },
  });
}
