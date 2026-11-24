import { parseICS, validateCalendarUrl } from './ics.js';
import { MOODLE, joinData, getCourseList, dateLabel } from './model.js';
import { scanMoodle } from './moodle.js';
import { demoState } from './demo.js';
import { EXAM_PAGE, USER_TIMETABLE_SNAPSHOT, scanMano, matchExamsToMoodle } from './mano.js';
import { editKey, getEdit, cleanEdit, effectiveDue, effectiveState, isFinished, needsAttention } from './edits.js';
import { scanLiveTimetable, mergeManoCapture } from './live-timetable.js';
import { classOccurrences, nextClass, todayClasses, validDate, weekdayIndex } from './lecture-events.js';
import { calendarDay, visibleCalendarItems } from './calendar-view.js';
import { buildManualTask, WORK_TYPES, SOURCES } from './manual.js';
import { extractPdfText } from './pdf-lite.js';
import { proposeTimetable, mergeClasses } from './timetable-import.js';
import { classIdentity, removeClass, replaceClass } from './class-edits.js';
import {lessonKey,planTimetableChanges,applySelectedTimetableChanges,makeTimetableSnapshot} from './timetable-review.js';

const DEMO = new URLSearchParams(location.search).get('demo') === '1';
const STORAGE_KEY = 'courseflow:data:v1';
const MANO_PENDING_KEY = 'courseflow:mano:pending:v1';
const MANO_DISMISSED_KEY = 'courseflow:mano:dismissed:v1';
const defaultState = () => ({
  version: 1, semester: 'Autumn 2026', calendarUrl: '', courses: [], events: [],
  assignments: [], manualSubjects: [], manualTasks: [], remindersEnabled: false, reminderLog: {}, personalEdits: {}, studentGroup: '', lectures: [], lastLectureSync: null, lastManoLectureSync: null, lectureSyncError: '', manoExams: USER_TIMETABLE_SNAPSHOT,
  lastCalendarSync: null, lastStatusSync: null, lastManoSync: null, manoSyncError: '', syncError: '', timetableSnapshots: [], timetableSuppressedKeys: []
});
const memoryFallback = { [STORAGE_KEY]: null };
const storage = {
  async get() {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      return (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
    }
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch { return memoryFallback[STORAGE_KEY]; }
  },
  async set(value) {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      await chrome.storage.local.set({ [STORAGE_KEY]: value }); return;
    }
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(value)); } catch { memoryFallback[STORAGE_KEY] = value; }
  },
  async clear() {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      await chrome.storage.local.remove(STORAGE_KEY); return;
    }
    try { localStorage.removeItem(STORAGE_KEY); } catch { memoryFallback[STORAGE_KEY] = null; }
  }
};
let state = defaultState();
let ui = { view: 'overview', filter: 'todo', courseFilter: 'all', busy: false, editingKey: null, editingManualId: null, editingClassKey: null, editingClass: null, proposedClasses: [], proposedSource: 'pdf', proposedScope: {}, showClasses: true, showPast: false, manoPending: null };
let toastTimer;
const el = id => document.getElementById(id);
const allTasks = () => joinData(state.events, state.assignments, state.courses, state.manualSubjects, state.manoExams || [], Boolean(state.lastManoSync), state.manualTasks || []);
const subjects = () => {
  const list=getCourseList(state.courses,state.events,state.manualSubjects,state.assignments);
  const ids=new Set(list.map(c=>String(c.id)));
  // MANO can provide timetable-only subjects on a fresh install, with no PDF
  // or Moodle course data. Keep those records local and usable by all views.
  for(const item of state.lectures||[]){
    if(!String(item.courseId||'').startsWith('mano-')||ids.has(String(item.courseId)))continue;
    list.push({id:item.courseId,name:item.courseName,code:item.courseCode||'',source:'mano'});
    ids.add(String(item.courseId));
  }
  return list;
};
const taskState = task => effectiveState(task, state.personalEdits || {});
const isSubmitted = task => isFinished(task, state.personalEdits || {});
const needsWork = task => needsAttention(task, state.personalEdits || {});
const taskDue = task => effectiveDue(task, state.personalEdits || {});
const formatTime = iso => iso ? dateLabel(iso, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Never';
const update = async () => { if (!DEMO) await storage.set(state); render(); };
function svg(id) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const u = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  u.setAttribute('href', `#${id}`); s.append(u); return s;
}
function node(tag, className = '', text = '') {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== '') element.textContent = text;
  return element;
}
function toast(message, type = '') {
  const target = el('toast');
  target.textContent = String(message);
  target.className = `toast ${type}`.trim(); target.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { target.hidden = true; }, 5500);
}
function statusOf(task) {
  const stateName = taskState(task);
  const status = {
    submitted: ['Moodle submitted', 'submitted'],
    team: ['Team submitted', 'team'],
    done: ['Done · personal', 'team'],
    'not-required': ['Not required', 'unverified'],
    pending: [task.status === 'draft' && !getEdit(task, state.personalEdits)?.status ? 'Draft' : 'To submit', 'pending'],
    overdue: ['Overdue', 'overdue'],
    unverified: ['Unverified', 'unverified'], exam: [task.origin === 'manual' ? 'Personal exam' : task.origin === 'mano' ? (task.manoIsLive ? 'Official exam' : 'Exam · saved') : 'Moodle quiz', 'exam']
  };
  return status[stateName] || status.unverified;
}
function safeTaskUrl(task) {
  if (task.origin === 'manual') return '';
  if (task.origin === 'mano') return EXAM_PAGE;
  return (task.url || '').startsWith(`${MOODLE}/`) ? task.url : `${MOODLE}/my/`;
}
function makeTaskRow(task) {
  const row = node('article', `task-row state-${taskState(task)} kind-${task.kind}`);
  const symbol = node('div', 'task-symbol'); symbol.append(svg(task.kind === 'exam' ? 'i-calendar' : isSubmitted(task) ? 'i-check' : 'i-book'));
  const main = node('div', 'task-main');
  main.append(node('p', 'task-name', task.name), node('div', 'task-subject',
    task.courseName + (task.examRoom ? ` · Room ${task.examRoom}` : '')));
  const edit = getEdit(task, state.personalEdits || {});
  if (edit?.note || task.note) main.append(node('div', 'task-note', edit?.note || task.note));
  if (task.origin === 'manual') main.append(node('div', 'task-source', `${WORK_TYPES[task.workType] || 'Personal work'} · ${SOURCES[task.source] || 'Personal note'}`));
  const right = node('div', 'task-right');
  const due = taskDue(task);
  const date = node('div', 'due-date', due ? dateLabel(due, { day: 'numeric', month: 'short' }) : 'No date');
  const time = task.kind === 'exam' && task.origin === 'mano' && !task.timeKnown ? 'Time TBA' :
    due ? dateLabel(due, { hour: '2-digit', minute: '2-digit' }) : task.origin === 'manual' ? 'Not set' : 'Check Moodle';
  date.append(node('small', '', time));
  const [text, style] = statusOf(task);
  const badge = node('span', `status-pill ${style}`, text);
  const link = node('a', 'task-link');
  const url = safeTaskUrl(task);
  if (url) {
    link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.title = task.origin === 'mano' ? 'Open Mano' : 'Open Moodle';
    link.setAttribute('aria-label', `Open ${task.name} in ${task.origin === 'mano' ? 'Mano VILNIUS TECH' : 'Moodle'}`); link.append(svg('i-external'));
  }
  if (task.kind === 'assignment' || task.origin === 'manual') {
    const editButton = node('button', 'task-edit', task.origin === 'manual' ? 'Details' : 'Edit'); editButton.type='button';
    editButton.setAttribute('aria-label', `Edit ${task.name}`);
    editButton.addEventListener('click', () => task.origin === 'manual' ? openManualWork(task.id) : openEdit(task));
    right.append(editButton);
  }
  right.append(date, badge); if (url) right.append(link); row.append(symbol, main, right);
  return row;
}
function empty(icon, heading, copy) {
  const box = node('div', 'empty-state');
  const art = node('div', 'empty-state-icon'); art.append(svg(icon));
  box.append(art, node('strong', '', heading), node('p', '', copy));
  return box;
}
function verifiedLectures() {
  const allowed = new Set(subjects().map(s=>String(s.id)));
  // MANO's selected timetable is authoritative. Legacy manually-entered group
  // preferences must not hide already-approved classes after the field is removed.
  return (state.lectures||[]).filter(c=>allowed.has(String(c.courseId)));
}
function dayHeading(iso) { return dateLabel(`${iso}T12:00:00Z`,{weekday:'long',day:'numeric',month:'short'}); }
function renderAgenda() {
  const classes=verifiedLectures(), upcoming=nextClass(classes), today=todayClasses(classes);
  el('next-class-name').textContent=upcoming?.courseName || 'Next lecture not confirmed';
  el('next-class-meta').textContent=upcoming
    ? `${upcoming.projected?'Estimated · ':''}${dayHeading(upcoming.date)} · ${upcoming.start}${upcoming.end?'–'+upcoming.end:''}${upcoming.room?' · Room '+upcoming.room:''}${upcoming.kind?' · '+upcoming.kind:''}`
    : classes.length ? 'No upcoming dated class in saved data. Capture a future Mano week or add an exact class date.'
      : 'Capture dated classes from your Mano timetable to see the next real session.';
  el('next-class-confidence').textContent=upcoming
    ? upcoming.projected?`${upcoming.source==='mano'?'Mano':'PDF'} weekly estimate · verify in Mano`:upcoming.source==='mano'?'Mano · dated snapshot':upcoming.source==='manual'?'Manually scheduled':'PDF · saved snapshot'
    : 'Unconfirmed';
  el('today-classes-count').textContent=`${today.length} scheduled${today.some(c=>c.projected)?' (includes estimates)':''}`;
  const box=el('today-classes-list'); box.replaceChildren();
  if(!today.length)box.append(node('p','',classes.length?'No dated classes saved for today. You may still need to capture this week.':'Capture a dated timetable to see today’s classes.'));
  else for(const c of today.slice(0,6)){
    const row=node('div','today-lecture');
    row.append(node('strong','',c.start),node('span','',c.courseName));
    if(c.room||c.projected)row.append(node('small','',`${c.room||''}${c.projected?' · estimated':''}`.replace(/^ · /,'')));
    box.append(row);
  }
}
function renderOverview() {
  const tasks = allTasks(), courseList = subjects(), now = new Date();
  const upcomingExams = tasks.filter(t => t.kind === 'exam' && t.due && new Date(t.due) >= now);
  const assignments = tasks.filter(t => t.kind === 'assignment');
  el('stat-subjects').textContent = courseList.length;
  el('nav-subject-count').textContent = courseList.length;
  el('stat-pending').textContent = assignments.filter(needsWork).length;
  el('stat-submitted').textContent = assignments.filter(isSubmitted).length;
  el('stat-exams').textContent = upcomingExams.length;
  el('semester-text').textContent = state.semester.toUpperCase();
  renderAgenda();
  el('setup-prompt').hidden = Boolean(state.events.length || state.courses.length || state.assignments.length || state.manualTasks?.length || state.manualSubjects?.length || state.lectures?.length || DEMO);
  const select = el('course-filter'); const old = ui.courseFilter;
  select.replaceChildren(new Option('All subjects', 'all'));
  for (const course of courseList) select.append(new Option(course.name, String(course.id)));
  if (![...select.options].some(o => o.value === old)) ui.courseFilter = 'all';
  select.value = ui.courseFilter;
  document.querySelectorAll('#overview-filters .chip').forEach(button => button.classList.toggle('active', button.dataset.filter === ui.filter));
  let result = tasks;
  if (ui.filter === 'todo') result = result.filter(needsWork);
  if (ui.filter === 'submitted') result = result.filter(t => t.kind === 'assignment' && isSubmitted(t));
  if (ui.filter === 'exams') result = result.filter(t => t.kind === 'exam' && t.due && new Date(t.due) >= now);
  if (ui.courseFilter !== 'all') result = result.filter(t => String(t.courseId) === ui.courseFilter);
  el('work-count').textContent = result.length;
  const list = el('task-list'); list.replaceChildren();
  if (!result.length) {
    const { title, message } = ui.filter === 'submitted' ? { title: 'Nothing confirmed yet', message: 'Moodle submissions and your own completed group work will appear here.' } :
      ui.filter === 'exams' ? { title: 'No exam dates yet', message: 'Connect your Moodle calendar to import upcoming exam events.' } :
      ui.filter === 'todo' && tasks.length ? { title: 'All caught up', message: 'No unfinished assignments in this view. Check the All tab for exams and older events.' } :
      { title: 'Your semester starts here', message: 'Open Settings to connect your Moodle calendar or import an .ics file.' };
    list.append(empty('i-check', title, message));
  } else {
    for (const task of result.slice(0, ui.filter === 'all' ? 120 : 80)) list.append(makeTaskRow(task));
  }
}
function renderSubjects() {
  const box = el('subjects-grid'); box.replaceChildren();
  const items = subjects(), tasks = allTasks();
  if (!items.length) { box.append(empty('i-book', 'No subjects yet', 'Scan Moodle or add semester subjects manually in Settings.')); return; }
  for (const course of items) {
    const card = node('button', 'subject-card'); card.type = 'button';
    const icon = node('div', 'subject-icon'); icon.append(svg('i-book'));
    const name = node('div', 'subject-name', course.name);
    const code = node('div', 'subject-code', course.code || 'Personal subject');
    const bottom = node('div', 'subject-bottom');
    const courseTasks = tasks.filter(t => String(t.courseId) === String(course.id) && t.kind === 'assignment');
    bottom.append(node('span', '', `${courseTasks.length} assignment${courseTasks.length === 1 ? '' : 's'}`),
      node('strong', '', `${courseTasks.filter(isSubmitted).length} completed`));
    const coming=nextClass(verifiedLectures(), course.id);
    const lectureInfo=node('div','subject-next',coming
      ? `${coming.projected?'Estimated next class':'Next class'} · ${dayHeading(coming.date)} · ${coming.start}${coming.room?' · '+coming.room:''}`
      : 'Next class date unconfirmed');
    card.append(icon, name, code, lectureInfo, bottom);
    card.addEventListener('click', () => {
      ui.courseFilter = String(course.id); ui.filter = 'all'; navigate('overview');
    });
    box.append(card);
  }
}
function renderCalendar() {
  const root = el('calendar-list'); root.replaceChildren();
  const all=allTasks().filter(t => taskDue(t)).map(task=>({kind:'task',at:taskDue(task),task}));
  if(ui.showClasses) {
    const from=ui.showPast?null:calendarDay();
    for(const c of classOccurrences(verifiedLectures(),{from,limit:1500}))all.push({kind:'class',at:c.at,entry:c});
  }
  const visible=visibleCalendarItems(all,{showPast:ui.showPast});
  visible.sort((a,b)=>a.at.localeCompare(b.at));
  if (!visible.length) { root.append(empty('i-calendar', ui.showPast ? 'Your calendar is empty' : 'No upcoming events', ui.showPast ? 'Connect Moodle, capture your timetable or add a personal task.' : 'Nothing scheduled from today onward. Select Show past dates to view earlier events.')); return; }
  const monthGroups = new Map();
  for (const item of visible) {
    const month = dateLabel(item.at,{month:'long',year:'numeric'});
    if(!monthGroups.has(month))monthGroups.set(month,[]);
    monthGroups.get(month).push(item);
  }
  for (const [month,entries] of monthGroups) {
    const group=node('section','calendar-month');
    group.append(node('div','calendar-month-heading',month));
    for(const item of entries){
      const t=item.task,c=item.entry;
      const line=node('div',`calendar-event ${c?'calendar-class':'state-'+taskState(t)}`);
      const date=node('div','calendar-datebox');
      date.append(node('strong','',dateLabel(item.at,{day:'numeric'})),node('small','',dateLabel(item.at,{weekday:'short'})));
      const info=node('div','calendar-event-info');
      if(c){
        info.append(node('strong','',c.courseName),node('small','',`${c.projected?'Class estimate':'Class'} · ${c.start}${c.end?'–'+c.end:''}${c.kind?' · '+c.kind:''}${c.room?' · '+c.room:''}`));
        line.append(date,info,node('span','status-pill class-pill',c.projected?'Estimated':c.source==='manual'?'Personal':'Class'));
      }else{
        const href=safeTaskUrl(t),anchor=node(href?'a':'strong','',t.name);
        if(href){anchor.href=href;anchor.target='_blank';anchor.rel='noopener noreferrer';}
        const timeLabel=t.kind==='exam'&&t.origin==='mano'&&!t.timeKnown?'Time TBA':dateLabel(item.at,{hour:'2-digit',minute:'2-digit'});
        info.append(anchor,node('small','',`${t.courseName} · ${timeLabel}${t.examRoom?' · '+t.examRoom:''}`));
        const [label,style]=statusOf(t);
        line.append(date,info,node('span',`status-pill ${style}`,label));
      }
      group.append(line);
    }
    root.append(group);
  }
}

function openEdit(task) {
  if (DEMO) { toast('Personal edits are disabled in the demo.', 'error'); return; }
  ui.editingKey = editKey(task);
  const existing = getEdit(task, state.personalEdits || {});
  el('edit-title').textContent = task.name;
  el('edit-subtitle').textContent = task.courseName;
  el('edit-status').value = existing?.status || 'auto';
  el('official-status-note').textContent = `Current Moodle status: ${task.status === 'submitted' ? 'Submitted' : task.status === 'unknown' ? 'Unverified' : task.status}. Your personal choice will not change Moodle.`;
  const due = existing?.due ? new Date(existing.due) : null;
  if (due) {
    const z = n => String(n).padStart(2, '0');
    el('edit-due').value = `${due.getFullYear()}-${z(due.getMonth()+1)}-${z(due.getDate())}T${z(due.getHours())}:${z(due.getMinutes())}`;
  } else el('edit-due').value = '';
  el('edit-note').value = existing?.note || '';
  el('edit-dialog').showModal();
}
const WEEKDAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
function renderManoReview() {
  const panel=el('mano-review-panel');
  const pending=ui.manoPending;
  const {changes,unchanged,protectedCount}=pending?.classes?.length
    ? planTimetableChanges(state.lectures,pending.classes,state.timetableSuppressedKeys||[])
    : {changes:[],unchanged:0,protectedCount:0};
  panel.hidden=!pending||!changes.length;
  el('mano-review-count').textContent=changes.length
    ? `${changes.length} proposed · ${unchanged} unchanged · ${protectedCount} protected personal classes`
    : pending?'No unapproved changes. Current timetable remains saved.':'No pending changes.';
  const root=el('mano-review-list');root.replaceChildren();
  for(const change of changes){
    const row=node('label','import-item mano-change-item');
    const select=node('input');select.type='checkbox';select.value=change.id;
    select.dataset.changeId=change.id;
    const label=change.action==='updated'?'Classroom or schedule details changed':'New class detected';
    const title=node('strong','',`${label} · ${WEEKDAYS[change.after.day]} ${change.after.start}`);
    const details=change.action==='updated'
      ? `${change.after.courseName} · ${change.before.room||'No room'} → ${change.after.room||'No room'}${change.before.firstDate!==change.after.firstDate?' · date range changed':''}`
      : `${change.after.courseName}${change.after.kind?' · '+change.after.kind:''}${change.after.room?' · '+change.after.room:''}`;
    row.append(select,title,node('span','',details));root.append(row);
  }
  el('mano-approve-selected').disabled=!changes.length||DEMO;
  el('mano-review-panel').hidden=!changes.length;
  el('mano-undo').hidden=!(state.timetableSnapshots||[]).length;
}
function renderTimetable() {
  const items=verifiedLectures(), dated=items.filter(c=>validDate(c.date)), undated=items.filter(c=>!validDate(c.date));
  const last=state.lastManoLectureSync?`Mano capture ${formatTime(state.lastManoLectureSync)}`: 'Mano not captured yet';
  const weeks=new Set(dated.filter(c=>c.source==='mano').map(c=>c.weekStart).filter(Boolean));
  const estimates=undated.filter(c=>c.repeat==='weekly'&&['mano','pdf'].includes(c.source)).length;
  renderManoReview();
  el('timetable-status').textContent=`${last} · ${dated.length} dated sessions across ${weeks.size} Mano week${weeks.size===1?'':'s'} · ${estimates} weekly estimates · ${undated.length-estimates} unanchored patterns. Automatic detection when a signed-in MANO timetable is open; updates require approval.`;
  const root=el('timetable-list'); root.replaceChildren();
  if(!items.length){root.append(empty('i-clock','No classes captured yet','Open your group timetable in Mano, then click Capture visible week.'));return;}
  const addRow=(section,c)=>{
    const row=node('div','timetable-entry');
    row.append(node('span','timetable-hours',c.start+(c.end?`–${c.end}`:'')));
    const copy=node('div','timetable-details');
    copy.append(node('strong','',c.courseName));
    const origin=c.source==='mano'?'Mano snapshot':c.source==='manual'?(c.originalSource?`Personal edit (${c.originalSource.toUpperCase()} original)`:'Personal entry'):'PDF snapshot';
    const recurring=c.repeat==='weekly'?` · ${c.source==='manual'?'Weekly':'Estimated weekly'}`:c.repeat==='biweekly'?' · Every 2 weeks':'';
    copy.append(node('small','',`${c.kind?c.kind+' · ':''}${c.room?'Room '+c.room+' · ':''}${origin}${recurring}${c.firstDate?' · '+c.firstDate+' to '+c.untilDate:''}${c.weekNote?' · '+c.weekNote:''}`));
    row.append(copy);
    const actions=node('div','class-entry-actions');
    const edit=node('button','task-edit class-edit','Edit');edit.type='button';
    edit.setAttribute('aria-label',`Edit ${c.courseName} ${c.start}`);
    edit.addEventListener('click',()=>openManualClass(c));
    const del=node('button','task-edit class-delete-inline','Delete');del.type='button';
    del.setAttribute('aria-label',`Delete ${c.courseName} ${c.start}`);
    del.addEventListener('click',async()=>{
      if(DEMO||!confirm(`Delete this ${c.source==='manual'?'personal':'imported'} class? This only changes CourseFlow.`))return;
      state.lectures=removeClass(state.lectures,classIdentity(c));
      if(c.source!=='manual') state.timetableSuppressedKeys=[...new Set([...(state.timetableSuppressedKeys||[]),lessonKey(c)])];
      await update();toast('Class deleted locally. Future MANO scans will not silently recreate it.','success');
    });
    actions.append(edit,del);row.append(actions);
    section.append(row);
  };
  const groups=new Map();
  for(const c of dated.sort((a,b)=>a.date.localeCompare(b.date)||a.start.localeCompare(b.start))){
    if(!groups.has(c.date))groups.set(c.date,[]);
    groups.get(c.date).push(c);
  }
  if(groups.size){root.append(node('h2','timetable-section-heading',`Dated classes · ${dated.length}`));}
  for(const [date,records] of groups){
    const section=node('section','timetable-day');
    section.append(node('h3','timetable-day-title',dayHeading(date)));
    for(const c of records)addRow(section,c);
    root.append(section);
  }
  if(undated.length){
    root.append(node('h2','timetable-section-heading','Weekly patterns · confirm dates or estimates in Mano'));
    for(let day=0;day<7;day++){
      const records=undated.filter(c=>c.day===day).sort((a,b)=>a.start.localeCompare(b.start));
      if(!records.length)continue;
      const section=node('section','timetable-day');
      section.append(node('h3','timetable-day-title',WEEKDAYS[day]+' · verify weeks in Mano'));
      for(const c of records)addRow(section,c);
      root.append(section);
    }
  }
}

async function captureTimetable() {
  if(ui.busy||DEMO)return;
  ui.busy=true;render();
  try{
    const scanned=await scanLiveTimetable(subjects(),state.events,'',state.lectures);
    const classes=scanned.classes.map(c=>({...c,source:'mano'}));
    const payload={capturedAt:new Date().toISOString(),classes,fingerprint:JSON.stringify(classes),
      diagnostics:{recognized:scanned.recognized,rejected:scanned.rejected,unmatched:scanned.unmatched}};
    if(typeof chrome!=='undefined'&&chrome.storage?.local){
      await chrome.storage.local.remove(MANO_DISMISSED_KEY);
      await chrome.storage.local.set({[MANO_PENDING_KEY]:payload});
    }
    ui.manoPending=payload;
    state.lectureSyncError='';
    navigate('timetable');
    const changes=planTimetableChanges(state.lectures,classes,state.timetableSuppressedKeys||[]);
    toast(changes.changes.length?`${changes.changes.length} MANO changes ready for review; none applied.`:'MANO matches your saved timetable. No changes needed.','success');
  }catch(error){state.lectureSyncError=error.message;await update();toast(error.message,'error');}
  finally{ui.busy=false;render();}
}

function renderSettings() {
  el('semester-name').value = state.semester;
  el('lecture-sync-status').textContent = state.lastManoLectureSync ? `Last Mano capture ${formatTime(state.lastManoLectureSync)} · ${state.lectures.filter(c=>c.source==='mano').length} Mano sessions saved` : (state.lectureSyncError || 'Not captured yet. Open the timetable search form in Mano first.');
  el('calendar-url').value = state.calendarUrl;
  el('calendar-status').textContent = state.lastCalendarSync
    ? `${state.events.length} calendar events imported · Last update: ${formatTime(state.lastCalendarSync)}`
    : 'No calendar imported yet.';
  el('moodle-status-text').textContent = state.lastStatusSync
    ? `${state.assignments.filter(x => x.status !== 'unknown').length}/${state.assignments.length} verified · ${formatTime(state.lastStatusSync)}`
    : state.syncError ? 'Sign in to Moodle and retry' : 'Not checked yet';
  const matchedExams = matchExamsToMoodle(state.manoExams || [], state.courses, state.events);
  el('mano-status-text').textContent = state.lastManoSync
    ? `${matchedExams.length} matched exams · Live sync ${formatTime(state.lastManoSync)}`
    : `${matchedExams.length} matching exams · Provided timetable snapshot (not live)`;
  el('mano-error').textContent = state.manoSyncError || '';
  el('enable-reminders').checked = Boolean(state.remindersEnabled);
  el('reminders-status').textContent = state.remindersEnabled ? 'Enabled · checks locally every 30 minutes for upcoming deadlines.' : 'Off by default. Uses saved deadlines only; does not scan Moodle in the background.';
}
function render() {
  document.querySelectorAll('.view').forEach(view => { view.hidden = view.dataset.page !== ui.view; });
  document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.view === ui.view));
  el('crumb-current').textContent = { overview: 'Overview', subjects: 'My subjects', calendar: 'Calendar', timetable: 'Timetable', settings: 'Settings' }[ui.view];
  const connected = Boolean(state.lastStatusSync || state.lastCalendarSync || state.lastManoSync || state.lastManoLectureSync);
  const sync = el('sync-indicator');
  sync.className = `sync-indicator ${state.syncError ? 'error' : connected ? 'connected' : ''}`;
  sync.lastChild.textContent = '';
  // A leading dot remains; use the status label without treating it as HTML.
  sync.replaceChildren(node('span', 'sync-dot'), document.createTextNode(DEMO ? 'Demo data' : ui.busy ? 'Syncing…' : state.syncError ? 'Check connection' : connected ? (state.lastStatusSync || state.lastCalendarSync || state.lastManoSync ? 'Sync available' : 'Timetable saved') : 'Not connected'));
  el('sync-button').disabled = ui.busy || DEMO;
  el('sync-moodle').disabled = ui.busy || DEMO;
  el('sync-mano').disabled = ui.busy || DEMO;
  el('sync-lectures').disabled = ui.busy || DEMO;
  el('capture-timetable').disabled = ui.busy || DEMO;
  el('sync-button').classList.toggle('busy-spin', ui.busy);
  el('demo-banner').hidden = !DEMO;
  renderOverview(); renderSubjects(); renderCalendar(); renderTimetable(); renderSettings();
}
function navigate(name) {
  ui.view = name; render(); window.scrollTo({ top: 0, behavior: 'instant' });
}
async function syncCalendar({ quiet = false } = {}) {
  if (!state.calendarUrl) return { skipped: true };
  const url = validateCalendarUrl(state.calendarUrl);
  const response = await fetch(url, { credentials: 'omit', cache: 'no-store' });
  if (!response.ok) throw new Error(`Calendar download returned HTTP ${response.status}.`);
  const data = await response.text();
  if (!data.includes('BEGIN:VCALENDAR')) throw new Error('Moodle did not return a calendar. The private link may be expired or revoked.');
  const events = parseICS(data);
  state.events = events; state.lastCalendarSync = new Date().toISOString();
  await update();
  if (!quiet) toast(`${events.length} calendar events synced.`, 'success');
  return { count: events.length };
}
async function syncStatuses({ quiet = false } = {}) {
  const scanned = await scanMoodle(message => {
    el('sync-indicator').replaceChildren(node('span', 'sync-dot'), document.createTextNode(message));
  });
  state.courses = scanned.courses; state.assignments = scanned.assignments;
  state.lastStatusSync = scanned.lastStatusSync;
  await update();
  if (!quiet) toast(`Found ${state.courses.length} courses; verified ${scanned.verified} assignment statuses.`, 'success');
  return scanned;
}
async function syncMano({ quiet = false } = {}) {
  const scanned = await scanMano();
  // Only timetable rows are saved, never Mano's page, auth session, or unrelated data.
  state.manoExams = scanned.exams;
  state.lastManoSync = scanned.scannedAt;
  state.manoSyncError = '';
  await update();
  const matches = matchExamsToMoodle(state.manoExams, state.courses, state.events);
  if (!quiet) toast(`${matches.length} official exam${matches.length === 1 ? '' : 's'} matched to Moodle subjects.`, 'success');
  return matches.length;
}
async function syncAll({ quiet = false, mode = 'all' } = {}) {
  if (ui.busy || DEMO) return;
  ui.busy = true; state.syncError = ''; render();
  const errors = []; let completed = 0;
  try {
    if (mode !== 'moodle' && mode !== 'mano' && state.calendarUrl) {
      try { await syncCalendar({ quiet: true }); completed++; }
      catch (error) { errors.push(`Calendar: ${error.message}`); }
    }
    if (mode !== 'calendar' && mode !== 'mano') {
      try { await syncStatuses({ quiet: true }); completed++; }
      catch (error) { errors.push(`Moodle: ${error.message}`); }
    }
    if (mode === 'mano' || mode === 'all') {
      try { await syncMano({ quiet: true }); completed++; }
      catch (error) {
        state.manoSyncError = error.message;
        // A missing Mano tab should not flag a successful Moodle sync as a failure.
        if (mode === 'mano') errors.push(`Mano: ${error.message}`);
      }
    }
    state.syncError = errors.join(' ');
    await update();
    if (!quiet) {
      if (errors.length && !completed) toast(errors.join(' '), 'error');
      else if (errors.length) toast(`Partially synced. ${errors.join(' ')}`, 'error');
      else toast(`Up to date · ${state.events.length} calendar events · ${matchExamsToMoodle(state.manoExams || [], state.courses, state.events).length} matching official exams`, 'success');
    }
  } finally { ui.busy = false; render(); }
}

// Manual tasks are stored separately from Moodle records so a scan cannot erase them.
function localDatetime(iso) {
  if (!iso) return '';
  const d = new Date(iso); if (!Number.isFinite(d.getTime())) return '';
  const z = n => String(n).padStart(2,'0');
  return `${d.getFullYear()}-${z(d.getMonth()+1)}-${z(d.getDate())}T${z(d.getHours())}:${z(d.getMinutes())}`;
}
function populateSubjects(select, selected = '') {
  select.replaceChildren(new Option('Choose a subject', ''));
  for (const subject of subjects()) select.append(new Option(subject.name, String(subject.id)));
  select.value = selected;
}
function openManualWork(id = null) {
  if (DEMO) { toast('Personal coursework is unavailable in the demo.', 'error'); return; }
  if (!subjects().length) { navigate('settings'); el('new-subject-name').focus(); toast('Add a subject or sync Moodle before adding coursework.', 'error'); return; }
  const old = (state.manualTasks || []).find(t => t.id === id);
  ui.editingManualId = old?.id || null;
  el('manual-work-title').textContent = old ? 'Edit coursework' : 'Add coursework';
  el('manual-name').value = old?.name || '';
  el('manual-type').value = old?.type || 'lab';
  populateSubjects(el('manual-course'), old?.courseId || (ui.courseFilter !== 'all' ? ui.courseFilter : ''));
  el('manual-due').value = localDatetime(old?.due);
  el('manual-source').value = old?.source || 'email';
  el('manual-note').value = old?.note || '';
  el('manual-finished').checked = Boolean(old?.finished);
  el('manual-delete').hidden = !old;
  el('manual-work-dialog').showModal();
  el('manual-name').focus();
}
function bindManualWork() {
  el('manual-work-close').addEventListener('click', () => el('manual-work-dialog').close());
  el('manual-work-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (DEMO) return;
    try {
      const item = buildManualTask({
        name: el('manual-name').value, type: el('manual-type').value,
        courseId: el('manual-course').value, due: el('manual-due').value,
        source: el('manual-source').value, note: el('manual-note').value,
        finished: el('manual-finished').checked
      }, subjects(), state.manualTasks, ui.editingManualId);
      const index = state.manualTasks.findIndex(x => x.id === ui.editingManualId);
      if (index < 0) state.manualTasks.push(item); else state.manualTasks[index] = item;
      await update(); el('manual-work-dialog').close();
      toast('Personal coursework saved. Moodle data was not changed.', 'success');
    } catch (error) { toast(error.message, 'error'); }
  });
  el('manual-delete').addEventListener('click', async () => {
    if (!ui.editingManualId || !confirm('Delete this personal coursework?')) return;
    state.manualTasks = state.manualTasks.filter(x=>x.id !== ui.editingManualId);
    delete state.personalEdits[ui.editingManualId];
    await update(); el('manual-work-dialog').close(); toast('Personal task deleted.', 'success');
  });
}
function showTimetablePreview(classes) {
  ui.proposedClasses = classes;
  const root = el('timetable-preview-list'); root.replaceChildren();
  el('timetable-preview-title').textContent = `Review ${classes.length} ${ui.proposedSource === 'mano' ? 'Mano' : 'PDF'} class${classes.length === 1 ? '' : 'es'}`;
  el('timetable-import-mode').closest('label').hidden=ui.proposedSource==='mano';
  el('timetable-preview-help').textContent=ui.proposedSource==='mano'
    ? 'Review subjects and times against Mano. If weekday labels are missing, uniquely matched PDF classes provide a labelled fallback (not a verified Mano date). Alternating weeks stay unprojected.'
    : 'Review all entries carefully. Regular semester PDF rows produce estimated weekly dates; Week 1/2 alternating entries remain unprojected until their date anchor is confirmed.';
  classes.forEach((c, index) => {
    const row = node('label', 'import-item');
    const select = node('input'); select.type = 'checkbox'; select.checked = true; select.dataset.importIndex = String(index);
    const scheduleLabel=c.date?dayHeading(c.date):c.repeat==='weekly'&&c.firstDate
      ? `${WEEKDAYS[c.day]} · weekly estimate ${c.firstDate}–${c.untilDate}`
      : WEEKDAYS[c.day]+' (exact dates unknown)';
    row.append(select, node('strong', '', `${scheduleLabel} · ${c.start}${c.end ? '–'+c.end : ''}`),
      node('span', '', `${c.courseName}${c.kind?' · '+c.kind:''}${c.room ? ' · '+c.room : ''}${c.weekNote?' · '+c.weekNote:''}`));
    root.append(row);
  });
  el('timetable-preview').hidden = !classes.length;
  if (classes.length) el('timetable-preview').scrollIntoView({block:'nearest',behavior:'smooth'});
}
function proposeFromText(text) {
  const parsed = proposeTimetable(text, subjects(), state.events, '');
  if (!parsed.classes.length) {
    showTimetablePreview([]);
    throw new Error('No matching class/day/time found. Check the PDF text or add the missing class manually.');
  }
  ui.proposedSource='pdf';ui.proposedScope={};
  showTimetablePreview(parsed.classes);
  toast(`Found ${parsed.classes.length} potential class entries. Check before importing.`, 'success');
}
function bindTimetableImport() {
  el('choose-timetable-pdf').addEventListener('click', () => el('timetable-pdf-file').click());
  el('timetable-pdf-file').addEventListener('change', async e => {
    const file = e.target.files?.[0]; e.target.value='';
    if (!file || DEMO) return;
    try {
      if (!subjects().length) throw new Error('Sync Moodle or add your subjects before importing the PDF timetable.');
      const text = await extractPdfText(file);
      proposeFromText(text);
    } catch (error) { toast(error.message, 'error'); }
  });
  el('paste-timetable').addEventListener('click', () => { el('paste-timetable-panel').hidden = !el('paste-timetable-panel').hidden; });
  el('parse-timetable-text').addEventListener('click', () => {
    try { proposeFromText(el('timetable-text').value); } catch (error) { toast(error.message, 'error'); }
  });
  el('confirm-timetable').addEventListener('click', async () => {
    if (DEMO || !ui.proposedClasses.length) return;
    const mode = el('timetable-import-mode').value;
    const selected = [...el('timetable-preview-list').querySelectorAll('input:checked')].map(x => ui.proposedClasses[Number(x.dataset.importIndex)]).filter(Boolean);
    if (!selected.length) { toast('Select at least one class to import.', 'error'); return; }
    const count = selected.length;
    const incoming = selected.map(x => ({...x,source:ui.proposedSource}));
    if(ui.proposedSource==='mano'){
      // Backward-compatible route for older previews; new MANO captures use
      // the separate review screen and selective approval only.
      toast('Review MANO changes in the dedicated change-review panel.','error');return;
    } else {
      state.lectures = mode === 'replace' ? mergeClasses(state.lectures.filter(c=>c.source==='manual'||c.source==='mano'),incoming) : mergeClasses(state.lectures,incoming);
    }
    state.lastLectureSync=new Date().toISOString();
    await update();showTimetablePreview([]);
    toast(`${count} reviewed ${ui.proposedSource==='mano'?'Mano':'PDF'} entries saved.`, 'success');
  });
  el('cancel-timetable').addEventListener('click', () => showTimetablePreview([]));
}
function bindManoReview() {
  el('mano-select-all').addEventListener('click',()=>{
    el('mano-review-list').querySelectorAll('input[type=checkbox]').forEach(x=>x.checked=true);
  });
  el('mano-approve-selected').addEventListener('click',async()=>{
    if(DEMO)return;
    const selected=[...el('mano-review-list').querySelectorAll('input:checked')].map(x=>x.dataset.changeId);
    if(!selected.length){toast('Select the classes you want to approve. Unselected changes will remain pending.','error');return;}
    const reviewedFingerprint=ui.manoPending?.fingerprint;
    const pending=(await chrome.storage.local.get(MANO_PENDING_KEY))[MANO_PENDING_KEY];
    if(pending?.fingerprint!==reviewedFingerprint){
      ui.manoPending=pending||null;render();toast('MANO changed while you were reviewing. Please check the refreshed proposal.','error');return;
    }
    if(!pending?.classes?.length){toast('No MANO changes available; recapture the timetable.','error');return;}
    // Always compare against the freshest saved version immediately before save.
    const latest=await storage.get();
    const current={...defaultState(),...(latest||{})};
    const proposal=planTimetableChanges(current.lectures||[],pending.classes,current.timetableSuppressedKeys||[]);
    const result=applySelectedTimetableChanges(current.lectures||[],proposal.changes,selected);
    if(!result.applied.length){toast('Those changes are no longer available; refresh your review.','error');ui.manoPending=pending;state=current;render();return;}
    current.timetableSnapshots=[...(current.timetableSnapshots||[]),makeTimetableSnapshot(current.lectures||[],`Before ${result.applied.length} approved MANO change(s)`)].slice(-10);
    current.lectures=result.lectures;
    current.lastManoLectureSync=new Date().toISOString();current.lastLectureSync=current.lastManoLectureSync;
    state=current;
    await update();
    const remaining=planTimetableChanges(state.lectures,pending.classes,state.timetableSuppressedKeys||[]);
    if(!remaining.changes.length){await chrome.storage.local.remove(MANO_PENDING_KEY);ui.manoPending=null;}
    render();
    toast(`${result.applied.length} selected change(s) approved. All other classes kept unchanged.`, 'success');
  });
  el('mano-dismiss').addEventListener('click',async()=>{
    if(!ui.manoPending)return;
    if(typeof chrome!=='undefined'&&chrome.storage?.local){
      await chrome.storage.local.set({[MANO_DISMISSED_KEY]:ui.manoPending.fingerprint});
      await chrome.storage.local.remove(MANO_PENDING_KEY);
    }
    ui.manoPending=null;render();toast('Proposed changes dismissed. Your saved classes are unchanged.','success');
  });
  el('mano-undo').addEventListener('click',async()=>{
    if(DEMO||!state.timetableSnapshots?.length||!confirm('Restore the timetable from before the last MANO approval? This also replaces class edits made since then.'))return;
    const previous=state.timetableSnapshots.at(-1);
    state.lectures=structuredClone(previous.lectures);
    state.timetableSnapshots=state.timetableSnapshots.slice(0,-1);
    await update();toast('Previous timetable snapshot restored.','success');
  });
}
function showClassDateMode() {
  const mode=el('class-repeat').value;
  el('class-single-dates').hidden=mode!=='once';
  el('class-range-dates').hidden=!['weekly','biweekly'].includes(mode);
}
function openManualClass(old=null) {
  if(DEMO)return;
  if(!subjects().length){navigate('settings');toast('Add a subject first.','error');return;}
  ui.editingClassKey=old?classIdentity(old):null;
  ui.editingClass=old||null;
  populateSubjects(el('class-course'),old?.courseId||'');
  const repeat=old?.repeat|| (old?.date?'once':old?'pattern':'once');
  el('class-repeat').value=repeat;
  el('class-type').value=old?.kind||'';
  el('class-date').value=old?.date||'';
  el('class-first-date').value=old?.firstDate||'';
  el('class-until-date').value=old?.untilDate||'';
  el('class-day').value=String(old?.day??0);
  el('class-start').value=old?.start||'08:30';
  el('class-end').value=old?.end||'';
  el('class-room').value=old?.room||'';
  el('class-note').value=old?.weekNote||'';
  el('class-delete').hidden=!old;
  el('manual-class-title').textContent=old?'Edit class':'Add a class';
  el('class-origin-help').textContent=old&&old.source!=='manual'
    ? `Imported from ${old.source.toUpperCase()}. Saving creates a personal copy so later timetable captures do not overwrite your correction. Reimporting may add the original again.`
    : 'Changes stay on this device and never modify the university timetable.';
  showClassDateMode();el('manual-class-dialog').showModal();
}
function bindManualClasses() {
  el('add-manual-class').addEventListener('click',()=>openManualClass());
  el('manual-class-close').addEventListener('click',()=>el('manual-class-dialog').close());
  el('class-repeat').addEventListener('change',showClassDateMode);
  for(const id of ['class-date','class-first-date'])el(id).addEventListener('change',()=>{
    const value=el(id).value;
    if(validDate(value))el('class-day').value=String(weekdayIndex(value));
  });
  el('manual-class-form').addEventListener('submit',async e=>{
    e.preventDefault();
    const course=subjects().find(s=>String(s.id)===el('class-course').value);
    const start=el('class-start').value,end=el('class-end').value,repeat=el('class-repeat').value;
    const date=el('class-date').value,firstDate=el('class-first-date').value,untilDate=el('class-until-date').value;
    const day=Number(el('class-day').value);
    if(!course||!start||(end&&end<=start)){toast('Choose a subject and valid start/end times.','error');return;}
    if(repeat==='once'&&(!validDate(date)||weekdayIndex(date)!==day)) {toast('Choose an exact class date matching its weekday.','error');return;}
    if(['weekly','biweekly'].includes(repeat) && (!validDate(firstDate)||!validDate(untilDate)||untilDate<firstDate||weekdayIndex(firstDate)!==day||
      (Date.parse(untilDate+'T12:00:00Z')-Date.parse(firstDate+'T12:00:00Z'))>366*86400000)){
      toast('Choose a valid first class date and end date (within one year).','error');return;
    }
    const item={day,start,end:end||null,courseId:course.id,courseCode:course.code,courseName:course.name,
      room:el('class-room').value.trim().slice(0,50),kind:el('class-type').value,
      weekNote:el('class-note').value.trim().slice(0,110),
      date:repeat==='once'?date:null,repeat,
      firstDate:['weekly','biweekly'].includes(repeat)?firstDate:null,
      untilDate:['weekly','biweekly'].includes(repeat)?untilDate:null,source:'manual',
      originalSource:ui.editingClass?.originalSource||(ui.editingClass?.source!=='manual'?ui.editingClass?.source:null),
      originalLessonKey:ui.editingClass?.originalLessonKey||(ui.editingClass?lessonKey(ui.editingClass):null),
      ...(repeat==='pattern'&&ui.editingClass?.weekNumber?{weekNumber:ui.editingClass.weekNumber}:{})};
    if(ui.editingClass && ui.editingClass.source!=='manual')
      state.timetableSuppressedKeys=[...new Set([...(state.timetableSuppressedKeys||[]),lessonKey(ui.editingClass)])];
    state.lectures=ui.editingClassKey?replaceClass(state.lectures,ui.editingClassKey,item):mergeClasses(state.lectures,[item]);
    state.lastLectureSync=new Date().toISOString();
    await update();el('manual-class-dialog').close();toast('Class saved locally.','success');
  });
  el('class-delete').addEventListener('click',async()=>{
    if(!ui.editingClassKey||!confirm('Delete this class from CourseFlow? Reimporting may restore imported classes.'))return;
    if(ui.editingClass?.source!=='manual')state.timetableSuppressedKeys=[...new Set([...(state.timetableSuppressedKeys||[]),lessonKey(ui.editingClass)])];
    state.lectures=removeClass(state.lectures,ui.editingClassKey);
    await update();el('manual-class-dialog').close();toast('Class deleted locally and protected against silent reimport.','success');
  });
}

function bindBackups() {
  el('export-backup').addEventListener('click', () => {
    if (DEMO) return;
    const backup = { format: 'CourseFlow backup', exportVersion: 1, at: new Date().toISOString(),
      data: {...state, calendarUrl: ''} };
    const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], {type:'application/json'}));
    const a = node('a'); a.href = url; a.download = `CourseFlow-backup-${new Date().toISOString().slice(0,10)}.json`;
    document.body.append(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url), 2000);
    toast('Backup saved without your private Moodle subscription link.', 'success');
  });
  el('import-backup').addEventListener('click', () => el('backup-file').click());
  el('backup-file').addEventListener('change', async e => {
    const file = e.target.files?.[0]; e.target.value=''; if (!file || DEMO) return;
    try {
      if (file.size > 5_000_000) throw new Error('Backup is too large.');
      const data = JSON.parse(await file.text());
      if (data.format !== 'CourseFlow backup' || !data.data || !Array.isArray(data.data.manualTasks) ||
        !Array.isArray(data.data.lectures) || !Array.isArray(data.data.courses) || !Array.isArray(data.data.events)) throw new Error('Not a recognized CourseFlow backup.');
      if (!confirm('Restore this backup? It will replace your current CourseFlow data.')) return;
      const copy = data.data;
      state = { ...defaultState(), ...copy, calendarUrl: state.calendarUrl, remindersEnabled: false,
        manualTasks: copy.manualTasks.slice(0, 2000), lectures: copy.lectures.slice(0, 3000) };
      await update(); toast('Backup restored. Your local Moodle subscription link was preserved. Re-enable reminders if wanted.', 'success');
    } catch (error) { toast(error.message, 'error'); }
  });
}

function bindReminders() {
  el('enable-reminders').addEventListener('change', async event => {
    const enabled = event.target.checked;
    if (DEMO) { event.target.checked = false; return; }
    if (enabled && typeof chrome !== 'undefined' && chrome.permissions?.request) {
      const granted = await chrome.permissions.request({ permissions: ['notifications'] });
      if (!granted) { event.target.checked=false; toast('Notifications were not enabled.', 'error'); return; }
    }
    state.remindersEnabled = enabled;
    await update();
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      try { await chrome.runtime.sendMessage({type:'courseflow:configure-reminders'}); } catch (error) { toast(`Could not set up alerts: ${error.message}`, 'error'); }
    }
    toast(enabled ? 'Private reminders enabled.' : 'Reminders disabled.', 'success');
  });
}
function bindEvents() {
  document.querySelectorAll('.nav-btn').forEach(button => button.addEventListener('click', () => navigate(button.dataset.view)));
  document.querySelectorAll('.chip').forEach(button => button.addEventListener('click', () => { ui.filter = button.dataset.filter; render(); }));
  el('course-filter').addEventListener('change', e => { ui.courseFilter = e.target.value; render(); });
  el('overview-show-all').addEventListener('click', () => { ui.filter = 'all'; ui.courseFilter = 'all'; render(); });
  el('setup-go').addEventListener('click', () => navigate('settings'));
  el('subjects-add').addEventListener('click', () => { navigate('settings'); el('new-subject-name').focus(); });
  for (const id of ['top-add-work','overview-add-work','subjects-add-work']) el(id).addEventListener('click', () => openManualWork());
  bindManualWork(); bindTimetableImport(); bindManualClasses(); bindManoReview(); bindBackups(); bindReminders();
  el('next-class-open').addEventListener('click',()=>navigate('timetable'));
  el('calendar-show-classes').addEventListener('change',e=>{ui.showClasses=e.target.checked;renderCalendar();});
  el('calendar-show-past').addEventListener('change',e=>{ui.showPast=e.target.checked;renderCalendar();});
  el('sync-button').addEventListener('click', () => syncAll());
  el('sync-moodle').addEventListener('click', () => syncAll({ mode: 'moodle' }));
  el('sync-mano').addEventListener('click', () => syncAll({ mode: 'mano' }));
  el('sync-lectures').addEventListener('click', captureTimetable);
  el('capture-timetable').addEventListener('click', captureTimetable);
  el('save-calendar').addEventListener('click', async () => {
    if (DEMO) return;
    try {
      state.calendarUrl = validateCalendarUrl(el('calendar-url').value.trim());
      await update();
      toast('Calendar URL saved only in this browser.', 'success');
      await syncAll({ mode: 'calendar' });
    } catch (error) { toast(error.message, 'error'); }
  });
  el('import-calendar').addEventListener('click', () => el('calendar-file').click());
  el('calendar-file').addEventListener('change', async event => {
    const file = event.target.files?.[0]; if (!file || DEMO) return;
    try {
      if (file.size > 5_000_000) throw new Error('Calendar is too large. Export a shorter date range.');
      state.events = parseICS(await file.text()); state.lastCalendarSync = new Date().toISOString();
      await update(); toast(`${state.events.length} calendar events imported.`, 'success');
    } catch (error) { toast(error.message, 'error'); }
    event.target.value = '';
  });
  el('save-semester').addEventListener('click', async () => {
    if (DEMO) return;
    const semester = el('semester-name').value.trim();
    if (!semester) { toast('Enter a semester name.', 'error'); return; }
    state.semester = semester.slice(0, 60); await update(); toast('Semester updated.', 'success');
  });
  el('save-subject').addEventListener('click', async () => {
    if (DEMO) return;
    const name = el('new-subject-name').value.trim();
    const code = el('new-subject-code').value.trim().toUpperCase();
    if (!name) { toast('Enter the subject name.', 'error'); return; }
    if (state.manualSubjects.some(s => s.name.toLowerCase() === name.toLowerCase())) { toast('Subject already exists.', 'error'); return; }
    const id = `manual-${Date.now()}`;
    state.manualSubjects.push({ id, name: name.slice(0,90), code: code.slice(0,20) });
    await update(); el('new-subject-name').value = ''; el('new-subject-code').value = '';
    toast('Subject added.', 'success');
  });
  el('edit-close').addEventListener('click', () => el('edit-dialog').close());
  el('edit-reset').addEventListener('click', async () => {
    if (!ui.editingKey || DEMO) return;
    delete state.personalEdits[ui.editingKey]; await update(); el('edit-dialog').close(); toast('Returned to Moodle status.', 'success');
  });
  el('edit-form').addEventListener('submit', async event => {
    event.preventDefault(); if (!ui.editingKey || DEMO) return;
    const value = el('edit-due').value;
    const due = value ? new Date(value) : null;
    const edit = cleanEdit(el('edit-status').value, due, el('edit-note').value);
    if (edit) state.personalEdits[ui.editingKey] = edit; else delete state.personalEdits[ui.editingKey];
    await update(); el('edit-dialog').close(); toast('Personal progress saved locally.', 'success');
  });
  el('clear-data').addEventListener('click', async () => {
    if (DEMO) return;
    if (!confirm('Clear imported courses, assignment statuses, and your private calendar URL from this browser?')) return;
    await storage.clear();
    if (typeof chrome !== 'undefined' && chrome.storage?.local)
      await chrome.storage.local.remove('courseflow:reminder-log:v1');
    state = defaultState(); ui.courseFilter = 'all'; ui.filter = 'todo';
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage)
      try { await chrome.runtime.sendMessage({type:'courseflow:configure-reminders'}); } catch { /* Service worker will re-check at startup. */ }
    navigate('overview'); toast('All local CourseFlow data has been cleared.', 'success');
  });
}
async function start() {
  state = DEMO ? demoState() : { ...defaultState(), ...(await storage.get() || {}) };
  state.personalEdits ||= {}; state.lectures ||= []; state.manualTasks ||= []; state.reminderLog ||= {};
  state.timetableSnapshots ||= [];state.timetableSuppressedKeys ||= [];
  if(!DEMO&&typeof chrome!=='undefined'&&chrome.storage?.local){
    ui.manoPending=(await chrome.storage.local.get(MANO_PENDING_KEY))[MANO_PENDING_KEY]||null;
    chrome.storage.onChanged.addListener((changes,area)=>{
      if(area==='local'&&MANO_PENDING_KEY in changes){
        ui.manoPending=changes[MANO_PENDING_KEY].newValue||null;
        render();
      }
    });
  }
  bindEvents(); render();
  // Refresh when the dashboard opens if more than 30 minutes have elapsed.
  // Avoid polling Moodle or storing login details in the background.
  if (!DEMO && typeof chrome !== 'undefined' && chrome.storage?.local) {
    const statusAge = Date.now() - new Date(state.lastStatusSync || 0).getTime();
    const calendarAge = Date.now() - new Date(state.lastCalendarSync || 0).getTime();
    if (statusAge > 30 * 60_000 || (state.calendarUrl && calendarAge > 30 * 60_000)) {
      await syncAll({ quiet: true });
    }
    // Only poll while the dashboard is open. Chrome is not contacted in the background.
    setInterval(() => { if (!ui.busy && !document.hidden) syncAll({ quiet: true }); }, 30 * 60_000);
  }
}
start().catch(error => toast(`CourseFlow could not start: ${error.message}`, 'error'));
