// Read-only Mano VILNIUS TECH exam timetable connector.
// Requires an already authenticated university browser session for live updates.
// No login details, cookies, grades, or entire HTML pages are persisted.
export const MANO = 'https://mano.vilniustech.lt';
export const EXAM_PAGE = `${MANO}/examstimetable/exams`;
const CODE_RE = /\b[A-Z]{2,10}\d{4,8}\b/;
const DATE_RE = /\b(20\d{2})[-./](\d{2})[-./](\d{2})\b/;
const TIME_RE = /\b([01]?\d|2[0-3]):([0-5]\d)\b/;

export function normCode(text) {
  return (String(text || '').toUpperCase().match(CODE_RE) || [])[0] || '';
}

export function normName(text) {
  return String(text || '').normalize('NFKD').toLowerCase()
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function localVilniusToISO(date, time) {
  // Convert the wall-clock time in Lithuania to UTC, regardless of the device timezone.
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Vilnius', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(guess));
  const fields = Object.fromEntries(parts.map(p => [p.type, p.value]));
  const localAtGuess = Date.UTC(+fields.year, +fields.month - 1, +fields.day, +fields.hour, +fields.minute);
  return new Date(guess - (localAtGuess - guess)).toISOString();
}

export function parseExamRow(rawCells) {
  const cells = (rawCells || []).map(v => String(v || '').replace(/\s+/g, ' ').trim());
  if (!cells.length) return null;
  const subjectIndex = cells.findIndex(v => CODE_RE.test(v));
  if (subjectIndex < 0) return null;
  const code = normCode(cells[subjectIndex]);
  const dateIndex = cells.findIndex(c => DATE_RE.test(c));
  if (dateIndex < 0) return null;
  const match = cells[dateIndex].match(DATE_RE);
  const date = `${match[1]}-${match[2]}-${match[3]}`;
  const [y, m, d] = date.split('-').map(Number);
  if (new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10) !== date) return null;
  let name = cells[subjectIndex].replace(CODE_RE, '').replace(/\s+/g, ' ').trim();
  if (!name) return null;
  const type = cells.slice(subjectIndex + 1, dateIndex).find(v => /^E(?:1|2)?$/i.test(v)) || 'E';
  let time = null;
  const timeMatch = (cells[dateIndex + 1] || cells[dateIndex]).match(TIME_RE);
  if (timeMatch) {
    const candidate = `${timeMatch[1].padStart(2, '0')}:${timeMatch[2]}`;
    // 00:00 is the university's placeholder for E1 entries with no precise time.
    if (candidate !== '00:00') time = candidate;
  }
  const roomValue = (cells[dateIndex + 2] || '').replace(/<br\s*\/?\s*>/ig, ' ').trim();
  const room = roomValue && !/^(?:[-–—]|n\/?a)$/i.test(roomValue) ? roomValue : null;
  const instructor = cells.slice(subjectIndex + 1, dateIndex).filter(c => c && !/^(?:E\d?|yes|no|[-–—]|\d+)$/i.test(c)).pop() || '';
  const at = localVilniusToISO(date, time || '12:00');
  return { code, name, type, date, time, room, instructor, at };
}

export function parseExamRows(rows) {
  const found = new Map();
  for (const row of rows || []) {
    const exam = parseExamRow(Array.isArray(row) ? row : row.cells);
    if (!exam) continue;
    found.set(`${exam.code}:${exam.date}:${exam.time || 'TBA'}`, exam);
  }
  return [...found.values()].sort((a, b) => a.at.localeCompare(b.at));
}

// This is the timetable supplied by the student on 23 November 2026.
// It is a fallback snapshot, NOT a claim of live synchronization.
// No unmatched subject appears in CourseFlow: matching is applied dynamically below.
export const USER_TIMETABLE_SNAPSHOT = parseExamRows([
  ['SMSSB93802 Healthy Lifestyle', 'E1', 'Yes', '3', 'Artūras Leščinskas', '2026-11-06', '00:00', '-'],
  ['KILSB18001 Basic Lithuanian (for Foreign Students)', 'E1', 'Yes', '3', 'Vaida Buivydienė', '2026-12-10', '00:00', '-'],
  ['FMITB91403 Selected Chapters from Theory of Algorithms 1', 'E1', 'Yes', '3', 'Artūras Mackūnas', '2026-12-10', '00:00', '-'],
  ['FMITB93404 C# Programming', 'E1', 'Yes', '3', 'Aivaras Čechamiras', '2026-12-10', '00:00', '-'],
  ['SMSSB93702 Physical Activity and Health', 'E1', 'Yes', '3', 'Artūras Leščinskas', '2026-12-10', '00:00', '-'],
  ['MEBIB91041 Medical Robots', 'E1', 'Yes', '3', 'Tadas Kizevičius', '2026-12-10', '00:00', '-'],
  ['FMIGB93008 3D Computer Graphics and Animation', 'E1', 'Yes', '3', 'Jurgis Zagorskas', '2026-12-10', '00:00', '-'],
  ['VVFRB93004 Basics of Business Financing', 'E1', 'Yes', '3', 'Artūras Struca', '2026-12-10', '00:00', '-'],
  ['KIUSB93102 French for Intermediate', 'E1', 'Yes', '3', 'Lina Dubikaltytė-Raugalienė', '2026-12-10', '00:00', '-'],
  ['FMISB23501 Internet Technologies', 'E', '-', '6', 'Urtė Radvilaitė', '2027-01-05', '09:00', 'P3(TRIII) 205'],
  ['FMITB24502 Principles of Project Management', 'E', '-', '3', 'Andrej Tunevič', '2027-01-07', '09:00', 'P3(TRIII) 205'],
  ['FMITB19524 Enterprise Governance of Information and Technology', 'E', '-', '6', 'Irmantas Aleliūnas', '2027-01-11', '16:00', 'S2(SRA-I) A01'],
  ['FMISB18500 Cryptography and Information Security', 'E', '-', '6', 'Paulius Narkevičius', '2027-01-18', '12:00', 'P3(TRIII) 201'],
  ['FMISB23500 Fundamentals of Software Engineering', 'E', '-', '6', 'Adebayo Adewumi Abayomi-Alli', '2027-01-21', '09:00', 'P3(TRIII) 205']
]);

export function matchExamsToMoodle(exams = [], courses = [], events = []) {
  // The course list is authoritative. Calendar course codes are also from Moodle;
  // never invent a new subject from an unmatched Mano row.
  const coursesByCode = new Map();
  const coursesByName = new Map();
  for (const course of courses) {
    const code = normCode(course.code) || normCode(course.shortname) || normCode(course.name);
    if (code) coursesByCode.set(code, course);
    const name = normName(course.name);
    if (name) coursesByName.set(name, course);
  }
  const calendarCodes = new Set(events.map(e => normCode(e.courseCode)).filter(Boolean));
  const result = [];
  for (const exam of exams) {
    const code = normCode(exam.code);
    if (!code) continue;
    const examName = normName(exam.name);
    let course = coursesByCode.get(code) || coursesByName.get(examName) || null;
    // Bilingual Moodle titles, e.g. "Fizinis aktyvumas ir sveikata / Physical Activity and Health".
    // Only accept a unique full-phrase match, not loose word similarity.
    if (!course && examName.length >= 17) {
      const names = courses.filter(c => {
        const name = normName(c.name);
        return name === examName || name.endsWith(` ${examName}`) ||
          name.startsWith(`${examName} `);
      });
      if (names.length === 1) course = names[0];
    }
    if (!course && !calendarCodes.has(code)) continue;
    result.push({ ...exam, code, matchedCourseId: course?.id ?? `calendar-${code}`,
      matchedCourseName: course?.name || exam.name });
  }
  return result;
}

export function extractExamRowsFromDOM(doc) {
  // Supports regular HTML tables and several accessible component-table variants.
  // Do not collect whole page text, passwords or form inputs.
  const rows = [];
  const seen = new Set();
  for (const row of doc.querySelectorAll('table tr, [role="row"], mat-row, .k-master-row')) {
    let cells = [...row.querySelectorAll(':scope > td, :scope > th, :scope > [role="cell"], :scope > mat-cell, :scope > .mat-cell, :scope > .k-table-td')];
    if (!cells.length) cells = [...row.querySelectorAll('td, [role="cell"], mat-cell')];
    if (!cells.length) continue;
    const values = cells.map(el => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim());
    if (!values.join(' ').match(CODE_RE) || !values.join(' ').match(DATE_RE)) continue;
    const signature = values.join('|');
    if (seen.has(signature)) continue;
    seen.add(signature); rows.push(values);
  }
  return rows.slice(0, 300);
}

export async function scanMano() {
  if (typeof chrome === 'undefined' || !chrome.tabs?.query || !chrome.scripting?.executeScript)
    throw new Error('Open CourseFlow as an installed Chrome extension.');
  const tabs = await chrome.tabs.query({ url: `${MANO}/*` });
  const candidates = tabs.filter(t => t.id && (t.url || '').includes('/examstimetable/exams'));
  if (!candidates.length) {
    throw new Error('Open the Mano Exams page in Chrome, sign in, then click Sync again.');
  }
  let lastError = 'Exam timetable rows were not visible yet. Allow the page to finish loading.';
  for (const tab of candidates) {
    try {
      const result = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          // Everything runs within the university page; return only table cell text.
          const rows = [];
          const seen = new Set();
          for (const row of document.querySelectorAll('table tr, [role="row"], mat-row, .k-master-row')) {
            let cells = [...row.querySelectorAll(':scope > td, :scope > th, :scope > [role="cell"], :scope > mat-cell, :scope > .mat-cell, :scope > .k-table-td')];
            if (!cells.length) cells = [...row.querySelectorAll('td, [role="cell"], mat-cell')];
            if (!cells.length) continue;
            const values = cells.map(el => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim());
            if (!values.join(' ').match(/\b[A-Z]{2,10}\d{4,8}\b/) || !values.join(' ').match(/20\d{2}[-./]\d{2}[-./]\d{2}/)) continue;
            const key = values.join('|');
            if (seen.has(key)) continue;
            seen.add(key); rows.push(values);
          }
          return { origin: location.origin, path: location.pathname, rows: rows.slice(0, 300) };
        }
      });
      const content = result?.[0]?.result;
      if (content?.origin !== MANO || !content.path?.startsWith('/examstimetable/exams')) continue;
      const exams = parseExamRows(content.rows);
      if (exams.length) return { exams, scannedAt: new Date().toISOString() };
    } catch (error) { lastError = error.message || lastError; }
  }
  throw new Error(lastError);
}
