# CourseFlow

CourseFlow is a Chrome extension that brings VILNIUS TECH Moodle coursework, MANO timetables, exam dates, and personal study tasks into one dashboard.

## What it does

- Tracks coursework and exam dates from Moodle calendar data.
- Reads a timetable from the signed-in MANO page and lets you review changes before applying them.
- Shows your next class, today's schedule, and upcoming deadlines.
- Supports PDF timetable imports, manually added classes, and personal tasks.
- Keeps previous timetable entries when a new capture is incomplete.
- Offers local backups and optional deadline reminders.

## Install in Chrome

1. Click **Code → Download ZIP** on GitHub, then extract it into a folder you will keep (for example, `Documents/CourseFlow`).
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top-right corner).
4. Click **Load unpacked** and select the extracted folder containing `manifest.json` (not the ZIP file).
5. Open Chrome's **Extensions** menu (puzzle icon), pin **CourseFlow**, then click it to open the dashboard.

To update an existing installation, export a backup in **CourseFlow → Settings**, replace the files in the same installed folder, then click **Reload** in `chrome://extensions`. Do not remove the extension first: Chrome saves extension data against its extension ID.

## Using CourseFlow

Open **Settings** to connect your Moodle calendar or import an `.ics` file. For classes, open your university MANO timetable in the same Chrome profile, sign in, select your group, and display the schedule. CourseFlow detects the visible timetable. Return to **Timetable** to review new or changed entries and approve only what you want to keep. You can also add classes and tasks manually.

MANO Week 1/2 classes need a confirmed academic-week date anchor before they can be placed on exact calendar dates. Other weekly class dates are labeled as estimates until verified.

## Privacy

CourseFlow stores study data locally in Chrome. It does not ask for university passwords, and it does not change records on Moodle or MANO. A Moodle calendar export URL may contain a private access token; do not include personal calendar links, exported backups, or account details in public issues or commits.

## Development

The app is written in plain HTML, CSS, and JavaScript using Chrome Manifest V3. There is no build step.

Run the unit tests with Node.js:

```bash
npm test
```

An optional browser smoke test lives in `tests/browser_smoke.py`. It uses Python, Playwright, and a locally installed Chromium browser. The signed-in Moodle and MANO integrations must be checked manually in your own browser session.

## Project status

Current release: **1.4.4** (Chrome). Desktop and Android apps are possible future projects; this extension is not an EXE or APK package.

CourseFlow is an independent project and is not affiliated with VILNIUS TECH or Moodle.