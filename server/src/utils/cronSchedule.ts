interface CronField {
  values: Set<number>;
  restricted: boolean;
}

interface ParsedCronExpression {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
}

const MONTH_ALIASES: Record<string, number> = {
  JAN: 1,
  FEB: 2,
  MAR: 3,
  APR: 4,
  MAY: 5,
  JUN: 6,
  JUL: 7,
  AUG: 8,
  SEP: 9,
  OCT: 10,
  NOV: 11,
  DEC: 12,
};

const DAY_ALIASES: Record<string, number> = {
  SUN: 0,
  MON: 1,
  TUE: 2,
  WED: 3,
  THU: 4,
  FRI: 5,
  SAT: 6,
};

function allValues(
  min: number,
  max: number,
  normalize: (value: number) => number = (value) => value,
) {
  const values = new Set<number>();
  for (let value = min; value <= max; value += 1) {
    values.add(normalize(value));
  }
  return values;
}

function parseCronValue(
  rawValue: string,
  min: number,
  max: number,
  aliases: Record<string, number>,
): number {
  const upper = rawValue.toUpperCase();
  const aliased = aliases[upper];
  const parsed = aliased ?? Number.parseInt(rawValue, 10);

  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Invalid cron value: ${rawValue}`);
  }

  return parsed;
}

function parseCronField(
  field: string,
  min: number,
  max: number,
  aliases: Record<string, number> = {},
  normalize: (value: number) => number = (value) => value,
): CronField {
  const trimmed = field.trim();
  const unrestricted = trimmed === "*" || trimmed === "?";

  if (unrestricted) {
    return { values: allValues(min, max, normalize), restricted: false };
  }

  const values = new Set<number>();

  for (const part of trimmed.split(",")) {
    const [rangePart, stepPart] = part.split("/");
    const step = stepPart ? Number.parseInt(stepPart, 10) : 1;

    if (!Number.isInteger(step) || step < 1) {
      throw new Error(`Invalid cron step: ${part}`);
    }

    let start: number;
    let end: number;

    if (rangePart === "*" || rangePart === "?") {
      start = min;
      end = max;
    } else if (rangePart.includes("-")) {
      const [rawStart, rawEnd] = rangePart.split("-");
      start = parseCronValue(rawStart, min, max, aliases);
      end = parseCronValue(rawEnd, min, max, aliases);
    } else {
      start = parseCronValue(rangePart, min, max, aliases);
      end = start;
    }

    if (start > end) {
      throw new Error(`Invalid cron range: ${part}`);
    }

    for (let value = start; value <= end; value += step) {
      values.add(normalize(value));
    }
  }

  if (values.size === 0) {
    throw new Error(`Invalid cron field: ${field}`);
  }

  return { values, restricted: true };
}

function parseCronExpression(expression: string): ParsedCronExpression | null {
  const fields = expression.trim().split(/\s+/);
  const normalizedFields = fields.length === 6 ? fields.slice(1) : fields;

  if (normalizedFields.length !== 5) {
    return null;
  }

  try {
    return {
      minute: parseCronField(normalizedFields[0], 0, 59),
      hour: parseCronField(normalizedFields[1], 0, 23),
      dayOfMonth: parseCronField(normalizedFields[2], 1, 31),
      month: parseCronField(normalizedFields[3], 1, 12, MONTH_ALIASES),
      dayOfWeek: parseCronField(normalizedFields[4], 0, 7, DAY_ALIASES, (value) =>
        value === 7 ? 0 : value,
      ),
    };
  } catch {
    return null;
  }
}

function cronMatches(date: Date, expression: ParsedCronExpression): boolean {
  const dayOfMonthMatches = expression.dayOfMonth.values.has(date.getDate());
  const dayOfWeekMatches = expression.dayOfWeek.values.has(date.getDay());
  const dayMatches =
    expression.dayOfMonth.restricted && expression.dayOfWeek.restricted
      ? dayOfMonthMatches || dayOfWeekMatches
      : dayOfMonthMatches && dayOfWeekMatches;

  return (
    expression.minute.values.has(date.getMinutes()) &&
    expression.hour.values.has(date.getHours()) &&
    dayMatches &&
    expression.month.values.has(date.getMonth() + 1)
  );
}

export function getNextCronRun(expression: string, from = new Date()): Date | null {
  const parsed = parseCronExpression(expression);

  if (!parsed) {
    return null;
  }

  const candidate = new Date(from.getTime());
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  const maxMinutesToScan = 370 * 24 * 60;
  for (let offset = 0; offset < maxMinutesToScan; offset += 1) {
    if (cronMatches(candidate, parsed)) {
      return new Date(candidate.getTime());
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  return null;
}
