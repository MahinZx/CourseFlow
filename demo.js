// Clearly labeled demo data, never used or stored when connecting real Moodle.
const now = new Date();
const plusDays = (days, hours = 20) => { const d = new Date(now); d.setDate(d.getDate() + days); d.setHours(hours, 59, 0, 0); return d.toISOString(); };
export function demoState() {
  const courses = [
    { id: 101, name: 'Software Engineering', shortname: 'FMISB23500', code: 'FMISB23500' },
    { id: 102, name: 'Front-end Development', shortname: 'FMISB23501', code: 'FMISB23501' },
    { id: 103, name: 'Project Management', shortname: 'FMITB24502', code: 'FMITB24502' },
    { id: 104, name: 'Database Systems', shortname: 'FMITB24503', code: 'FMITB24503' },
    { id: 105, name: 'Computer Networks', shortname: 'FMISB23504', code: 'FMISB23504' },
    { id: 106, name: 'Programming Techniques', shortname: 'FMISB23505', code: 'FMISB23505' }
  ];
  const tasks = [
    [1, 'User Interface & UX Lab 5', 'FMISB23500', 'assignment', 101, 'draft'],
    [2, 'Homework No. 3', 'FMISB23501', 'assignment', 102, 'not-submitted'],
    [3, 'Lab 06 — Resource Allocation', 'FMITB24502', 'assignment', 103, 'submitted'],
    [4, 'Database Query Report', 'FMITB24503', 'assignment', 104, 'unknown'],
    [5, 'Routing Practical', 'FMISB23504', 'assignment', 105, 'submitted'],
    [6, 'JavaFX Final Project', 'FMISB23505', 'assignment', 106, 'draft'],
    [7, 'Front-end Development Midterm', 'FMISB23501', 'exam', 102, 'unknown'],
    [8, 'Software Engineering Exam', 'FMISB23500', 'exam', 101, 'unknown']
  ];
  const events = tasks.map(([id, name, code, kind], i) => ({
    id: `demo-${id}`, name, kind, courseCode: code, due: plusDays(i === 7 ? 28 : i + 2), end: null, url: '', description: ''
  }));
  const assignments = tasks.filter(t => t[3] === 'assignment').map(([id, name, code, kind, courseId, status]) => ({
    id, name, courseId, status, url: `https://moodle.vilniustech.lt/mod/assign/view.php?id=${id}`, checkedAt: now.toISOString()
  }));
  return { version: 1, calendarUrl: '', courses, assignments, events, manualSubjects: [], semester: 'Autumn 2026',
    lastCalendarSync: now.toISOString(), lastStatusSync: now.toISOString(), syncError: '' };
}
