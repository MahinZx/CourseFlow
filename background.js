// Local-only, opt-in reminders. Neither credentials nor course data leave Chrome.
import { joinData } from './model.js';
import { remindersDue } from './reminders.js';
import {captureVisibleLectureDOM,parseLiveRows} from './live-timetable.js';
const KEY = 'courseflow:data:v1';
const LOG_KEY = 'courseflow:reminder-log:v1';
const ALARM = 'courseflow-deadline-check';
chrome.action.onClicked.addListener(() => chrome.tabs.create({ url: chrome.runtime.getURL('index.html') }));

async function configureReminders() {
  const state = (await chrome.storage.local.get(KEY))[KEY];
  if (state?.remindersEnabled) await chrome.alarms.create(ALARM, { periodInMinutes: 30 });
  else await chrome.alarms.clear(ALARM);
}
async function runReminders() {
  const stored = await chrome.storage.local.get(KEY);
  const state = stored[KEY];
  if (!state?.remindersEnabled) return;
  const tasks = joinData(state.events || [], state.assignments || [], state.courses || [],
    state.manualSubjects || [], state.manoExams || [], Boolean(state.lastManoSync), state.manualTasks || []);
  const log = (await chrome.storage.local.get(LOG_KEY))[LOG_KEY] || {};
  const due = remindersDue(tasks, state.personalEdits || {}, log);
  if (!due.length) return;
  const permission = await chrome.permissions.contains({ permissions: ['notifications'] });
  if (!permission) { await chrome.alarms.clear(ALARM); return; }
  const toSend = due.slice(0, 3);
  for (const item of toSend) {
    try {
      await chrome.notifications.create(`courseflow:${Date.now()}:${Math.random().toString(36).slice(2)}`, {
        type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: item.level === '3h' ? 'CourseFlow · Due within 3 hours' : 'CourseFlow · Due within 24 hours',
        message: `${item.task.name} · ${item.task.courseName}`.slice(0, 200), priority: 1
      });
      log[item.key] = new Date().toISOString();
    } catch { /* An OS notification failure must not modify coursework. */ }
  }
  const sorted = Object.entries(log).sort((a,b)=>b[1].localeCompare(a[1]));
  // Log reminders under a different key so saving a notification cannot overwrite coursework edits.
  if (((await chrome.storage.local.get(KEY))[KEY])?.remindersEnabled)
    await chrome.storage.local.set({[LOG_KEY]:Object.fromEntries(sorted.slice(0, 500))});
}
chrome.runtime.onInstalled.addListener(() => configureReminders());
chrome.runtime.onStartup.addListener(() => configureReminders());
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === ALARM) runReminders(); });
chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message?.type !== 'courseflow:configure-reminders') return;
  configureReminders().then(() => reply({ok:true})).catch(e => reply({ok:false,error:e.message}));
  return true;
});

// Automatic MANO observation: only read timetable rows on a currently open
// authenticated MANO tab. A scan writes PROPOSALS ONLY, never lectures.
const MANO_PENDING_KEY='courseflow:mano:pending:v1';
const MANO_DISMISSED_KEY='courseflow:mano:dismissed:v1';
let scanInFlight=new Set();
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  if(message?.type!=='courseflow:mano:scan')return;
  const tab=sender.tab;
  if(!tab?.id||!/^https:\/\/mano\.vilniustech\.lt\/timetable\//i.test(sender.url||tab.url||'')){
    reply({ok:false});return;
  }
  const id=tab.id+':'+sender.frameId;
  if(scanInFlight.has(id)){reply({ok:true,skipped:true});return;}
  scanInFlight.add(id);
  (async()=>{
    const result=await chrome.scripting.executeScript({target:{tabId:tab.id,frameIds:[sender.frameId]},func:captureVisibleLectureDOM});
    const page=result?.[0]?.result;
    if(!page||page.origin!=='https://mano.vilniustech.lt'||!page.rows?.length)return {ok:true,skipped:true};
    const stored=await chrome.storage.local.get([KEY,MANO_PENDING_KEY,MANO_DISMISSED_KEY]);
    const state=stored[KEY]||{};
    const parsed=parseLiveRows(page,[...(state.courses||[]),...(state.manualSubjects||[])],state.events||[],'',state.lectures||[]);
    if(!parsed.classes.length)return {ok:true,skipped:true,recognized:parsed.recognized};
    const classes=parsed.classes.map(x=>({...x,source:'mano'}));
    const fingerprint=JSON.stringify(classes);
    if(stored[MANO_PENDING_KEY]?.fingerprint===fingerprint||stored[MANO_DISMISSED_KEY]===fingerprint)
      return {ok:true,unchanged:true};
    await chrome.storage.local.set({[MANO_PENDING_KEY]:{capturedAt:new Date().toISOString(),classes,fingerprint,
      diagnostics:{recognized:parsed.recognized,rejected:parsed.rejected,unmatched:parsed.unmatched,dated:parsed.dated,undated:parsed.undated}}});
    return {ok:true,detected:classes.length};
  })().then(result=>{scanInFlight.delete(id);reply(result);},e=>{
    scanInFlight.delete(id);reply({ok:false,error:String(e?.message||e).slice(0,180)});
  });
  return true;
});
