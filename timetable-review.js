// Review-only timetable synchronization. A scan NEVER modifies saved classes.
// Only an explicit selection of change IDs may update a saved class.
import {normCode, normName} from './mano.js';

const plain = value => String(value ?? '').trim();
export function lessonKey(c={}) {
  const subject=normCode(c.courseCode) || normCode(c.courseName) || `name:${normName(c.courseName)||plain(c.courseId)}`;
  return JSON.stringify([subject,Number(c.day),plain(c.start),plain(c.date),plain(c.kind).toLowerCase(),
    plain(c.weekNumber),['','0','(not set)','-'].includes(plain(c.subgroup).toLowerCase())?'':plain(c.subgroup)]);
}
export function sameDetails(a={},b={}){
  return ['end','room','repeat','firstDate','untilDate','weekNumber'].every(k=>plain(a[k])===plain(b[k])) &&
    (['','0','-','(not set)'].includes(plain(a.subgroup).toLowerCase())?'':plain(a.subgroup))===
    (['','0','-','(not set)'].includes(plain(b.subgroup).toLowerCase())?'':plain(b.subgroup));
}
function cleanList(list) {
  const unique=new Map();
  for(const raw of list||[]){
    if(!raw||!Number.isInteger(Number(raw.day))||Number(raw.day)<0||Number(raw.day)>6||!/^\d{2}:\d{2}$/.test(plain(raw.start))||!plain(raw.courseName))continue;
    const item={...raw,source:'mano'};
    const key=lessonKey(item);
    if(!unique.has(key))unique.set(key,item);
  }
  return [...unique.values()];
}
// If a user has edited/deleted an imported lesson, a future scan must not
// recreate it automatically. Those records have a stable original lesson key.
export function planTimetableChanges(previous=[],captured=[],suppressedKeys=[]) {
  const blocked=new Set(suppressedKeys);
  const existing=new Map();
  for(const c of previous){
    const key=lessonKey(c);
    if(c.source==='manual') {
      blocked.add(key);
      if(c.originalLessonKey)blocked.add(c.originalLessonKey);
    } else if(!existing.has(key)||c.source==='mano')existing.set(key,c);
  }
  const changes=[];let unchanged=0,protectedCount=0;
  for(const incoming of cleanList(captured)){
    const key=lessonKey(incoming);
    if(blocked.has(key)){protectedCount++;continue;}
    const before=existing.get(key);
    if(before && sameDetails(before,incoming)) {unchanged++;continue;}
    const action=before?'updated':'added';
    const after={...incoming,courseId:before?.courseId||incoming.courseId};
    changes.push({id:`${action}:${key}`,action,key,before:before?{...before}:null,after});
  }
  return {changes,unchanged,protectedCount};
}
export function applySelectedTimetableChanges(previous=[],changes=[],selectedIds=[]) {
  const selected=new Set(selectedIds);
  const result=[...previous];const applied=[];
  for(const change of changes){
    if(!selected.has(change.id))continue;
    if(change.action==='updated'){
      // Remove ONLY the precise record approved for replacement. Never remove
      // unrelated timetable rows or a user's personal edit.
      const at=result.findIndex(c=>c.source!=='manual' && lessonKey(c)===change.key && sameDetails(c,change.before));
      if(at<0)continue;
      result.splice(at,1,change.after);
    }else if(change.action==='added'){
      if(result.some(c=>lessonKey(c)===change.key))continue;
      result.push(change.after);
    }else continue;
    applied.push(change.id);
  }
  result.sort((a,b)=>(a.date||'').localeCompare(b.date||'') || a.day-b.day || a.start.localeCompare(b.start));
  return {lectures:result,applied};
}
export function makeTimetableSnapshot(lectures=[],label='Approved MANO changes') {
  return {at:new Date().toISOString(),label,lectures:structuredClone(lectures)};
}
