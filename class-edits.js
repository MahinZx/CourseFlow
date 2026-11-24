// Local timetable edits. Source-aware keys prevent accidentally deleting another
// class that happens to use the same time or course.
import { mergeClasses } from './timetable-import.js';
export function classIdentity(c={}) {
  return JSON.stringify([
    c.source||'', String(c.courseId||''), Number(c.day), c.start||'', c.end||'',
    c.date||'', c.firstDate||'', c.untilDate||'', c.room||'',
    c.weekNumber||'', c.kind||'', c.repeat||''
  ]);
}
export function removeClass(classes=[], key='') {
  return classes.filter(c=>classIdentity(c)!==key);
}
export function replaceClass(classes=[], key='', replacement) {
  return mergeClasses(removeClass(classes,key), [replacement]);
}
