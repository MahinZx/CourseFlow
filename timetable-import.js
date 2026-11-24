// PDF/pasted timetable preview: keep source week qualifiers and avoid overlapping
// windows that attach a class time to the following row's subject.
import { parseLectureRows, matchLectureSubject } from './schedule.js';
import { normName, normCode } from './mano.js';
import { validDate, weekdayIndex, addDays } from './lecture-events.js';

const DAYS = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
const DAY_WORD = '(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Pirmadienis|Antradienis|Trečiadienis|Treciadienis|Ketvirtadienis|Penktadienis|Šeštadienis|Sestadienis|Sekmadienis)';
const DAY_LINE = new RegExp(`^\\s*(${DAY_WORD})(?:\\s+(20\\d{2}[-./]\\d{1,2}[-./]\\d{1,2})(?:\\s*[–—-]\\s*(20\\d{2}[-./]\\d{1,2}[-./]\\d{1,2}))?)?\\s*$`, 'gmi');
const ROW_START = /(?:^|\n)\s*([1-7])\s+(\d{1,2}:[0-5]\d)\s*[-–—]\s*(\d{1,2}:[0-5]\d)\b/g;
const SUBJECT_CODE = /\b[A-Z]{2,10}\d{4,8}\b/g;
const ROOM = /\b(?:[A-Z]\d{1,2}\([^)]+\)|[A-Z]\d{1,2}\s*\([^)]+\)|[A-Z]\d{1,2})\s*[A-Z]?\d{1,4}(?:-\d{1,4})?(?=\b|[A-Z][a-z])/;
function isoDate(raw) {
  if (!raw) return '';
  const fields=raw.split(/[-./]/).map(Number);
  const [y,m,d] = fields;
  const value=`${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  return validDate(value) ? value : '';
}
function dayIndex(word) {
  const n=normName(word);
  const map={monday:0,pirmadienis:0,tuesday:1,antradienis:1,wednesday:2,treciadienis:2,thursday:3,ketvirtadienis:3,friday:4,penktadienis:4,saturday:5,sestadienis:5,sunday:6,sekmadienis:6};
  return map[n] ?? -1;
}
function firstDayOnOrAfter(date, day) {
  return addDays(date, (day-weekdayIndex(date)+7)%7);
}
function kindFromRow(row) {
  const n=normName(row);
  if (/\b(laboratory|laboratoriniai|laboratorinis|lab works|lab work)\b/.test(n)) return 'Lab';
  if (/\b(practical|practice|pratybos|seminar)\b/.test(n)) return 'Practice';
  if (/\b(lectures|lecture|paskaita)\b/.test(n)) return 'Lecture';
  return '';
}
function courseForRow(row,courses,events) {
  const codes=[...new Set((row.match(SUBJECT_CODE)||[]).map(normCode))];
  if(codes.length>1)return null; // Never mix adjacent PDF classes.
  return matchLectureSubject(row,courses,events);
}
function rowWithMetadata(day, start, end, content, range, courses, events, group) {
  const subject=courseForRow(content,courses,events);
  if(!subject)return null;
  // The Week column is between the time and the first subject or course code.
  // 1 and 2 represent alternate weeks in this university PDF; their anchor is
  // NOT stated, so do not turn them into fake biweekly appointments.
  const courseName=normName(subject.name);
  const namePosition=courseName.length>12 ? normName(content).indexOf(courseName) : -1;
  const rawPrefix=String(content).split(/\b(?:[A-Z]{2,10}\d{4,8})\b/)[0];
  const beforeName=namePosition>=0 ? normName(content).slice(0,namePosition) : normName(rawPrefix);
  const weekMatch=beforeName.match(/^(?:week\s*)?([12])\s+0\b/);
  const week=weekMatch?Number(weekMatch[1]):null;
  const room=content.match(ROOM)?.[0]||'';
  const record={day,start,end,courseId:subject.id,courseCode:subject.code,
    courseName:subject.name,room,kind:kindFromRow(content),source:'pdf',date:null};
  if (range?.from && range?.to && range.to>=range.from) {
    const days=(Date.parse(range.to+'T12:00:00Z')-Date.parse(range.from+'T12:00:00Z'))/86400000;
    if (days <= 7) {
      const date=firstDayOnOrAfter(range.from,day);
      if(date<=range.to)record.date=date;
    } else if (days<=366 && week==null) {
      const firstDate=firstDayOnOrAfter(range.from,day);
      if (firstDate<=range.to) {
        record.repeat='weekly';record.firstDate=firstDate;record.untilDate=range.to;
        record.weekNote='Estimated weekly pattern · verify changes in Mano';
      }
    }
  }
  if(week!=null) { record.weekNumber=week; record.weekNote=`Week ${week} (alternating) · date anchor unverified`; }
  if(!record.date&&!record.repeat&&!record.weekNote)record.weekNote='Dates not confirmed';
  return record;
}
function parseSemesterTable(text,courses,events,group) {
  // The VILNIUS TECH PDF uses a separate day table, followed by lecture number,
  // time, optional week/subgroup, multi-line subject, room, lecturer and type.
  const headers=[...text.matchAll(DAY_LINE)];
  if(!headers.length)return null;
  const classes=[];let recognizedRows=0;
  for(let h=0;h<headers.length;h++) {
    const header=headers[h],day=dayIndex(header[1]);
    if(day<0)continue;
    const body=text.slice(header.index+header[0].length,headers[h+1]?.index??text.length);
    const first=isoDate(header[2]),last=isoDate(header[3]);
    const range=first ? {from:first,to:last||first} : null;
    const starts=[...body.matchAll(ROW_START)];
    for(let j=0;j<starts.length;j++) {
      const match=starts[j];
      const content=body.slice(match.index+match[0].length,starts[j+1]?.index??body.length).trim();
      // Reject fragments with no real timetable subject; do not pull a subject
      // across the next lecture's time or a new weekday heading.
      if(!content)continue;
      recognizedRows++;
      const start=match[2].padStart(5,'0'),end=match[3].padStart(5,'0');
      if(end<=start)continue;
      const record=rowWithMetadata(day,start,end,content,range,courses,events,group);
      if(record)classes.push(record);
    }
  }
  // Return even an empty recognized table: don't run the old window-scanner on
  // structured university data, where it creates bogus cross-row matches.
  return recognizedRows ? classes : null;
}
function parseSimplePastedRows(text,courses,events,group) {
  const source=text.split(/\n/).map(x=>x.replace(/\s+/g,' ').trim()).filter(Boolean);
  const candidates=[];
  for(let i=0;i<source.length;i++){
    const line=source[i],day=new RegExp(`\\b${DAY_WORD}\\b`,'i').exec(line);
    if(!day)continue;
    // Prefer the complete same-line row; only join following lines when the
    // day line is a standalone label. Never join two different course rows.
    let check=line;
    if(!/\b\d{1,2}:[0-5]\d\b/.test(check)||!courseForRow(check,courses,events)) {
      if(/^\s*[^\d]*$/.test(line)) check=[line,source[i+1],source[i+2]].filter(Boolean).join(' ');
    }
    if(!/\b\d{1,2}:[0-5]\d\b/.test(check))continue;
    if(!courseForRow(check,courses,events))continue;
    candidates.push([day[0],check]);
  }
  return parseLectureRows(candidates,courses,events,group);
}
export function proposeTimetable(text,courses=[],events=[],group='') {
  const source=String(text||'').replace(/\r/g,'').replace(/\u0000/g,'').replace(/\u0014/g,'—');
  if(source.length>500_000||source.split('\n').length>8000)throw new Error('Timetable text is too long. Import a shorter PDF.');
  const structured=parseSemesterTable(source,courses,events,group);
  const classes=structured??parseSimplePastedRows(source,courses,events,group);
  const found=new Map();
  for(const c of classes){
    const key=`${c.courseId}:${c.day}:${c.start}:${c.date||''}:${c.weekNumber||''}`;
    if(!found.has(key))found.set(key,c);
  }
  return {classes:[...found.values()].sort((a,b)=>a.day-b.day||a.start.localeCompare(b.start)),lineCount:source.split('\n').length};
}
export function classesEqual(a,b) {
  return a.day===b.day&&a.start===b.start&&String(a.courseId)===String(b.courseId)&&
    (a.date||'')===(b.date||'')&&(a.room||'')===(b.room||'')&&
    (a.source||'')===(b.source||'')&&(a.repeat||'')===(b.repeat||'')&&
    (a.firstDate||'')===(b.firstDate||'')&&(a.untilDate||'')===(b.untilDate||'')&&
    (a.weekNumber||'')===(b.weekNumber||'');
}
export function mergeClasses(previous=[],incoming=[]) {
  const entries=[...previous];
  for(const row of incoming){const i=entries.findIndex(old=>classesEqual(old,row));if(i<0)entries.push(row);else entries[i]=row;}
  return entries.sort((a,b)=>a.day-b.day||a.start.localeCompare(b.start));
}
