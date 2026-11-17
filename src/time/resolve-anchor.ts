export interface TemporalInterval {
  localStart: string;
  localEndExclusive: string;
  startUtc: string;
  endUtcExclusive: string;
  startMs: number;
  endMsExclusive: number;
}

export interface ResolvedAnchor {
  rawText: string;
  timeZone: string;
  kind: "explicit_day_month" | "relative_weekday" | "today";
  primary: TemporalInterval;
  alternatives: TemporalInterval[];
  policy: string;
  resolverVersion: string;
  ambiguous: boolean;
  disclosure: string | null;
  comparisonBoundary: "local_midnight" | "episode_timestamp";
}

const RESOLVER_VERSION = "1";
const weekdays = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const monthNames = months.flatMap((month) => [month, month.slice(0, 3)]).join("|");

export function localDateAt(timestamp: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(timestamp);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const value = new Date(Date.UTC(year, month - 1, day + days));
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}-${String(value.getUTCDate()).padStart(2, "0")}`;
}

function startOfLocalDate(date: string, timeZone: string): number {
  const [year, month, day] = date.split("-").map(Number);
  let low = Date.UTC(year, month - 1, day) - 48 * 60 * 60 * 1000;
  let high = Date.UTC(year, month - 1, day) + 48 * 60 * 60 * 1000;
  if (localDateAt(low, timeZone) >= date || localDateAt(high, timeZone) < date) {
    throw new RangeError(`Cannot resolve local date ${date} in ${timeZone}`);
  }
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (localDateAt(middle, timeZone) >= date) high = middle;
    else low = middle;
  }
  return high;
}

export function intervalForLocalDate(date: string, timeZone: string): TemporalInterval {
  const startMs = startOfLocalDate(date, timeZone);
  const localEndExclusive = addDays(date, 1);
  const endMsExclusive = startOfLocalDate(localEndExclusive, timeZone);
  return {
    localStart: date,
    localEndExclusive,
    startUtc: new Date(startMs).toISOString(),
    endUtcExclusive: new Date(endMsExclusive).toISOString(),
    startMs,
    endMsExclusive,
  };
}

function dateAt(referenceMs: number, timeZone: string): string {
  return localDateAt(referenceMs, timeZone);
}

function dayOfWeek(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function parseMention(text: string, referenceDate: string, weekStartsOn: 1 | 7): { date: string; kind: ResolvedAnchor["kind"]; rawText: string; policy: string; alternatives?: string[] } | null {
  const lastWeekday = new RegExp(`\\blast\\s+(${weekdays.join("|")})\\b`, "i").exec(text);
  const mention = lastWeekday ?? new RegExp(`\\b(?:on\\s+)?(${weekdays.join("|")})\\b`, "i").exec(text);
  if (mention) {
    const weekday = weekdays.indexOf(mention[1].toLowerCase());
    const currentWeekday = dayOfWeek(referenceDate);
    if (lastWeekday) {
      const weekStartDay = weekStartsOn === 7 ? 0 : 1;
      const weekStart = (currentWeekday - weekStartDay + 7) % 7;
      const targetOffset = (weekday - weekStartDay + 7) % 7;
      const daysBack = weekStart + 7 - targetOffset;
      return {
        date: addDays(referenceDate, -daysBack),
        kind: "relative_weekday",
        rawText: mention[0],
        policy: "last weekday means that weekday in the previous Monday-based calendar week",
      };
    }
    const daysBack = (currentWeekday - weekday + 7) % 7;
    const alternatives = daysBack === 0 ? [addDays(referenceDate, -7)] : [];
    return {
      date: addDays(referenceDate, -daysBack),
      kind: "relative_weekday",
      rawText: mention[0],
      policy: "bare weekday means the most recent matching local day, including today",
      alternatives,
    };
  }

  const today = /\btoday\b/i.exec(text);
  if (today) return { date: referenceDate, kind: "today", rawText: today[0], policy: "today means the request's local calendar day" };

  const datePattern = new RegExp(`\\b(?:(\\d{1,2})\\s+(${monthNames})|(${monthNames})\\s+(\\d{1,2}))(?:,?\\s+(\\d{4}))?\\b`, "i");
  const dateMention = datePattern.exec(text);
  if (!dateMention) return null;
  const day = Number(dateMention[1] ?? dateMention[4]);
  const monthText = (dateMention[2] ?? dateMention[3]).toLowerCase().slice(0, 3);
  const month = months.findIndex((value) => value.slice(0, 3) === monthText) + 1;
  let year = dateMention[5] ? Number(dateMention[5]) : Number(referenceDate.slice(0, 4));
  let date = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() + 1 !== month || parsed.getUTCDate() !== day) return null;
  if (!dateMention[5] && date > referenceDate) {
    year -= 1;
    date = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  return {
    date,
    kind: "explicit_day_month",
    rawText: dateMention[0],
    policy: dateMention[5] ? "explicit calendar date" : "yearless date means the most recent occurrence not later than the request's local date",
  };
}

export function resolveAnchor(
  text: string,
  requestAt: Date | string,
  timeZone: string,
  weekStartsOn: 1 | 7 = 1,
): ResolvedAnchor | null {
  const referenceMs = requestAt instanceof Date ? requestAt.getTime() : new Date(requestAt).getTime();
  if (!Number.isFinite(referenceMs)) throw new TypeError("requestAt must be a valid date");
  const referenceDate = dateAt(referenceMs, timeZone);
  const match = parseMention(text, referenceDate, weekStartsOn);
  if (!match) return null;

  const alternatives = (match.alternatives ?? []).map((date) => intervalForLocalDate(date, timeZone));
  const since = /\bsince\b/i.test(text);
  return {
    rawText: since ? `since ${match.rawText}` : match.rawText,
    timeZone,
    kind: match.kind,
    primary: intervalForLocalDate(match.date, timeZone),
    alternatives,
    policy: match.policy,
    resolverVersion: RESOLVER_VERSION,
    ambiguous: alternatives.length > 0,
    disclosure: alternatives.length ? `This could also mean ${alternatives.map((value) => value.localStart).join(" or ")}.` : null,
    comparisonBoundary: since ? "episode_timestamp" : "local_midnight",
  };
}

export function comparisonStartMs(anchor: ResolvedAnchor, episodeTimestampMs: number): number {
  return anchor.comparisonBoundary === "episode_timestamp" ? episodeTimestampMs : anchor.primary.startMs;
}
