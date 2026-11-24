import { EXAM_PAGE, matchExamsToMoodle } from './mano.js';
import { toDisplayTask } from './manual.js';
export const MOODLE = 'https://moodle.vilniustech.lt';

export function normalizeTitle(title) {
  return String(title || '')
    .normalize('NFKD').toLowerCase().replace(/[\u0300-\u036f]/g, '')
    .replace(/turi buti pateikta|submission form|\b(submit|submission|upload of|upload|opens|closes|atidaroma|uzdaromas|uzdaroma|for grading)\b/gi, ' ')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

function similarity(a, b) {
  const x = normalizeTitle(a), y = normalizeTitle(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.length > 9 && y.length > 9 && (x.includes(y) || y.includes(x))) return 0.94;
  const wx = new Set(x.split(' ')), wy = new Set(y.split(' '));
  let intersection = 0;
  for (const word of wx) if (wy.has(word)) intersection++;
  return intersection / (wx.size + wy.size - intersection);
}

export function matchAssignment(event, assignments, courses) {
  const candidates = [];
  for (const item of assignments) {
    const course = courses.find(c => String(c.id) === String(item.courseId));
    const courseCode = course?.code || '';
    if (event.courseCode && courseCode && event.courseCode !== courseCode) continue;
    const sameCourse = Boolean(event.courseCode && courseCode && event.courseCode === courseCode);
    const score = similarity(event.name, item.name);
    // Never infer a completion based solely on an approximate name across courses.
    if (score < (sameCourse ? 0.72 : 0.94)) continue;
    candidates.push({ item, score });
  }
  candidates.sort((a, b) => b.score - a.score);
  if (!candidates.length) return null;
  // Duplicate titles (e.g. "Homework 1" in two different sections) are ambiguous.
  if (candidates.length > 1 && candidates[0].score - candidates[1].score < 0.075) return null;
  return candidates[0].item;
}

export function joinData(events = [], assignments = [], courses = [], manualSubjects = [], manoExams = [], manoIsLive = false, manualTasks = []) {
  const courseById = new Map(courses.map(c => [String(c.id), c]));
  const courseByCode = new Map(courses.filter(c => c.code).map(c => [c.code, c]));
  const manualByCode = new Map(manualSubjects.filter(s => s.code).map(s => [s.code, s]));
  const matched = new Set();
  const tasks = [];
  const uniqueEvents = new Map();
  // Moodle exports separate 'opens' and 'closes' events for the same quiz.
  // Show a single exam with a start/end rather than two separate upcoming exams.
  const ordered = [...events].sort((a, b) => (a.due || '').localeCompare(b.due || ''));
  for (const event of ordered) {
    if (event.kind !== 'assignment' && event.kind !== 'exam') continue;
    const isExamClose = event.kind === 'exam' && /(?:closes|close|uždaromas|uždaroma)$/i.test(event.name);
    if (isExamClose) {
      const opening = [...uniqueEvents.values()].reverse().find(previous =>
        previous.kind === 'exam' && previous.courseCode === event.courseCode &&
        normalizeTitle(previous.name) === normalizeTitle(event.name) &&
        new Date(event.due) - new Date(previous.due) <= 24 * 3600_000 &&
        new Date(event.due) >= new Date(previous.due));
      if (opening) { opening.end = event.due; continue; }
    }
    uniqueEvents.set(event.id, { ...event });
  }
  for (const event of uniqueEvents.values()) {
    const assignment = event.kind === 'assignment' ? matchAssignment(event, assignments, courses) : null;
    if (assignment) matched.add(String(assignment.id));
    const course = courseByCode.get(event.courseCode) || manualByCode.get(event.courseCode);
    tasks.push({
      id: `ical:${event.id}`, name: event.name.replace(/\s+turi būti pateikta$/i, '').replace(/\s+(opens|atidaroma)$/i, '').trim(),
      kind: event.kind, due: event.due, end: event.end,
      courseId: course?.id || event.courseCode || 'unassigned',
      courseName: course?.name || event.courseCode || 'Unassigned',
      courseCode: event.courseCode || course?.code || '',
      status: assignment?.status || 'unknown',
      url: assignment?.url || event.url || `${MOODLE}/calendar/view.php?view=upcoming`,
      statusUpdated: assignment?.checkedAt || null,
      origin: assignment ? 'moodle+calendar' : 'calendar',
      assignmentId: assignment?.id ?? null,
      hasMoodleStatus: Boolean(assignment && assignment.status !== 'unknown')
    });
  }
  for (const assignment of assignments) {
    if (matched.has(String(assignment.id))) continue;
    const course = courseById.get(String(assignment.courseId));
    tasks.push({
      id: `assign:${assignment.id}`, name: assignment.name,
      kind: 'assignment', due: assignment.due || null, end: null,
      courseId: course?.id || 'unassigned', courseName: course?.name || 'Unassigned',
      courseCode: course?.code || '', status: assignment.status || 'unknown',
      url: assignment.url, statusUpdated: assignment.checkedAt || null,
      origin: 'moodle', assignmentId: assignment.id, hasMoodleStatus: assignment.status !== 'unknown'
    });
  }
  // Mano contains many university-wide electives. Never show an official exam
  // unless its subject is verified against a Moodle course or Moodle ICS course code.
  for (const exam of matchExamsToMoodle(manoExams, courses, events)) {
    tasks.push({
      id: `mano:${exam.code}:${exam.date}:${exam.time || 'TBA'}`,
      name: 'University exam', kind: 'exam', due: exam.at, end: null,
      courseId: exam.matchedCourseId, courseName: exam.matchedCourseName,
      courseCode: exam.code, status: 'unknown', url: EXAM_PAGE,
      statusUpdated: null, origin: 'mano', timeKnown: Boolean(exam.time),
      examRoom: exam.room || null, examType: exam.type || 'E', manoIsLive
    });
  }
  for (const item of manualTasks) tasks.push(toDisplayTask(item, getCourseList(courses, events, manualSubjects, assignments)));
  return tasks.sort((a, b) => {
    if (!a.due) return 1;
    if (!b.due) return -1;
    return a.due.localeCompare(b.due);
  });
}

export function getTaskState(task, now = new Date()) {
  if (task.kind === 'exam') return 'exam';
  if (task.status === 'submitted') return 'submitted';
  if (task.status === 'draft' || task.status === 'not-submitted') {
    return task.due && new Date(task.due) < now ? 'overdue' : 'pending';
  }
  return 'unverified';
}

export function getCourseList(courses = [], events = [], manualSubjects = [], assignments = []) {
  const map = new Map();
  for (const course of courses) map.set(String(course.id), { ...course, source: 'moodle' });
  for (const subject of manualSubjects) {
    if (!Array.from(map.values()).some(v => subject.code && v.code === subject.code)) {
      map.set(String(subject.id), { ...subject, source: 'manual' });
    }
  }
  for (const event of events) {
    if (!event.courseCode || Array.from(map.values()).some(v => v.code === event.courseCode)) continue;
    map.set(`calendar-${event.courseCode}`, {
      id: `calendar-${event.courseCode}`, code: event.courseCode, name: event.courseCode,
      source: 'calendar'
    });
  }
  for (const item of assignments) {
    if (!map.has(String(item.courseId))) map.set(String(item.courseId), {
      id: String(item.courseId), code: '', name: `Course ${item.courseId}`, source: 'moodle'
    });
  }
  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export function dateLabel(iso, opts = { month: 'short', day: 'numeric' }) {
  if (!iso) return 'No due date';
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Vilnius', ...opts }).format(new Date(iso));
}

export function isSameVilniusDay(date, now = new Date()) {
  return dateLabel(date, { year: 'numeric', month: 'numeric', day: 'numeric' }) ===
    dateLabel(now.toISOString(), { year: 'numeric', month: 'numeric', day: 'numeric' });
}
