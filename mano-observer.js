// Runs only on signed-in MANO timetable pages. No cookie, password, form data,
// raw document HTML, network request or extra permissions are collected.
(()=>{
  if(!/^\/timetable\//i.test(location.pathname))return;
  let timeout=0, lastActivity=0;
  const notify=()=>{
    if(!document.querySelector('table, [role="row"], mat-row'))return;
    // The service worker extracts visible timetable cell text, not this script.
    try{chrome.runtime.sendMessage({type:'courseflow:mano:scan'}).catch(()=>{});}catch{}
  };
  const schedule=()=>{
    const now=Date.now();
    if(now-lastActivity<200)return;
    lastActivity=now;
    clearTimeout(timeout);
    timeout=setTimeout(notify,1100);
  };
  const observe=()=>{
    const root=document.body||document.documentElement;
    if(!root)return;
    const observer=new MutationObserver(schedule);
    observer.observe(root,{subtree:true,childList:true,characterData:true});
    schedule();
  };
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',observe,{once:true});else observe();
  window.addEventListener('pageshow',schedule);
})();
