// The student calendar follows VILNIUS TECH's Europe/Vilnius dates.
// Filtering by calendar day, not by timestamp, retains all of today's events,
// including a class or deadline whose start time has already passed.
import { TZ } from './lecture-events.js';

const dayFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'
});
export function calendarDay(instant = new Date()) {
  const d = instant instanceof Date ? instant : new Date(instant);
  if (!Number.isFinite(d.getTime())) return null;
  const parts = Object.fromEntries(dayFormatter.formatToParts(d).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
export function visibleCalendarItems(items, { now = new Date(), showPast = false } = {}) {
  if (showPast) return items;
  const today = calendarDay(now);
  return items.filter(item => {
    const day = calendarDay(item.at);
    return day !== null && day >= today;
  });
}
