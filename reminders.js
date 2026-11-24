import { editKey, effectiveDue, isFinished, effectiveState } from './edits.js';
/** Pure decision function: no network, no browser actions, no repeating a sent reminder. */
export function remindersDue(tasks = [], edits = {}, sent = {}, now = new Date()) {
  const results = [];
  for (const task of tasks) {
    if (!['assignment', 'exam'].includes(task.kind) || isFinished(task, edits) || effectiveState(task, edits) === 'not-required') continue;
    if (task.origin === 'mano' && !task.timeKnown) continue;
    const due = effectiveDue(task, edits);
    if (!due) continue;
    const ms = new Date(due).getTime() - now.getTime();
    if (!Number.isFinite(ms) || ms < 0 || ms > 24*3600_000) continue;
    const level = ms <= 3*3600_000 ? '3h' : '24h';
    const key = `${editKey(task)}|${due}|${level}`;
    if (sent[key]) continue;
    results.push({ key, task, due, level, ms });
  }
  return results.sort((a,b)=>a.ms-b.ms);
}
