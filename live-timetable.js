// Read-only capture of an authenticated Mano timetable tab.
// Page DOM layout is not publicly inspectable (SSO), so capture is conservative:
// only a user-triggered scan of visible timetable rows, never credentials or HTML.
import { MANO, normName, normCode } from './mano.js';
import { matchLectureSubject } from './schedule.js';
import { addDays, validDate, weekdayIndex } from './lecture-events.js';
const DAY_NAMES=[
  ['monday','mon','pirmadienis','pr'],
  ['tuesday','tue','antradienis','an'],
  ['wednesday','wed','treciadienis','tr'],
  ['thursday','thu','ketvirtadienis','kt'],
  ['friday','fri','penktadienis','pn'],
  ['saturday','sat','sestadienis','st'],
  ['sunday','sun','sekmadienis','sk']
];
const STANDARD_SLOTS=[null,['08:30','10:05'],['10:20','11:55'],['12:10','13:45'],['14:30','16:05'],['16:20','17:55'],['18:10','19:45'],['19:55','21:30']];
const DATE_PATTERN=/\b(?:20\d{2}[-./]\d{1,2}[-./]\d{1,2}|\d{1,2}[-./]\d{1,2}[-./]20\d{2})\b/g;
const TIME_PATTERN=/(?:^|[^\d])([01]?\d|2[0-3])[:.]([0-5]\d)(?!\d)/g;
function clean(s){return String(s||'').replace(/\s+/g,' ').trim();}
export function parseHumanDate(s){
  const text=clean(s), matches=[...text.matchAll(DATE_PATTERN)];
  for(const m of matches){
    const nums=m[0].split(/[-./]/).map(Number);
    const [y,mo,d]=nums[0]>1000 ? nums : [nums[2],nums[1],nums[0]];
    const iso=`${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    if(validDate(iso))return iso;
  }
  return null;
}
export function dateRangeFromHeader(text){
  const dates=[...String(text||'').matchAll(DATE_PATTERN)].map(m=>parseHumanDate(m[0])).filter(Boolean);
  if (dates.length>=2) {
    const a=dates[0],b=dates[1];
    const days=(Date.parse(b+'T12:00:00Z')-Date.parse(a+'T12:00:00Z'))/86400000;
    if(days>=4 && days<=7) return {start:addDays(a,-weekdayIndex(a)),end:b};
  }
  if (/\b(?:week of|week starting|savaite|savaites pradzia|nuo savaites)\b/i.test(normName(text)) && dates.length) {
    const a=dates[0];return {start:addDays(a,-weekdayIndex(a)),end:addDays(a,6-weekdayIndex(a))};
  }
  return null;
}
export function findDay(text){
  const norm=normName(text);
  for(let i=0;i<7;i++) if(DAY_NAMES[i].some(w=>new RegExp(`(?:^| )${w}(?: |$)`).test(norm))) return i;
  return -1;
}
function times(text){
  const withoutDates=clean(text).replace(DATE_PATTERN,' ');
  const found=[...withoutDates.matchAll(TIME_PATTERN)].map(m=>`${m[1].padStart(2,'0')}:${m[2]}`);
  if(!found.length) return null;
  return {start:found[0],end:found.find((t,i)=>i>0&&t>found[0]) || null};
}
function slotNumber(cells){
  for(const raw of cells){
    const s=clean(raw);
    const m=s.match(/^(?:([1-7])\s*(?:paskaita|lecture|pair|pora|slot)?|(?:lecture|paskaita|slot)\s*([1-7]))$/i);
    if(m)return Number(m[1]||m[2]);
  }
  return 0;
}
function extractRoom(text, headers=[], cells=[]){
  const index=headers.findIndex(h=>/\b(room|auditorium|auditorija|cabinet|classroom|vieta|kabinetas)\b/i.test(normName(h)));
  if(index>=0 && cells[index]) return clean(cells[index]).slice(0,65);
  return (text.match(/\b(?:[A-Z]\d{1,2}\([^)]{1,18}\)|[A-Z]\d{1,2}|[A-Z]{2,8}-[IVX]+)\s+[A-Z]?\d{2,4}\b/i)||[])[0]||'';
}
function semesterRangeFromDayHeader(value) {
  const dates=[...String(value||'').matchAll(DATE_PATTERN)].map(m=>parseHumanDate(m[0])).filter(Boolean);
  if(dates.length<2)return null;
  const span=(Date.parse(dates[1]+'T12:00:00Z')-Date.parse(dates[0]+'T12:00:00Z'))/86400000;
  return span>7&&span<=366?{first:dates[0],last:dates[1]}:null;
}
function nextWeekday(from,day){return addDays(from,(day-weekdayIndex(from)+7)%7);}
function classKind(text){
  const n=normName(text);
  if(/\b(laboratorinis|laboratory|lab work|lab)\b/.test(n)) return 'Lab';
  if(/\b(pratybos|practice|practical|exercise|seminar)\b/.test(n)) return 'Practice';
  if(/\b(lecture|paskaita|lectures)\b/.test(n)) return 'Lecture';
  return '';
}
// Cross-reference an already saved local class ONLY when subject plus time,
// room or class type make one timetable row unambiguous. This is not proof of
// a MANO date and is always labelled as a local PDF/manual inference.
export function matchSavedTimetableRow(subject, time, room, kind, saved=[], week=null) {
  const options=saved.filter(c=>
    ['pdf','manual'].includes(c.source) &&
    (String(c.courseId)===String(subject.id) || Boolean(subject.code&&c.courseCode&&normCode(c.courseCode)===normCode(subject.code))) &&
    Number.isInteger(Number(c.day)) && Number(c.day)>=0 && Number(c.day)<7 && c.start &&
    (!time?.start || c.start===time.start) &&
    (!kind || !c.kind || c.kind===kind) &&
    (!room || !c.room || normName(room)===normName(c.room)) &&
    (week==null || Number(c.weekNumber)===week)
  );
  // Without time, room+kind are required (course name alone is not enough).
  if (!time?.start && !(room&&kind)) return null;
  // Distinguish repeated rows by exact semester/alternate-week signature.
  const signatures=new Map(options.map(c=>[`${c.day}:${c.start}:${c.kind||''}:${c.room||''}:${c.weekNumber||''}`,c]));
  return signatures.size===1?[...signatures.values()][0]:null;
}
export function parseLiveRows(payload, courses=[], events=[], group='', saved=[]) {
  if (!payload || !Array.isArray(payload.rows)) return {classes:[],rejected:0,unmatched:0,dated:0,undated:0,weekStart:null,fullWeek:false};
  const range=dateRangeFromHeader((payload.headings||[]).join(' '));
  const found=new Map();let rejected=0,unmatched=0,recognized=0,matchedFromSaved=0,missingDay=0,missingTime=0;
  for (const item of payload.rows.slice(0,600)) {
    const cells=(Array.isArray(item) ? item : item.cells||[]).map(clean);
    if(!cells.length)continue;
    const text=cells.join(' · ');
    let subject=matchLectureSubject(text,courses,events);
    if(!subject){
      // MANO is independently authoritative for the subject code and title;
      // a PDF or matching Moodle subject is NOT required for first import.
      const index=(Array.isArray(item.headers)?item.headers:[]).findIndex(h=>/\b(subject|dalykas|module|modulis)\b/i.test(normName(h)));
      const subjectText=index>=0?cells[index]:(cells.find(c=>/\b[A-Z]{2,10}\d{4,8}\b/.test(c))||'');
      const codes=[...new Set([...subjectText.matchAll(/\b[A-Z]{2,10}\d{4,8}\b/g)].map(m=>m[0]))];
      const name=subjectText.replace(/\([A-Z]{2,10}\d{4,8}\)/g,'').replace(/\b[A-Z]{2,10}\d{4,8}\b/g,'').replace(/\s+/g,' ').trim();
      if(codes.length===1 && name.length>=4)subject={id:`mano-${codes[0]}`,code:codes[0],name:name.slice(0,140)};
    }
    if(!subject){unmatched++;continue;}
    recognized++;
    // Reject a combined/ambiguous cell containing multiple course codes.
    const recognizedCodes=[...new Set([...text.matchAll(/\b[A-Z]{2,10}\d{4,8}\b/g)].map(m=>m[0]))];
    if(recognizedCodes.length>1 && recognizedCodes.some(c=>c!==normCode(subject.code))){rejected++;continue;}
    const header=Array.isArray(item.headers)?item.headers.map(clean):[];
    const groupColumn=header.findIndex(h=>/\b(group|grupe|studentu grupe)\b/i.test(normName(h)));
    if(group && groupColumn>=0 && cells[groupColumn]){
      const expected=normName(group).replace(/ /g,'');
      const printed=normName(cells[groupColumn]).replace(/ /g,'');
      if(expected && !printed.includes(expected)){rejected++;continue;}
    }
    const context=[item.dayHeader,item.dateHeader,item.sectionHeader].map(clean).filter(Boolean);
    const all=[...context,...cells];
    let date=null;
    // A semester-wide day heading such as "Tuesday 2026-09-01 — 2026-12-20"
    // describes a recurring timetable, not an individual session on Sep 1.
    // Never accept its first date as this Tuesday's lesson date.
    for(const c of [item.dateHeader,item.dayHeader,...cells]){
      const dates=[...String(c||'').matchAll(DATE_PATTERN)].map(m=>parseHumanDate(m[0])).filter(Boolean);
      if(dates.length>=2){
        const span=(Date.parse(dates[1]+'T12:00:00Z')-Date.parse(dates[0]+'T12:00:00Z'))/86400000;
        if(span>7)continue;
      }
      date=parseHumanDate(c);if(date)break;
    }
    let day=-1;
    for(const c of all){day=findDay(c);if(day>=0)break;}
    if(day<0 && date)day=weekdayIndex(date);
    let timing=null;
    // Prefer the dedicated time column or cell, not a room number or full-day heading.
    const ti=header.findIndex(h=>/\b(time|laikas|valanda|start|period)\b/i.test(normName(h)));
    if(ti>=0 && cells[ti])timing=times(cells[ti]);
    if(!timing)for (const c of cells){const t=times(c);if(t){timing=t;break;}}
    if(!timing){const slot=slotNumber(cells);if(slot)timing={start:STANDARD_SLOTS[slot][0],end:STANDARD_SLOTS[slot][1]};}
    const room=extractRoom(text,header,cells);
    const kind=classKind(text);
    const weekCol=header.findIndex(h=>/^(?:week|savaite|savaites)$/.test(normName(h)));
    const weekNumber=weekCol>=0&&/^[12]$/.test(cells[weekCol]||'')?Number(cells[weekCol]):null;
    const subgroupCol=header.findIndex(h=>/^(?:subgroup|pogrupis)$/.test(normName(h)));
    const subgroup=subgroupCol>=0?String(cells[subgroupCol]||'').trim():'';
    const reference=(day<0||!timing) ? matchSavedTimetableRow(subject,timing,room,kind,saved,weekNumber) : null;
    if(day<0 && reference) day=Number(reference.day);
    if(!timing && reference)timing={start:reference.start,end:reference.end||null};
    if(day<0){missingDay++;rejected++;continue;}
    if(!timing){missingTime++;rejected++;continue;}
    // Do not infer exact dates from historical PDFs. The only permitted dated
    // values are the current MANO page's own date or explicit displayed week.
    if(!date && range)date=addDays(range.start,day);
    if(date && weekdayIndex(date)!==day){rejected++;continue;}
    if(reference) matchedFromSaved++;
    const semester=!date?semesterRangeFromDayHeader([item.sectionHeader,item.dayHeader].filter(Boolean).join(' ')):null;
    // Every class is linked to a confirmed Moodle subject, never page-wide unrelated rows.
    const c={day,start:timing.start,end:timing.end,date:date||null,room,
      courseId:subject.id,courseCode:subject.code,courseName:subject.name,
      source:'mano',kind,subgroup,capturedGroup:group||'',weekNote:date?'':(/\b(?:odd|even|nelygin|lygin|week a|week b)\b/i.test(normName(text))?'Week pattern unverified':''),
      weekStart:date?addDays(date,-weekdayIndex(date)):null};
    if(!date && (weekNumber!=null || reference?.weekNumber!=null)){
      c.weekNumber=weekNumber??reference.weekNumber;
      c.weekNote=`Week ${c.weekNumber} (alternating) · date anchor unverified`;
    } else if(!date&&semester){
      const firstDate=nextWeekday(semester.first,day);
      if(firstDate<=semester.last){
        c.repeat='weekly';c.firstDate=firstDate;c.untilDate=semester.last;
        c.weekNote='Estimated from Mano semester pattern · verify changes';
      }
    } else if(!date && reference?.repeat==='weekly' && validDate(reference.firstDate) && validDate(reference.untilDate)){
      c.repeat='weekly';c.firstDate=reference.firstDate;c.untilDate=reference.untilDate;
    }
    if (reference && !date) {
      c.crossCheckedWith=reference.source;
      c.weekNote=[c.weekNote,`Weekday matched to saved ${reference.source.toUpperCase()} (not date-verified by Mano)`].filter(Boolean).join(' · ');
    }
    const key=`${c.courseId}:${c.date||'undated'}:${c.day}:${c.start}:${c.source}:${c.weekNumber||''}:${c.kind||''}:${c.subgroup||''}`;
    // Last duplicate takes the most detailed room, but never synthesize new classes.
    if (!found.has(key)||(!found.get(key).room&&c.room)) found.set(key,c);
  }
  const classes=[...found.values()].sort((a,b)=>(a.date||'').localeCompare(b.date||'')||a.day-b.day||a.start.localeCompare(b.start));
  return {classes,unmatched,recognized,rejected,matchedFromSaved,missingDay,missingTime,dated:classes.filter(c=>c.date).length,undated:classes.filter(c=>!c.date).length,
    weekStart:range?.start||null,fullWeek:Boolean(payload.fullWeek && range)};
}

// Executed only in the user's signed-in Mano tab after clicking Capture.
// Deliberately does not read input values, scripts, cookies, document HTML or tokens.
export function captureVisibleLectureDOM() {
  const compact=x=>String(x||'').replace(/\s+/g,' ').trim().slice(0,450);
  const text=x=>compact(x?.innerText||x?.textContent||'');
  const isVisible=x=>!x.closest('[hidden],[aria-hidden="true"]') && x.getClientRects().length>0;
  const dateOrWeek=/\b(?:20\d{2}[-./]\d{1,2}[-./]\d{1,2}|\d{1,2}[-./]\d{1,2}[-./]20\d{2}|week|savait|timetab|tvarkara|schedule)\b/i;
  const headings=[...document.querySelectorAll('h1,h2,h3,h4,h5,caption,legend,.fc-toolbar-title,.week-title,.week-range')]
    .filter(x=>isVisible(x)&&dateOrWeek.test(text(x))).slice(0,18).map(text);
  const rows=[];let fullWeek=false;
  const dayWord=/(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|pirmadien|antradien|trečiadien|treciadien|ketvirtadien|penktadien|šeštadien|sestadien|sekmadien)/i;
  const dayHeader=/(?:^|\s)(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|pirmadien|antradien|trečiadien|treciadien|ketvirtadien|penktadien|šeštadien|sestadien|sekmadien)/i;
  // MANO sometimes renders weekday labels as plain DIV or SPAN siblings,
  // not semantic headings. Only accept short, visible, standalone day labels.
  const candidateLabel=x=>{
    const value=text(x);
    return value.length>0 && value.length<120 && dayHeader.test(value) &&
      (x.children.length<3 || /^(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|pirmadien|antradien|trečiadien|treciadien|ketvirtadien|penktadien|šeštadien|sestadien|sekmadien)/i.test(value));
  };
  const labels=[...document.querySelectorAll('h1,h2,h3,h4,h5,caption,.day-heading,.day-title,.weekday,.timetable-day,div,span,strong,b,legend')]
    .filter(isVisible).filter(candidateLabel).slice(0,180);
  // Semester date ranges can be separate headings above weekday tables.
  const rangeLabels=[...document.querySelectorAll('h1,h2,h3,h4,h5,caption,strong,div')]
    .filter(isVisible).filter(x=>{const t=text(x);return t.length<110 && /20\d{2}[.\/-]\d{1,2}[.\/-]\d{1,2}\s*[-–—]\s*20\d{2}[.\/-]\d{1,2}[.\/-]\d{1,2}/.test(t);}).slice(0,100);
  const closestRangeFor=table=>{
    const before=rangeLabels.filter(x=>x!==table && (x.compareDocumentPosition(table)&4));
    return before.length?text(before.at(-1)):'';
  };
  const closestDayFor=table=>{
    // The Mano semester timetable can display one separate table under each
    // weekday. Plain rows don't repeat the day in any column.
    const parent=table.closest('section,article,.day,.panel,.card');
    if(parent){
      const own=[...parent.querySelectorAll('h1,h2,h3,h4,h5,.day-heading,.day-title')]
        .filter(isVisible).filter(x=>dayHeader.test(text(x)) && (x.compareDocumentPosition(table)&4));
      if(own.length)return text(own.at(-1));
    }
    // Prefer the nearest day label in DOM order. A preceding DIV is common
    // in Mano's timetable, while the table rows themselves contain no day.
    const before=labels.filter(x=>x!==table && (x.compareDocumentPosition(table)&4));
    return before.length?text(before.at(-1)):'';
  };
  for(const table of [...document.querySelectorAll('table')].filter(isVisible).slice(0,14)) {
    const trs=[...table.querySelectorAll('tr')].filter(isVisible).slice(0,200);
    const sectionDay=closestDayFor(table);
    const sectionRange=closestRangeFor(table);
    const headerTr=trs.find(r=>r.querySelector('th'))||trs[0];
    const heads=headerTr?[...headerTr.children].filter(e=>/^(TD|TH)$/.test(e.tagName)).map(text):[];
    const dayColumns=heads.map((v,i)=>i>0&&(dayWord.test(v)||/(?:20\d{2}[-./]\d{1,2}[-./]\d{1,2}|\d{1,2}[-./]\d{1,2}[-./]20\d{2})/.test(v))?i:-1).filter(i=>i>=0);
    if(dayColumns.length>=3)fullWeek=true;
    for(const tr of trs){
      if(tr===headerTr&&tr.querySelector('th'))continue;
      const elements=[...tr.children].filter(e=>/^(TD|TH)$/.test(e.tagName));
      // A merged grid cell cannot safely be aligned to an individual weekday.
      if(dayColumns.length && elements.some(e=>e.colSpan>1||e.rowSpan>1))continue;
      const cells=elements.map(text);
      if(cells.length<2)continue;
      if(dayColumns.length){
        for(const col of dayColumns){
          // Only map simple aligned matrices. Irregular row/col-spans must be manually reviewed.
          if(col>=cells.length || !cells[col])continue;
          rows.push({cells:[cells[0],cells[col]],dayHeader:heads[col],dateHeader:heads[col],headers:['Time','Subject']});
        }
      }else rows.push({cells,headers:heads,dayHeader:sectionDay,sectionHeader:sectionRange?`${sectionDay} ${sectionRange}`:sectionDay});
      if(rows.length>=600)break;
    }
  }
  // Many frameworks use accessible role-based tables instead of HTML <table>.
  if(rows.length<600)for(const tr of document.querySelectorAll('[role="row"],mat-row,.k-master-row')) {
    if(!isVisible(tr))continue;
    // Rows in accessible tables may also inherit a weekday from the nearest
    // preceding heading rather than containing it as a cell.
    const dayLabels=labels.filter(x=>x.compareDocumentPosition(tr)&4);
    const day=dayLabels.length?text(dayLabels.at(-1)):'';
    const cells=[...tr.querySelectorAll('[role="cell"],mat-cell,.k-table-td')].filter(isVisible).map(text);
    if(cells.length>=2)rows.push({cells,dayHeader:day,sectionHeader:day});
    if(rows.length>=600)break;
  }
  return {origin:location.origin,path:location.pathname,headings,rows:rows.slice(0,600),fullWeek};
}
export async function scanLiveTimetable(courses=[],events=[],group='',saved=[]){
  if(typeof chrome==='undefined'||!chrome.tabs?.query||!chrome.scripting?.executeScript)
    throw new Error('Install CourseFlow in Chrome to capture the signed-in Mano timetable.');
  const tabs=await chrome.tabs.query({url:`${MANO}/*`});
  const candidates=tabs.filter(t=>t.id && /\/timetable\//i.test(t.url||'') && !/examstimetable/i.test(t.url||''));
  if(!candidates.length)throw new Error('Open the Mano lecture timetable search page, sign in, select your group and display the schedule.');
  let error='No readable class rows were found. Choose the group and display the MANO timetable.';
  for(const tab of candidates){
    try{
      const results=await chrome.scripting.executeScript({target:{tabId:tab.id,allFrames:true},func:captureVisibleLectureDOM});
      const pages=(results||[]).map(r=>r?.result).filter(page=>page?.origin===MANO && /^\/timetable\//.test(page.path||''));
      // Choose the frame with the most matched classes rather than mixing overlapping frame data.
      const matches=pages.map(page=>({page,parsed:parseLiveRows(page,courses,events,group,saved)}))
        .sort((a,b)=>b.parsed.classes.length-a.parsed.classes.length);
      const best=matches[0];
      if(best?.parsed.classes.length)return {...best.parsed,scannedAt:new Date().toISOString()};
      const total=pages.reduce((n,p)=>n+(p.rows?.length||0),0);
      const recognized=matches.reduce((n,p)=>n+(p.parsed.recognized||0),0);
      const missingDay=matches.reduce((n,p)=>n+(p.parsed.missingDay||0),0);
      const missingTime=matches.reduce((n,p)=>n+(p.parsed.missingTime||0),0);
      error=recognized
        ? `${recognized} known-subject rows found, but ${missingDay} lack a readable weekday and ${missingTime} lack a class time. Display the weekday headings on MANO, then capture again. Existing classes were not changed.`
        : `Found ${total} visible timetable rows, but could not extract subject codes and titles. Check the selected MANO timetable. Saved classes remain intact.`;
    }catch(e){error=e.message||error;}
  }
  throw new Error(error);
}
export function mergeManoCapture(previous=[],incoming=[],scope={}){
  // A captured week can replace that same previously captured group/week, never another week's or manual data.
  const incomingIds=new Set(incoming.map(x=>`${x.courseId}:${x.date||''}:${x.day}:${x.start}:${x.source}:${x.weekNumber||''}`));
  const pdfCounterparts=new Set(incoming.filter(c=>c.crossCheckedWith==='pdf'&&!c.date)
    .map(c=>`${c.courseId}:${c.day}:${c.start}:${c.weekNumber||''}:${normName(c.room)}`));
  let keep=previous.filter(c=>{
    // Replace an identical PDF-based class only when Mano's row was explicitly
    // cross-checked against it. Do not double-count 12 PDF + 12 Mano classes.
    if(c.source==='pdf' && pdfCounterparts.has(`${c.courseId}:${c.day}:${c.start}:${c.weekNumber||''}:${normName(c.room)}`))return false;
    if(c.source!=='mano')return true;
    if(scope.fullWeek && scope.weekStart && c.weekStart===scope.weekStart && (c.capturedGroup||'')===(scope.group||''))return false;
    return !incomingIds.has(`${c.courseId}:${c.date||''}:${c.day}:${c.start}:${c.source}:${c.weekNumber||''}`);
  });
  // No broad timetable deletion when page isn't proven to show a whole week.
  keep.push(...incoming);
  const unique=new Map();
  for(const c of keep){unique.set(`${c.source}:${c.courseId}:${c.date||'undated'}:${c.day}:${c.start}:${c.weekNumber||''}`,c);}
  return [...unique.values()].sort((a,b)=>(a.date||'').localeCompare(b.date||'')||a.day-b.day||a.start.localeCompare(b.start));
}
