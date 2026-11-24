// Timetable occurrence engine. Exact-date sessions and explicitly bounded weekly
// PDF patterns can appear; PDF recurrences are clearly marked as estimates.
// Alternating-week patterns without anchors are never projected.
export const TZ = 'Europe/Vilnius';
const MS_DAY = 86400000;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export function validDate(date) {
  if (!ISO_DAY.test(String(date || ''))) return false;
  const d = new Date(`${date}T12:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === date;
}
export function isoDay(date) { return new Date(date).toISOString().slice(0,10); }
export function weekdayIndex(date) {
  if (!validDate(date)) return -1;
  return (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;
}
export function addDays(date, days) {
  if (!validDate(date)) return '';
  return isoDay(new Date(Date.parse(`${date}T12:00:00Z`) + days * MS_DAY));
}
export function vilniusInstant(date, time) {
  if (!validDate(date) || !ISO_TIME.test(String(time || ''))) return null;
  // Wall time -> UTC using time-zone parts. The second iteration covers DST boundaries.
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const wanted = Date.UTC(year, month - 1, day, hour, minute);
  let guess = wanted;
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  });
  for (let i=0;i<3;i++) {
    const map = Object.fromEntries(fmt.formatToParts(new Date(guess)).map(x=>[x.type,x.value]));
    const got = Date.UTC(Number(map.year), Number(map.month)-1, Number(map.day), Number(map.hour), Number(map.minute));
    if (got === wanted) return new Date(guess).toISOString();
    guess += wanted - got;
  }
  // During the spring DST gap (invalid local wall time), do not fabricate an instant.
  return null;
}
export function occurrenceId(c, date) {
  return `${String(c.courseId)}:${date}:${c.start}:${c.room || ''}:${c.source || ''}`;
}
export function classOccurrences(classes=[], { from=null, to=null, limit=500 }={}) {
  const result = new Map();
  const min = validDate(from) ? from : null;
  const max = validDate(to) ? to : null;
  const put = (c, date) => {
    if (!validDate(date) || (min && date < min) || (max && date > max)) return;
    if (weekdayIndex(date) !== Number(c.day) || !ISO_TIME.test(String(c.start||''))) return;
    const at = vilniusInstant(date, c.start);
    if (!at) return;
    const estimated = c.repeat === 'weekly' && ['pdf','mano'].includes(c.source);
    const instance = {...c, date, at, projected: estimated, confirmed: !estimated};
    result.set(occurrenceId(c,date), instance);
  };
  for(const c of classes) {
    if (result.size >= limit) break;
    if (validDate(c.date)) { put(c,c.date); continue; }
    // Recurring classes must be explicitly configured with a bounded first/last date.
    if (!['manual','pdf','mano'].includes(c.source) || !['weekly','biweekly'].includes(c.repeat) ||
      !validDate(c.firstDate) || !validDate(c.untilDate) || c.untilDate < c.firstDate) continue;
    const cap = Math.min(365, Math.floor((Date.parse(`${c.untilDate}T12:00:00Z`) - Date.parse(`${c.firstDate}T12:00:00Z`))/MS_DAY));
    for(let offset=0; offset<=cap && result.size<limit; offset+=c.repeat==='biweekly'?14:7) put(c,addDays(c.firstDate, offset));
  }
  return [...result.values()].sort((a,b)=>a.at.localeCompare(b.at) || a.courseName.localeCompare(b.courseName));
}
export function nextClass(classes=[], courseId=null, now=new Date()) {
  const from=isoDay(new Date(now.getTime()-MS_DAY));
  const through=isoDay(new Date(now.getTime()+367*MS_DAY));
  return classOccurrences(classes,{from,to:through,limit:2000}).find(c=>
    (!courseId || String(c.courseId)===String(courseId)) && Date.parse(c.at)>=now.getTime()) || null;
}
export function todayClasses(classes=[], now=new Date()) {
  const day=new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
  return classOccurrences(classes,{from:day,to:day});
}
