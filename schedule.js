// Experimental read-only Mano lecture timetable connector.
// The university website is SSO-only; this parser cannot be production-verified
// against the user's live timetable until they run it from their signed-in tab.
import { MANO, normCode, normName } from './mano.js';
const DAYS = [
  ['monday', 'mon', 'pirmadienis', 'pirmadieni', 'pr'],
  ['tuesday', 'tue', 'antradienis', 'antradieni', 'an'],
  ['wednesday', 'wed', 'treciadienis', 'treciadieni', 'tr'],
  ['thursday', 'thu', 'ketvirtadienis', 'ketvirtadieni', 'kt'],
  ['friday', 'fri', 'penktadienis', 'penktadieni', 'pn'],
  ['saturday', 'sat', 'sestadienis', 'sestadieni', 'st'],
  ['sunday', 'sun', 'sekmadienis', 'sekmadieni', 'sk']
];
const OFFICIAL_LESSON_SLOTS = [null, ['08:30','10:05'], ['10:20','11:55'], ['12:10','13:45'], ['14:30','16:05'], ['16:20','17:55'], ['18:10','19:45'], ['19:55','21:30']];
const TIME = /\b([01]?\d|2[0-3]):([0-5]\d)\b/g;
const dateRE = /\b20\d{2}[-./]\d{2}[-./]\d{2}\b/;
const dayIndex = text => {
  const normalized = normName(text);
  for (let i = 0; i < DAYS.length; i++) {
    if (DAYS[i].some(word => new RegExp(`(^| )${word}( |$)`).test(normalized))) return i;
  }
  return -1;
};
export function matchLectureSubject(text, courses = [], events = []) {
  const code = normCode(text);
  const byCode = courses.find(course => code && (normCode(course.code) === code || normCode(course.shortname) === code));
  if (byCode) return { id: byCode.id, code: code, name: byCode.name };
  // A calendar course code is proof of a Moodle subject but provides no friendly course name.
  if (code && events.some(e => normCode(e.courseCode) === code)) return { id: `calendar-${code}`, code, name: code };
  const normalizedText = normName(text);
  const matches = courses.filter(c => {
    const alternatives = String(c.name || '').split(/[/|]/).map(normName);
    return alternatives.some(normalized => normalized.length > 13 && (` ${normalizedText} `.includes(` ${normalized} `)));
  });
  if (matches.length === 1) return { id: matches[0].id, code: matches[0].code || '', name: matches[0].name };
  return null;
}
function getTimes(text) {
  const found = [...String(text).matchAll(TIME)].map(m => `${m[1].padStart(2,'0')}:${m[2]}`);
  return found.length ? { start: found[0], end: found.length > 1 ? found[1] : null } : null;
}
export function parseLectureRows(rows = [], courses = [], events = [], group = '') {
  const timetable = new Map();
  for (const raw of rows) {
    const cells = Array.isArray(raw) ? raw.map(v => String(v || '').replace(/\s+/g, ' ').trim()) : [];
    if (!cells.length) continue;
    const text = cells.join(' · ');
    // If a group is specified, ignore rows explicitly assigned to another group.
    const groupMatch = text.match(/\b[A-Z]{2,6}[- ]?\d{2}\/\d\b/i);
    if (group && groupMatch && groupMatch[0].toLowerCase().replace(/\s/g,'') !== group.toLowerCase().replace(/\s/g,'')) continue;
    const day = cells.map(dayIndex).find(i => i >= 0);
    if (day == null) continue;
    const subject = matchLectureSubject(text, courses, events);
    if (!subject) continue;
    const timeCell = cells.find(v => getTimes(v));
    let time = timeCell ? getTimes(timeCell) : null;
    // If the timetable lists lecture number, use the university's published lecture slots.
    if (!time) {
      const slotMatch = cells.find(v => /^(?:[1-7]|[1-7] (?:paskaita|lecture))$/i.test(v));
      if (slotMatch) {
        const number = Number(slotMatch.match(/[1-7]/)?.[0]);
        if (OFFICIAL_LESSON_SLOTS[number]) time = { start: OFFICIAL_LESSON_SLOTS[number][0], end: OFFICIAL_LESSON_SLOTS[number][1] };
      }
    }
    if (!time) continue;
    // Odd/even week timetables require an explicit displayed qualifier; never assume it occurs every week.
    const weekNote = /\b(odd|even|nelygin|lygin|i\s*sav|ii\s*sav|week\s*[ab])\b/i.test(text) ? 'Check week pattern in Mano' : '';
    const dateText = (text.match(dateRE) || [])[0] || '';
    const date = dateText ? dateText.replace(/[./]/g,'-') : null;
    const room = (text.match(/\b(?:P\d\([^)]*\)|S\d\([^)]*\))\s*[A-Z]?\d{2,4}\b/i) || [])[0] || '';
    const record = { day, start: time.start, end: time.end, date, room, weekNote,
      courseId: subject.id, courseCode: subject.code, courseName: subject.name, source: 'mano' };
    const key = `${day}:${record.start}:${record.courseId}:${date || 'weekly'}:${room}`;
    timetable.set(key, record);
  }
  return [...timetable.values()].sort((a,b) => (a.day-b.day) || a.start.localeCompare(b.start));
}
export function extractLectureRowsFromDOM(doc) {
  const rows = [];
  for (const table of doc.querySelectorAll('table')) {
    const trs = [...table.querySelectorAll('tr')];
    const first = trs[0];
    const columns = first ? [...first.querySelectorAll('th,td')].map(e => dayIndex(e.textContent)) : [];
    const wideTable = columns.some(d => d >= 0);
    for (const tr of trs.slice(wideTable ? 1 : 0)) {
      const cells = [...tr.querySelectorAll(':scope > th, :scope > td')].map(e => (e.innerText || e.textContent || '').trim());
      if (wideTable) {
        for (let i = 0; i < Math.min(columns.length, cells.length); i++)
          if (columns[i] >= 0 && cells[i]) rows.push([DAYS[columns[i]][0], cells[0], cells[i]]);
      } else if (cells.length > 1) rows.push(cells);
    }
  }
  for (const row of doc.querySelectorAll('[role="row"], mat-row, .k-master-row')) {
    const cells = [...row.querySelectorAll('[role="cell"], mat-cell, .k-table-td')].map(e => (e.innerText || e.textContent || '').trim());
    if (cells.length > 1) rows.push(cells);
  }
  return rows.slice(0, 300);
}
export async function scanLectureTimetable(courses = [], events = [], group = '') {
  if (typeof chrome === 'undefined' || !chrome.tabs?.query || !chrome.scripting?.executeScript)
    throw new Error('Open CourseFlow as an installed Chrome extension.');
  const tabs = await chrome.tabs.query({ url: `${MANO}/*` });
  const candidates = tabs.filter(t => t.id && !/examstimetable/i.test(t.url || ''));
  if (!candidates.length) throw new Error('Open Mano → Studies → Timetables → Lectures in Chrome and keep it open.');
  let lastError = 'No matching lecture table was found. Check your group and that the timetable is visible.';
  for (const tab of candidates) {
    try {
      const result = await chrome.scripting.executeScript({ target:{tabId:tab.id}, func:()=>{
        const rows=[];
        for(const table of document.querySelectorAll('table')) {
          const trs=[...table.querySelectorAll('tr')];
          const heads=trs[0] ? [...trs[0].querySelectorAll('th,td')].map(x=>(x.innerText||x.textContent||'').trim()) : [];
          const names=['monday','tuesday','wednesday','thursday','friday','saturday','sunday','pirmadienis','antradienis','trečiadienis','ketvirtadienis','penktadienis','šeštadienis','sekmadienis'];
          const days=heads.map(x=>names.findIndex(n=>x.toLowerCase().includes(n)));
          const matrix=days.some(x=>x>=0);
          for(const tr of trs.slice(matrix?1:0)) {
            const c=[...tr.querySelectorAll(':scope > td,:scope > th')].map(x=>(x.innerText||x.textContent||'').replace(/\s+/g,' ').trim());
            if (matrix) {
              for(let i=0;i<Math.min(days.length,c.length);i++) {
                if(days[i]>=0 && c[i]) rows.push([heads[i],c[0],c[i]]);
              }
            } else if(c.length>1) { rows.push(c); }
          }
        }
        for (const tr of document.querySelectorAll('[role="row"],mat-row,.k-master-row')) {
          const c=[...tr.querySelectorAll('[role="cell"],mat-cell,.k-table-td')].map(x=>(x.innerText||x.textContent||'').replace(/\s+/g,' ').trim());
          if(c.length>1) rows.push(c);
        }
        return { origin:location.origin, path:location.pathname, rows:rows.slice(0,300) };
      } });
      const page = result?.[0]?.result;
      if (page?.origin !== MANO) continue;
      if (!/timetable|schedule|tvarkara|paskait/i.test(page.path) && !/timetable|schedule|tvarkara|paskait/i.test(tab.title || '')) continue;
      const classes = parseLectureRows(page.rows, courses, events, group);
      if (classes.length) return { classes, scannedAt: new Date().toISOString() };
      lastError = 'The timetable opened, but no class rows matched Moodle subjects. No incorrect classes were imported.';
    } catch (err) { lastError = err.message || lastError; }
  }
  throw new Error(lastError);
}
