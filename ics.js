/**
 * Minimal standards-aware iCalendar reader, compatible with Moodle's VCALENDAR exports.
 * No external dependencies. No calendar keys leave the device.
 */
function unescapeICS(value) {
  return String(value ?? '')
    .replace(/\\n/gi, '\n')
    .replace(/\\([,;\\])/g, '$1');
}

export function parseIcsDate(value, params = {}) {
  if (!value) return null;
  const clean = String(value).trim();
  const match = clean.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/i);
  if (!match) return null;
  const [, year, month, day, hour = '00', minute = '00', second = '00', z] = match;
  if (!match[4]) return `${year}-${month}-${day}T00:00:00.000Z`;
  if (z) return new Date(Date.UTC(+year, +month - 1, +day, +hour, +minute, +second)).toISOString();
  // Moodle export uses UTC Z values. For occasional non-UTC timestamps, use the
  // supplied TZID via Intl instead of silently treating them as UTC.
  const tz = params.TZID;
  if (tz) {
    try {
      const requested = Date.UTC(+year, +month - 1, +day, +hour, +minute, +second);
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
      }).formatToParts(new Date(requested));
      const get = type => Number(parts.find(part => part.type === type)?.value);
      const formatted = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
      return new Date(requested - (formatted - requested)).toISOString();
    } catch { /* Unknown TZID: interpret as browser-local time. */ }
  }
  return new Date(+year, +month - 1, +day, +hour, +minute, +second).toISOString();
}

export function classifyEvent(summary) {
  const title = (summary || '').toLowerCase();
  if (/\b(attendance|lecture attendance|practical attendance|presence)\b|lankomum/i.test(title)) return 'attendance';
  if (/\b(exam|mid[ -]?term|quiz|test|retake|assessment)\b/i.test(title)) return 'exam';
  if (/\b(submit|submission|upload|assignment|homework|coursework|lab\s*\d|practical work|report|project milestone)\b|turi būti pateikta|atsiskaity/i.test(title)) return 'assignment';
  return 'other';
}

export function parseICS(icsText) {
  const text = String(icsText ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('This is not a valid Moodle iCalendar (.ics) export.');
  const lines = [];
  for (const line of text.split('\n')) {
    if (/^[ \t]/.test(line) && lines.length) lines[lines.length - 1] += line.slice(1);
    else lines.push(line);
  }
  const events = [];
  let item = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { item = {}; continue; }
    if (line === 'END:VEVENT') {
      if (item) {
        const summary = unescapeICS(item.SUMMARY?.value || 'Untitled event').trim();
        const start = parseIcsDate(item.DTSTART?.value, item.DTSTART?.params);
        const end = parseIcsDate(item.DTEND?.value, item.DTEND?.params);
        if (start) {
          const category = unescapeICS(item.CATEGORIES?.value || '');
          const code = category.match(/\b[A-Z]{3,8}\d{4,7}\b/)?.[0] || '';
          const url = item.URL?.value || '';
          events.push({
            id: item.UID?.value || `calendar-${events.length}-${start}`,
            name: summary, kind: classifyEvent(summary), due: start,
            end: end || null, courseCode: code, description: unescapeICS(item.DESCRIPTION?.value || ''),
            url: /^https:\/\/moodle\.vilniustech\.lt\//.test(url) ? url : '',
            updated: parseIcsDate(item['LAST-MODIFIED']?.value) || null
          });
        }
      }
      item = null; continue;
    }
    if (!item || !line.includes(':')) continue;
    const sep = line.indexOf(':');
    const head = line.slice(0, sep), value = line.slice(sep + 1);
    const [key, ...options] = head.split(';');
    const params = {};
    for (const option of options) {
      const equals = option.indexOf('=');
      if (equals !== -1) params[option.slice(0, equals).toUpperCase()] = option.slice(equals + 1).replace(/^"|"$/g, '');
    }
    item[key.toUpperCase()] = { value, params };
  }
  if (!events.length) throw new Error('The calendar is valid but contains no events in the selected date range.');
  return events.sort((a, b) => a.due.localeCompare(b.due));
}

export function validateCalendarUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('Paste the full Moodle calendar subscription URL.'); }
  if (url.protocol !== 'https:' || url.hostname !== 'moodle.vilniustech.lt' || url.pathname !== '/calendar/export_execute.php') {
    throw new Error('Only VILNIUS TECH Moodle calendar export URLs are supported.');
  }
  if (!url.searchParams.has('authtoken')) throw new Error('The calendar URL is missing its subscription key.');
  return url.toString();
}
