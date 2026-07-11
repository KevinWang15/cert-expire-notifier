export const MAX_USER_NAME_LENGTH = 120;
export const MAX_DOMAIN_LENGTH = 253;
export const MAX_NOTES_LENGTH = 10000;

export function normalizeName(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, MAX_USER_NAME_LENGTH) : null;
}

export function normalizeNotes(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized ? normalized.slice(0, MAX_NOTES_LENGTH) : null;
}

export function parseStrictPositiveInt(rawId: string | string[] | undefined): number | null {
  const id = Array.isArray(rawId) ? rawId[0] : rawId;
  if (!id || !/^\d+$/.test(id)) {
    return null;
  }

  const parsed = Number.parseInt(id, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
