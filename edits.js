// Personal progress is deliberately separate from Moodle's official submission result.
// The key remains stable when a calendar event is matched to a Moodle assignment.
export function editKey(task) {
  return task.assignmentId != null ? `assignment:${task.assignmentId}` : task.id;
}
export function getEdit(task, edits = {}) {
  return edits[editKey(task)] || edits[task.id] || null;
}
export function effectiveState(task, edits = {}, now = new Date()) {
  if (task.kind === 'exam') return task.origin === 'manual' && task.status === 'done' ? 'done' : 'exam';
  const personal = getEdit(task, edits)?.status;
  if (personal === 'team') return 'team';
  if (personal === 'done') return 'done';
  if (personal === 'not-required') return 'not-required';
  if (personal === 'todo') return effectiveDue(task, edits) && new Date(effectiveDue(task, edits)) < now ? 'overdue' : 'pending';
  if (task.status === 'done') return 'done';
  if (task.status === 'submitted') return 'submitted';
  if (task.status === 'draft' || task.status === 'not-submitted')
    return effectiveDue(task, edits) && new Date(effectiveDue(task, edits)) < now ? 'overdue' : 'pending';
  return 'unverified';
}
export function effectiveDue(task, edits = {}) {
  return getEdit(task, edits)?.due || task.due || null;
}
export function isFinished(task, edits = {}) {
  return ['submitted', 'team', 'done'].includes(effectiveState(task, edits));
}
export function needsAttention(task, edits = {}) {
  return task.kind === 'assignment' && !isFinished(task, edits) && effectiveState(task, edits) !== 'not-required';
}
export function cleanEdit(status, due, note) {
  const allowed = ['auto','team','done','todo','not-required'];
  if (!allowed.includes(status)) throw new Error('Invalid status');
  const cleanDue = due && Number.isFinite(new Date(due).getTime()) ? new Date(due).toISOString() : null;
  const result = { status, due: cleanDue, note: String(note || '').trim().slice(0,240), changedAt: new Date().toISOString() };
  return status === 'auto' && !cleanDue && !result.note ? null : result;
}
