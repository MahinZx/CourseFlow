import { MOODLE } from './model.js';

const MAX_COURSES = 24;
const MAX_ASSIGNMENTS = 100;
const MAX_PARALLEL = 3;
const utcNow = () => new Date().toISOString();

// If Moodle's SSO cookies are blocked in an extension-origin fetch, fall back to
// an existing, signed-in Moodle browser tab. This is the *student's own session*;
// we never read, store, export, or transmit Moodle cookies or passwords.
async function requestViaMoodleTab(path, { method = 'GET', body = null, headers = {} } = {}) {
  if (typeof chrome === 'undefined' || !chrome.scripting?.executeScript || !chrome.tabs?.query) return null;
  let tabs;
  try { tabs = await chrome.tabs.query({ url: `${MOODLE}/*` }); }
  catch { return null; }
  for (const tab of tabs) {
    if (!tab.id) continue;
    try {
      const injected = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: async ({ path, method, body, headers }) => {
          const target = new URL(path, location.origin);
          if (target.origin !== location.origin) throw new Error('Unexpected origin');
          const response = await fetch(target.toString(), {
            method, body: method === 'POST' ? body : undefined,
            headers, credentials: 'same-origin', cache: 'no-store', redirect: 'follow'
          });
          return { ok: response.ok, status: response.status, url: response.url, text: await response.text() };
        },
        args: [{ path, method, body, headers }]
      });
      const result = injected?.[0]?.result;
      if (result?.ok && result.url?.startsWith(MOODLE + '/')) return result;
    } catch { /* The tab may be loading, unresponsive, or signed out. */ }
  }
  return null;
}

async function getHtml(path) {
  let resource = null;
  try {
    const response = await fetch(`${MOODLE}${path}`, {
      credentials: 'include', cache: 'no-store', redirect: 'follow'
    });
    if (response.ok && response.url.startsWith(MOODLE + '/')) {
      const content = await response.text();
      if (!/<form[^>]*id=["']login["']|<title>[^<]*single sign on/i.test(content)) {
        resource = { text: content };
      }
    }
  } catch { /* Try the signed-in Moodle tab, if present. */ }
  if (!resource) resource = await requestViaMoodleTab(path);
  if (!resource) {
    throw new Error('Cannot read Moodle. Keep an authenticated Moodle tab open in Chrome and click Sync now.');
  }
  return new DOMParser().parseFromString(resource.text, 'text/html');
}

function getSesskey(doc) {
  const scripts = Array.from(doc.scripts).map(s => s.textContent).join(' ');
  return doc.querySelector('input[name="sesskey"]')?.value ||
    scripts.match(/["']sesskey["']\s*:\s*["']([A-Za-z0-9]+)["']/)?.[1] ||
    scripts.match(/sesskey\s*=\s*["']([A-Za-z0-9]+)["']/)?.[1] || '';
}

async function moodleAjax(sesskey, methodname, args) {
  const path = `/lib/ajax/service.php?sesskey=${encodeURIComponent(sesskey)}&info=${encodeURIComponent(methodname)}`;
  const body = JSON.stringify([{ index: 0, methodname, args }]);
  let content;
  try {
    const response = await fetch(`${MOODLE}${path}`, {
      method: 'POST', cache: 'no-store', credentials: 'include',
      headers: { 'Content-Type': 'application/json' }, body
    });
    if (response.ok) content = await response.text();
  } catch { /* Prefer browser-tab fetch if cross-origin SSO cookies are blocked. */ }
  if (!content) {
    const fallback = await requestViaMoodleTab(path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body
    });
    content = fallback?.text;
  }
  if (!content) throw new Error('Moodle AJAX course discovery was not available.');
  const result = JSON.parse(content);
  const first = Array.isArray(result) ? result[0] : result;
  if (first?.error) throw new Error(first.exception?.message || first.message || 'Course discovery is unavailable.');
  return first?.data ?? first;
}

function extractCode(value) {
  return (String(value || '').match(/\b[A-Z]{3,8}\d{4,7}\b/) || [])[0] || '';
}

function normalizeCourses(input) {
  const map = new Map();
  for (const course of input) {
    const id = Number(course.id);
    if (!Number.isSafeInteger(id) || id < 1) continue;
    const name = String(course.fullname || course.name || course.shortname || `Course ${id}`).trim();
    const shortname = String(course.shortname || '').trim();
    map.set(String(id), { id, name, shortname, code: extractCode(shortname) || extractCode(name), url: `${MOODLE}/course/view.php?id=${id}` });
  }
  return [...map.values()];
}

function coursesFromHtml(doc) {
  const links = Array.from(doc.querySelectorAll('a[href*="/course/view.php?id="]'));
  const result = [];
  for (const link of links) {
    let id;
    try { id = new URL(link.href, MOODLE).searchParams.get('id'); } catch { continue; }
    const name = (link.querySelector('.coursename')?.textContent || link.textContent || '').trim();
    if (id && name.length > 3) result.push({ id: Number(id), fullname: name, shortname: name });
  }
  return normalizeCourses(result);
}

export async function discoverCourses() {
  const doc = await getHtml('/my/courses.php');
  const sesskey = getSesskey(doc);
  let courses = [];
  if (sesskey) {
    for (const classification of ['inprogress', 'all']) {
      try {
        const response = await moodleAjax(sesskey, 'core_course_get_enrolled_courses_by_timeline_classification', {
          classification, limit: 0, offset: 0, sort: 'fullname'
        });
        const raw = Array.isArray(response) ? response : (response.courses || []);
        courses = normalizeCourses(raw);
        if (courses.length) break;
      } catch { /* Fall back to server-rendered course links. */ }
    }
  }
  if (!courses.length) courses = coursesFromHtml(doc);
  if (!courses.length) {
    throw new Error('Signed in, but Moodle did not return a course list. Open “My courses” in Moodle, then try again.');
  }
  return courses.slice(0, MAX_COURSES);
}

function safeAssignmentHref(href) {
  try {
    const url = new URL(href, MOODLE);
    if (url.origin !== MOODLE || url.pathname !== '/mod/assign/view.php') return null;
    const id = Number(url.searchParams.get('id'));
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    return { id, url: `${MOODLE}/mod/assign/view.php?id=${id}` };
  } catch { return null; }
}

export function parseAssignmentLinks(doc, courseId) {
  const result = new Map();
  const links = doc.querySelectorAll('a[href*="/mod/assign/view.php"]');
  for (const link of links) {
    const ref = safeAssignmentHref(link.getAttribute('href') || '');
    if (!ref) continue;
    const wrapper = link.closest('tr, .activity, li.activity, .modtype_assign');
    const name = String(link.querySelector('.instancename')?.textContent || link.textContent || '').replace(/\s*Assignment\s*$/i, '').trim();
    if (!name || name.length > 230) continue;
    // Prefer a name from the activity row. Dates in index tables vary by Moodle theme;
    // use the verified calendar feed for canonical due dates instead.
    result.set(ref.id, { id: ref.id, courseId, name, url: ref.url, status: 'unknown', checkedAt: null });
  }
  return [...result.values()];
}

export function readSubmissionStatus(doc) {
  // Moodle adds language-independent status classes to submission rows.
  const summary = doc.querySelector('.submissionsummarytable, .submissionstatustable, #region-main');
  if (!summary) return 'unknown';
  if (summary.querySelector('.submissionstatussubmitted')) return 'submitted';
  if (summary.querySelector('.submissionstatusdraft, .submissionstatusreopened')) return 'draft';
  if (summary.querySelector('.submissionstatusnew')) return 'not-submitted';
  const rows = summary.querySelectorAll('tr');
  for (const row of rows) {
    const cells = row.querySelectorAll('td, th');
    if (cells.length < 2) continue;
    const label = (cells[0].textContent || '').toLowerCase().trim();
    const value = (cells[1].textContent || '').toLowerCase().trim();
    if (!/submission status|pateikimo b[uū]sena|pateikimo statusas/.test(label)) continue;
    if (/submitted for grading|pateikta vertinti|pateikta vertinimui/.test(value)) return 'submitted';
    if (/draft|juodraštis|juodrastis/.test(value)) return 'draft';
    if (/no submission|not submitted|nepateikta|nepateiktas/.test(value)) return 'not-submitted';
  }
  return 'unknown';
}

async function getAssignmentsForCourse(course) {
  let found = [];
  try {
    found = parseAssignmentLinks(await getHtml(`/mod/assign/index.php?id=${course.id}`), course.id);
  } catch { /* Some universities disable the assignment index; read course page. */ }
  if (!found.length) {
    try { found = parseAssignmentLinks(await getHtml(`/course/view.php?id=${course.id}`), course.id); }
    catch { /* The course may be inaccessible or not yet published. */ }
  }
  return found;
}

async function runPool(items, maxParallel, work, progress) {
  let cursor = 0;
  const results = new Array(items.length);
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      try { results[i] = await work(items[i]); }
      catch { results[i] = items[i]; }
      progress?.(i + 1, items.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(maxParallel, items.length) }, worker));
  return results;
}

export async function scanMoodle(progress) {
  const courses = await discoverCourses();
  progress?.(`Found ${courses.length} course${courses.length === 1 ? '' : 's'}. Looking for assignments…`);
  const byCourse = await runPool(courses, MAX_PARALLEL, getAssignmentsForCourse);
  const map = new Map();
  for (const group of byCourse) for (const item of (Array.isArray(group) ? group : [])) map.set(item.id, item);
  const assignments = [...map.values()].slice(0, MAX_ASSIGNMENTS);
  if (!assignments.length) {
    progress?.('Courses loaded, but no standard Moodle assignment activities were found.');
  }
  let checked = 0;
  progress?.(`Checking ${assignments.length} assignment status pages…`);
  const result = await runPool(assignments, MAX_PARALLEL, async (item) => {
    const doc = await getHtml(`/mod/assign/view.php?id=${item.id}`);
    const status = readSubmissionStatus(doc);
    checked++;
    progress?.(`Checked ${checked} of ${assignments.length} assignments…`);
    return { ...item, status, checkedAt: utcNow() };
  });
  const statuses = result.filter(a => a.status !== 'unknown').length;
  return { courses, assignments: result, verified: statuses, lastStatusSync: utcNow() };
}
