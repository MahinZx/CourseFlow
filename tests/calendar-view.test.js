import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarDay, visibleCalendarItems } from '../calendar-view.js';

test('default calendar starts today in Europe/Vilnius, not first semester month', () => {
  const now = new Date('2026-11-24T02:00:00Z');
  const entries = [
    {at:'2026-09-01T09:00:00Z',name:'past'},
    {at:'2026-11-23T22:30:00Z',name:'today before midnight UTC'},
    {at:'2026-11-24T14:00:00Z',name:'today later'},
    {at:'2026-12-10T09:00:00Z',name:'future'}
  ];
  assert.equal(calendarDay(now),'2026-11-24');
  assert.deepEqual(visibleCalendarItems(entries,{now}).map(e=>e.name),[
    'today before midnight UTC','today later','future'
  ]);
  assert.equal(visibleCalendarItems(entries,{now,showPast:true}).length,4);
});
test('calendar respects Vilnius midnight independent of the computer UTC day', () => {
  assert.equal(calendarDay('2026-11-23T22:01:00Z'), '2026-11-24');
  assert.equal(calendarDay('2026-11-23T21:59:00Z'), '2026-11-23');
  assert.equal(calendarDay('2026-07-14T21:01:00Z'), '2026-07-15');
  assert.equal(calendarDay('2026-07-14T20:59:00Z'), '2026-07-14');
});
