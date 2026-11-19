/**
 * Job interval values, matching PolyAPI's own parser (R35).
 *
 * A bare number or numeric string means whole minutes. A string with a unit
 * suffix is a duration: "10s", "30m", "2h". The API rejects intervals shorter
 * than 10 seconds and returns whole minutes as a number and anything else as a
 * duration string (for example `"90s"`), so values are compared in seconds.
 */

export const MIN_JOB_INTERVAL_SECONDS = 10;
const MAX_JOB_INTERVAL_SECONDS = 2_147_483_647;
const SECONDS_PER_UNIT: Record<string, number> = { s: 1, m: 60, h: 3600 };
const DURATION_PATTERN = /^(\d+)\s*([smh])$/i;
const WHOLE_NUMBER_PATTERN = /^\d+$/;

/** Whole seconds for a valid interval value, otherwise null. */
export function parseJobIntervalToSeconds(value: unknown): number | null {
  let seconds: number;

  if (typeof value === 'number') {
    if (!Number.isInteger(value)) return null;
    seconds = value * SECONDS_PER_UNIT.m;
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (WHOLE_NUMBER_PATTERN.test(trimmed)) {
      seconds = Number(trimmed) * SECONDS_PER_UNIT.m;
    } else {
      const match = DURATION_PATTERN.exec(trimmed);
      if (!match) return null;
      seconds = Number(match[1]) * SECONDS_PER_UNIT[match[2].toLowerCase()];
    }
  } else {
    return null;
  }

  if (
    !Number.isSafeInteger(seconds) ||
    seconds <= 0 ||
    seconds > MAX_JOB_INTERVAL_SECONDS
  ) {
    return null;
  }
  return seconds;
}

/**
 * A readable problem with an interval value, or null when it is valid.
 */
export function describeJobIntervalProblem(value: unknown): string | null {
  const seconds = parseJobIntervalToSeconds(value);
  if (seconds === null) {
    return `Interval ${JSON.stringify(value)} is not valid. Use whole minutes (for example 5 or "5") or a duration such as "30s", "15m" or "2h".`;
  }
  if (seconds < MIN_JOB_INTERVAL_SECONDS) {
    return `Interval ${JSON.stringify(value)} is ${seconds} second${seconds === 1 ? '' : 's'}; PolyAPI jobs cannot repeat more often than every ${MIN_JOB_INTERVAL_SECONDS} seconds.`;
  }
  return null;
}
