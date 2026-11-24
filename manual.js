// Private coursework that the university has not published in Moodle.
export const WORK_TYPES = Object.freeze({
  homework: 'Homework', assignment: 'Assignment', lab: 'Lab work',
  practical: 'Practical work', project: 'Project', quiz: 'Quiz',
  exam: 'Exam', other: 'Other work'
});
export const SOURCES = Object.freeze({
  email: 'Teacher email', portal: 'Student portal', classroom: 'In class', other: 'Personal note'
});
export function buildManualTask(input, courses, existing = [], editingId = null) {
  const name = String(input.name || '').trim().replace(/\s+/g, ' ').slice(0, 120);
  const type = String(input.type || 'assignment');
  const courseId = String(input.courseId || '');
  const source = String(input.source || 'other');
  const subject = courses.find(c => String(c.id) === courseId);
  if (!name) throw new Error('Enter a task name.');
  if (!Object.hasOwn(WORK_TYPES, type)) throw new Error('Choose a valid work type.');
  if (!subject) throw new Error('Choose one of your subjects first.');
  if (!Object.hasOwn(SOURCES, source)) throw new Error('Choose a valid source.');
  const due = input.due ? new Date(input.due) : null;
  if (due && !Number.isFinite(due.getTime())) throw new Error('Enter a valid deadline.');
  const dueISO = due ? due.toISOString() : null;
  if (existing.some(t => String(t.id) !== String(editingId) && String(t.courseId) === courseId &&
      t.name.toLowerCase() === name.toLowerCase() && (t.due || null) === dueISO)) {
    throw new Error('This task already exists for the subject and deadline.');
  }
  return {
    id: editingId || `manual-task:${typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`}`, name, type,
    courseId, due: dueISO, source, note: String(input.note || '').trim().slice(0, 500),
    finished: Boolean(input.finished), updatedAt: new Date().toISOString()
  };
}
export function toDisplayTask(item, courses = []) {
  const course = courses.find(c => String(c.id) === String(item.courseId));
  const isExam = ['quiz', 'exam'].includes(item.type);
  return {
    id: item.id, name: item.name, kind: isExam ? 'exam' : 'assignment',
    workType: item.type, due: item.due || null, end: null,
    courseId: item.courseId, courseName: course?.name || 'Deleted subject',
    courseCode: course?.code || '', status: item.finished ? 'done' : 'not-submitted',
    origin: 'manual', source: item.source, note: item.note, url: '',
    assignmentId: null, hasMoodleStatus: false
  };
}
