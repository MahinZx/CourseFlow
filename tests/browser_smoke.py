import os, threading, http.server
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from functools import partial
from playwright.sync_api import sync_playwright

ROOT=os.path.dirname(os.path.dirname(__file__))
class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self,*args):pass
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),partial(QuietHandler,directory=ROOT))
thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
base=f'http://127.0.0.1:{server.server_port}/index.html'
today=datetime.now(ZoneInfo('Europe/Vilnius')).date()
past=(today-timedelta(days=70)).strftime('%Y-%m-%d')
future=(today+timedelta(days=7)).strftime('%Y-%m-%d')
first=(today-timedelta(days=7)).strftime('%Y-%m-%d')
until=(today+timedelta(days=60)).strftime('%Y-%m-%d')
data={
    'courses':[{'id':'subject1','name':'Fundamentals of Software Engineering','code':'FMISB23500'}],
    'events':[
        {'id':'old','kind':'exam','name':'Past exam','courseCode':'FMISB23500','due':past+'T10:00:00Z'},
        {'id':'new','kind':'exam','name':'Future exam','courseCode':'FMISB23500','due':future+'T10:00:00Z'}
    ],
    'lectures':[{'courseId':'subject1','courseCode':'FMISB23500','courseName':'Fundamentals of Software Engineering','source':'pdf','day':1,'start':'12:10','end':'13:45','room':'P3(TRIII) 105','repeat':'weekly','firstDate':first,'untilDate':until}],
    'studentGroup':'ITfu-24/1',
    'lastStatusSync':None
}
try:
    with sync_playwright() as p:
        browser=p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
        page=browser.new_page(viewport={'width':1280,'height':860})
        errors=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        page.goto(base+'?demo=1');page.wait_for_load_state('networkidle')
        page.evaluate('data => localStorage.setItem("courseflow:data:v1",JSON.stringify(data))',data)
        page.goto(base);page.wait_for_load_state('networkidle')
        assert page.title()=='CourseFlow',page.title()
        page.get_by_role('button',name='Calendar',exact=True).click()
        page.wait_for_timeout(400)
        headings=page.locator('.calendar-month-heading').all_text_contents()
        assert headings, headings
        assert (today-timedelta(days=70)).strftime('%B %Y') not in headings, headings
        assert 'Past exam' not in page.locator('#calendar-list').inner_text()
        assert 'Future exam' in page.locator('#calendar-list').inner_text()
        page.locator('#calendar-show-past').check();page.wait_for_timeout(250)
        headings=page.locator('.calendar-month-heading').all_text_contents()
        assert (today-timedelta(days=70)).strftime('%B %Y') in headings, headings
        assert 'Past exam' in page.locator('#calendar-list').inner_text()
        page.locator('#calendar-show-past').uncheck();page.wait_for_timeout(200)
        assert (today-timedelta(days=70)).strftime('%B %Y') not in page.locator('.calendar-month-heading').all_text_contents()
        page.get_by_role('button',name='Settings',exact=True).click()
        assert page.locator('#student-group').count()==0
        assert 'Your group (optional)' not in page.locator('body').inner_text()
        assert 'Mano timetable connection' in page.locator('body').inner_text()
        # With a legacy group preference still present, approved lessons must remain on the homepage.
        page.get_by_role('button',name='Overview',exact=True).click()
        assert 'Fundamentals of Software Engineering' in page.locator('body').inner_text()
        assert not errors,errors
        page.screenshot(path=os.path.join(ROOT,'tests','browser_smoke_calendar.png'),full_page=True)
        print('PASS: latest name, today-forward calendar, optional history, group removal and preserved data')
        browser.close()
finally:
    server.shutdown()
