/* ============================================================
   RIGRX front-end — talks to the RIGRX API. No frameworks.
   ============================================================ */
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
const fmt$ = cents => '$' + (cents / 100).toFixed(0);
const fmtEta = v => { const t = String(v ?? '').trim(); return /^\d+$/.test(t) ? t + ' min' : t; };
function toast(msg){
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(()=>t.classList.remove('show'), 3000);
}
function timeAgo(ts){
  const m = Math.max(0, Math.round((Date.now() - new Date(ts).getTime()) / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return m + ' min ago';
  const h = Math.round(m / 60);
  return h < 24 ? h + ' hr ago' : Math.round(h / 24) + ' d ago';
}
async function api(method, url, body){
  const res = await fetch('/api' + url, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(()=>({}));
  if (!res.ok) { toast(data.error || 'Request failed'); throw new Error(data.error || res.status); }
  return data;
}
function tog(el){ el.classList.toggle('sel'); }
function togOne(el){ [...el.parentElement.children].forEach(c=>c.classList.remove('sel')); el.classList.add('sel'); }
function selOf(groupId){ const g = $(groupId); return g ? [...g.querySelectorAll('.chip.sel')].map(c=>c.textContent.trim()) : []; }
const qv = id => { const el = $(id); return el ? el.value : ''; };

/* ---------------- state & router ---------------- */
const S = {
  view: 'loading', me: null, provider: null, trucks: [], trailers: [],
  draft: null,          // request being composed
  activeRequestId: null, chatKey: null, viewProviderId: null, rateRequestId: null, leadFilter: '', showArchived: false,
  leadId: null, simulatedPayments: true, catalog: [], trades: [], equipment: {}, dutyClass: 'heavy'
};
async function loadCatalog(){
  try { S.catalog = await api('GET', '/catalog'); } catch(e){ S.catalog = []; }
  try { S.trades = await api('GET', '/trades'); } catch(e){ S.trades = []; }
  try { S.equipment = await api('GET', '/equipment'); } catch(e){ S.equipment = {}; }
}
const tradeByKey = k => (S.trades || []).find(t => t.key === k) || null;
const tradeLabel = k => tradeByKey(k)?.label || '';
const catByKey = k => (S.catalog || []).find(c => c.key === k) || null;
const svcIconFor = k => catByKey(k)?.icon || 'box';
async function loadMe(){
  const d = await api('GET', '/me');
  S.me = d.user; S.provider = d.provider || null;
  S.trucks = d.trucks || []; S.trailers = d.trailers || [];
  S.simulatedPayments = !!d.simulatedPayments;
}
function nav(view, extra){
  S.view = view;
  Object.assign(S, extra || {});
  render();
  window.scrollTo(0, 0);
  if (view === 'd-review') setTimeout(previewMatches, 60);
}
function homeFor(){
  if (!S.me) return 'signin';
  if (S.me.role === 'admin') return 'a-home';
  if (S.me.role === 'provider') {
    if (S.me.member_role === 'tech') return 't-jobs';
    return (!S.provider || !S.provider.name) ? 'p-setup1' : 'p-feed';
  }
  return !S.me.name ? 'd-setup1' : 'd-home';
}

/* ---------------- live updates (WebSocket) ---------------- */
let ws = null;
function connectWS(){
  if (ws) try { ws.close(); } catch(e){}
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onmessage = ev => {
    let msg; try { msg = JSON.parse(ev.data); } catch(e){ return; }
    const { event, data } = msg;
    if (event === 'new_lead'){
      toast(`New ${data.service} lead ${data.band} away — open Live Leads`);
      if (S.view === 'p-feed') render();
    }
    if (event === 'responder'){
      toast(`${data.name} unlocked your request`);
      if (S.view === 'd-active' && S.activeRequestId === data.request_id) render();
    }
    if (event === 'message'){
      toast('New message');
      if (S.view === 'd-chat' || S.view === 'p-chat') render();
    }
    if (event === 'selected'){
      toast(data.won ? 'You got the job!' : 'Driver went with another provider');
      if (S.view.startsWith('p-')) render();
    }
  };
  ws.onclose = () => setTimeout(()=>{ if (S.me) connectWS(); }, 4000);
}

/* ---------------- auth views ---------------- */
function authShell(inner, wide){
  return `<div class="authwrap"><div class="authcard${wide?' wide':''}">
    <div class="logo-lg">RIG<span>RX</span></div>
    <div class="tagline">Emergency roadside help for trucks — fast.</div>
    ${inner}</div></div>`;
}
function vSignin(){
  return authShell(`
  <div class="card" style="padding:20px">
    <span class="sec">Sign in or create an account</span>
    <label class="f">Mobile number</label>
    <input type="text" id="si-phone" placeholder="(661) 555-0198" autocomplete="tel">
    <label class="f">I am a…</label>
    <div class="chips" id="si-role">
      <span class="chip sel" onclick="togOne(this)">Truck driver</span>
      <span class="chip" onclick="togOne(this)">Service company</span>
    </div>
    <div style="height:14px"></div>
    <button class="btn" onclick="requestCode()">${ic('mobile',16)} Text me a code</button>
  </div>
  <div class="faint" style="text-align:center; line-height:1.6">Your number is your account — no passwords.<br>New numbers create an account; existing ones sign in.</div>`);
}
async function requestCode(){
  const phone = qv('si-phone').trim();
  if (!phone) return toast('Enter your mobile number');
  const role = selOf('si-role')[0] === 'Service company' ? 'provider' : 'driver';
  const d = await api('POST', '/auth/request-code', { phone });
  S.pendingPhone = phone; S.pendingRole = role; S.devCode = d.devCode || null;
  nav('code');
}
function vCode(){
  return authShell(`
  <button class="back" onclick="nav('signin')">${ic('chevL',15)} Back</button>
  <div class="card" style="padding:24px; text-align:center; margin-top:10px">
    <span class="sec">Enter the code we texted you</span>
    <div style="margin:18px 0 6px">
      <input type="text" id="si-code" inputmode="numeric" maxlength="6" placeholder="••••••"
        style="width:180px; text-align:center; font-size:24px; font-weight:800; letter-spacing:8px"
        onkeydown="if(event.key==='Enter')verifyCode()">
    </div>
    <div class="faint">Sent to ${esc(S.pendingPhone)} · <a onclick="requestCodeAgain()">Resend</a></div>
    ${S.devCode ? `<div class="card alert" style="margin-top:14px"><div class="mini">${ic('zap',13)} <b class="k">Test mode</b> (no Twilio keys yet) — your code is <b class="k" style="letter-spacing:3px">${esc(S.devCode)}</b></div></div>` : ''}
    <div style="height:12px"></div>
    <button class="btn" onclick="verifyCode()">${ic('check',16)} Verify & continue</button>
  </div>`);
}
async function requestCodeAgain(){
  const d = await api('POST', '/auth/request-code', { phone: S.pendingPhone });
  S.devCode = d.devCode || null; toast('Code re-sent'); render();
}
async function verifyCode(){
  const code = qv('si-code').trim();
  if (code.length < 4) return toast('Enter the 6-digit code');
  await api('POST', '/auth/verify', { phone: S.pendingPhone, code, role: S.pendingRole });
  await loadMe();
  connectWS();
  nav(homeFor());
}
async function signOut(){
  await api('POST', '/auth/logout').catch(()=>{});
  S.me = null; S.provider = null;
  if (ws) try { ws.close(); } catch(e){}
  nav('signin');
}


/* ---------------- dropdowns with an "Other…" escape hatch ---------------- */
// Every list is a suggestion. Picking "Other…" reveals a text box and quietly
// logs what they typed so the lists can be improved from real usage.
function sel(id, options, current, opts = {}){
  const list = options || [];
  const known = list.includes(current);
  const isOther = current && !known;
  return `
  <select id="${id}" onchange="onSelChange('${id}')" data-field="${opts.field || id}">
    <option value="">${opts.placeholder || 'Select…'}</option>
    ${list.map(o=>`<option ${o===current?'selected':''}>${esc(o)}</option>`).join('')}
    <option value="__other" ${isOther?'selected':''}>Other…</option>
  </select>
  <input type="text" id="${id}-other" placeholder="${opts.otherPlaceholder || 'Type it in'}"
    value="${isOther?esc(current):''}" style="margin-top:7px; display:${isOther?'block':'none'}">`;
}
function onSelChange(id){
  const box = $(id + '-other');
  if (!box) return;
  const other = $(id).value === '__other';
  box.style.display = other ? 'block' : 'none';
  if (other) box.focus();
}
// Read a select+other pair as one value
function selVal(id){
  const el = $(id); if (!el) return '';
  if (el.value === '__other') {
    const typed = ($(id + '-other')?.value || '').trim();
    if (typed) logOther(el.dataset.field || id, typed);
    return typed;
  }
  return el.value;
}
function logOther(field, value){
  api('POST', '/other-entry', { field, value, duty_class: S.dutyClass || '' }).catch(()=>{});
}
const EQ = () => S.equipment || {};
const forClass = (map, cls) => (map || {})[cls || 'heavy'] || [];

/* ---------------- driver setup (first sign-in) ---------------- */
function progress(step, total){ return `<div class="progress">${Array.from({length: total},(_,i)=>`<i class="${i<step?'on':''}"></i>`).join('')}</div>`; }


/* ---------------- setup navigation ---------------- */
// The setup screens run without the sidebar or tab bar, so they need their own way
// out. Someone already set up who is editing a rig should land back where they came
// from, not be walked backwards into the first-run welcome screen with no exit.
const isSetUpDriver = () => !!(S.me && S.me.name);
const isSetUpProvider = () => !!(S.provider && S.provider.name);
function setupTop(backView, backLabel, homeView){
  return `
  <div class="row" style="align-items:center; margin:0 0 18px">
    ${backView ? `<button class="back" style="margin:0" onclick="nav('${backView}')">${ic('chevL',15)} ${backLabel || 'Back'}</button>` : '<span></span>'}
    ${homeView ? `<button class="back" style="margin:0" onclick="nav('${homeView}')">${ic('home',15)} Done — go home</button>` : ''}
  </div>`;
}

function vDSetup1(){
  return authShell(`
  ${isSetUpDriver() ? setupTop(null, null, 'd-home') : ''}
  ${progress(1,3)}
  <h2 class="scr">Welcome — let's set you up</h2>
  <p class="scrsub">Step 1 of 3 · about 2 minutes. Broke down right now? <a onclick="nav('d-home')">Skip, request help first</a></p>
  <label class="f">Full name</label><input type="text" id="su-name" value="${esc(S.me?.name)}">
  <label class="f">Email (receipts & updates)</label><input type="text" id="su-email" value="${esc(S.me?.email)}">
  <label class="f">I am a…</label>
  <div class="chips" id="su-type">
    ${['Owner-operator','Company driver','Fleet dispatcher'].map((t,i)=>`<span class="chip ${ (S.me?.driver_type||'Owner-operator')===t?'sel':''}" onclick="togOne(this)">${t}</span>`).join('')}
  </div>
  <label class="f">Company & MC/DOT # (optional)</label><input type="text" id="su-company" value="${esc(S.me?.company)}">
  <div style="height:16px"></div>
  <button class="btn" onclick="saveDSetup1()">Continue ${ic('arrowR',15)}</button>`);
}
async function saveDSetup1(){
  if (!qv('su-name').trim()) return toast('Enter your name');
  const d = await api('PUT', '/driver/profile', {
    name: qv('su-name'), email: qv('su-email'),
    driver_type: selOf('su-type')[0] || 'Owner-operator', company: qv('su-company') });
  S.me = d.user;
  nav('d-setup2');
}
// Duty class drives every list below it, so it is the first question asked.
function setDutyClass(cls){
  if (S.dutyClass === cls) return;
  const keep = S.view === 'd-setup2' ? readTruckForm() : null;
  S.dutyClass = cls;
  if (keep) S.editTruck = { ...(S.editTruck || {}), ...keep, duty: cls };
  render();
}
function dutyPicker(current){
  const list = EQ().DUTY_CLASSES || [];
  return `
  <label class="f">What size truck is this?</label>
  <div class="dutyrow">
    ${list.map(d=>`
    <div class="dutycard ${d.key===current?'sel':''}" onclick="setDutyClass('${d.key}')">
      <b>${esc(d.label)}</b><span>${esc(d.blurb)}</span>
    </div>`).join('')}
  </div>`;
}
// The model list depends on the make, so it redraws whenever the make changes.
function modelOptions(make){ return (EQ().MODELS || {})[make] || []; }
function onMakeChange(){
  const make = selVal('tk-make');
  const wrap = $('tk-model-wrap');
  if (wrap) wrap.innerHTML = sel('tk-model', modelOptions(make), '', { placeholder: 'Select model…', field: 'truck_model' });
  onSelChange('tk-make');
}
function truckForm(t = {}){
  const cls = S.dutyClass || t.duty || 'heavy';
  const yrs = []; for (let y = new Date().getFullYear() + 1; y >= 1990; y--) yrs.push(String(y));
  return `
  ${dutyPicker(cls)}
  <div class="grid2">
    <div><label class="f">Unit #</label><input type="text" id="tk-unit" value="${esc(t.unit)}" placeholder="Optional"></div>
    <div><label class="f">Year</label>${sel('tk-year', yrs, t.year, { placeholder: 'Select year…', field: 'truck_year' })}</div>
  </div>
  <div class="grid2">
    <div><label class="f">Make</label>
      <select id="tk-make" onchange="onMakeChange()" data-field="truck_make">
        <option value="">Select make…</option>
        ${forClass(EQ().MAKES, cls).map(m=>`<option ${m===t.make?'selected':''}>${esc(m)}</option>`).join('')}
        <option value="__other" ${t.make && !forClass(EQ().MAKES, cls).includes(t.make) ? 'selected':''}>Other…</option>
      </select>
      <input type="text" id="tk-make-other" placeholder="Type the make"
        value="${t.make && !forClass(EQ().MAKES, cls).includes(t.make) ? esc(t.make) : ''}"
        style="margin-top:7px; display:${t.make && !forClass(EQ().MAKES, cls).includes(t.make) ? 'block':'none'}">
    </div>
    <div><label class="f">Model</label><div id="tk-model-wrap">${sel('tk-model', modelOptions(t.make), t.model, { placeholder: 'Select model…', field: 'truck_model' })}</div></div>
  </div>
  <div class="grid2">
    <div><label class="f">Engine</label>${sel('tk-engine', forClass(EQ().ENGINES, cls), t.engine, { placeholder: 'Select engine…', field: 'truck_engine' })}</div>
    <div><label class="f">Transmission</label>${sel('tk-trans', forClass(EQ().TRANSMISSIONS, cls), t.trans, { placeholder: 'Select transmission…', field: 'truck_trans' })}</div>
  </div>
  <label class="f">Axle configuration</label>${sel('tk-axles', forClass(EQ().AXLE_CONFIGS, cls), t.axles, { placeholder: 'Select axles…', field: 'truck_axles' })}
  <div class="grid2">
    <div><label class="f">Steer tire size</label>${sel('tk-steer', forClass(EQ().TIRE_SIZES, cls), t.steer, { placeholder: 'Select size…', field: 'steer_tire', otherPlaceholder: 'e.g. 295/75R22.5' })}</div>
    <div><label class="f">Drive tire size</label>${sel('tk-drive', forClass(EQ().TIRE_SIZES, cls), t.drive, { placeholder: 'Select size…', field: 'drive_tire', otherPlaceholder: 'e.g. 11R24.5' })}</div>
  </div>
  <div class="grid2">
    <div><label class="f">Wheels</label>${sel('tk-wheels', EQ().WHEEL_TYPES || [], t.wheels, { placeholder: 'Select…', field: 'wheels' })}</div>
    <div><label class="f">Color</label>${sel('tk-color', EQ().TRUCK_COLORS || [], t.color, { placeholder: 'Select color…', field: 'truck_color' })}</div>
  </div>
  <label class="f">VIN (optional — speeds up parts)</label><input type="text" id="tk-vin" value="${esc(t.vin)}">
  <label class="f">Extras (optional)</label>
  <div class="chips" id="tk-extras">
    ${(EQ().TRUCK_EXTRAS || []).map(e=>`<span class="chip ${(t.extras||[]).includes(e)?'sel':''}" onclick="tog(this)">${esc(e)}</span>`).join('')}
  </div>`;
}
function readTruckForm(){
  return { duty: S.dutyClass || 'heavy', unit: qv('tk-unit'), year: selVal('tk-year'),
    make: selVal('tk-make'), model: selVal('tk-model'),
    engine: selVal('tk-engine'), trans: selVal('tk-trans'), axles: selVal('tk-axles'),
    steer: selVal('tk-steer'), drive: selVal('tk-drive'), wheels: selVal('tk-wheels'),
    color: selVal('tk-color'), vin: qv('tk-vin'), extras: selOf('tk-extras') };
}
function vDSetup2(){
  if (S.editTruck?.duty) S.dutyClass = S.editTruck.duty;
  return authShell(`
  ${isSetUpDriver()
    ? setupTop('d-garage', 'My Garage', 'd-home')
    : setupTop('d-setup1', 'Back')}
  ${progress(2,3)}
  <h2 class="scr">Add your truck</h2>
  <p class="scrsub">Step 2 of 3 — every detail here saves a question at 2 AM</p>
  ${truckForm(S.editTruck || {})}
  <div style="height:16px"></div>
  <button class="btn" onclick="saveDSetup2()">${isSetUpDriver() ? ic('check',16) + ' Save truck' : 'Continue ' + ic('arrowR',15)}</button>`);
}
async function saveDSetup2(){
  const data = readTruckForm();
  if (!data.make) return toast('At least enter the make');
  const wasSetUp = isSetUpDriver();
  if (S.editTruck?.id) await api('PUT', '/trucks/' + S.editTruck.id, { data });
  else await api('POST', '/trucks', { data });
  await loadMe();
  if (wasSetUp) { toast('Truck saved'); S.editTruck = null; return nav('d-garage'); }
  nav('d-setup3');
}
function trailerForm(r = {}){
  // A trailer can be pulled by any size truck, so its tire list is the union of all
  // classes rather than whatever the tractor happens to be.
  const allTires = [...new Set([].concat(
    forClass(EQ().TIRE_SIZES, 'heavy'), forClass(EQ().TIRE_SIZES, 'medium'), forClass(EQ().TIRE_SIZES, 'light')))];
  return `
  <label class="f">Trailer type</label>
  ${sel('tr-type', EQ().TRAILER_TYPES || [], r.type, { placeholder: 'Select trailer type…', field: 'trailer_type' })}
  <div class="grid2">
    <div><label class="f">Trailer #</label><input type="text" id="tr-num" value="${esc(r.num)}" placeholder="Optional"></div>
    <div><label class="f">Length</label>${sel('tr-len', EQ().TRAILER_LENGTHS || [], r.len, { placeholder: 'Select length…', field: 'trailer_length' })}</div>
  </div>
  <div class="grid2">
    <div><label class="f">Axles</label>${sel('tr-axles', EQ().TRAILER_AXLES || [], r.axles, { placeholder: 'Select…', field: 'trailer_axles' })}</div>
    <div><label class="f">Suspension</label>${sel('tr-susp', EQ().SUSPENSIONS || [], r.susp, { placeholder: 'Select…', field: 'trailer_susp' })}</div>
  </div>
  <div class="grid2">
    <div><label class="f">Tire size</label>${sel('tr-tires', allTires, r.tires, { placeholder: 'Select size…', field: 'trailer_tire' })}</div>
    <div><label class="f">Reefer unit (if reefer)</label>${sel('tr-reefer', EQ().REEFER_MAKES || [], r.reefer, { placeholder: 'Not a reefer', field: 'reefer_make' })}</div>
  </div>
  <div class="grid2">
    <div><label class="f">Doors</label>${sel('tr-doors', EQ().DOOR_TYPES || [], r.doors, { placeholder: 'Select…', field: 'trailer_doors' })}</div>
    <div><label class="f">Liftgate</label>${sel('tr-liftgate', ['No','Yes'], r.liftgate, { placeholder: 'Select…', field: 'liftgate' })}</div>
  </div>
  <div class="card alert" style="margin-top:12px">
    <div class="row"><span class="mini k">${ic('warn',15)} Hazmat placarded</span>
      <span class="chips" id="tr-hz"><span class="chip ${r.hazmat?'sel':''}" onclick="togOne(this)">Yes</span><span class="chip ${r.hazmat?'':'sel'}" onclick="togOne(this)">No</span></span></div>
    <div class="grid2" style="margin-top:8px">
      <div><label class="f" style="margin-top:0">Class</label>${sel('tr-class', EQ().HAZMAT_CLASSES || [], r.hzClass, { placeholder: 'Select class…', field: 'hazmat_class' })}</div>
      <div><label class="f" style="margin-top:0">UN #</label><input type="text" id="tr-un" value="${esc(r.un)}" placeholder="1267"></div>
    </div>
    <div class="faint" style="margin-top:7px">Providers see this before they buy — tow operators must know</div>
  </div>`;
}
function readTrailerForm(){
  return { type: selVal('tr-type'), num: qv('tr-num'), len: selVal('tr-len'),
    axles: selVal('tr-axles'), susp: selVal('tr-susp'), tires: selVal('tr-tires'),
    reefer: selVal('tr-reefer'), doors: selVal('tr-doors'), liftgate: selVal('tr-liftgate'),
    hazmat: selOf('tr-hz')[0] === 'Yes', hzClass: qv('tr-class'), un: qv('tr-un') };
}
function vDSetup3(){
  return authShell(`
  ${isSetUpDriver()
    ? setupTop('d-garage', 'My Garage', 'd-home')
    : setupTop('d-setup2', 'Back')}
  ${progress(3,3)}
  <h2 class="scr">Add your trailer</h2>
  <p class="scrsub">Step 3 of 3 — you can add more rigs anytime in My Garage</p>
  ${trailerForm(S.editTrailer || {})}
  <div style="height:8px"></div>
  <button class="btn" onclick="saveDSetup3()">${ic('check',16)} ${isSetUpDriver() ? 'Save trailer' : 'Finish — go to my dashboard'}</button>
  <div style="height:8px"></div>
  <button class="btn ghost" onclick="nav(isSetUpDriver() ? 'd-garage' : 'd-home')">${isSetUpDriver() ? 'Cancel' : 'Skip — no trailer / bobtail'}</button>`);
}
async function saveDSetup3(){
  const data = readTrailerForm();
  const wasSetUp = isSetUpDriver();
  if (data.type && !/bobtail/i.test(data.type)){
    if (S.editTrailer?.id) await api('PUT', '/trailers/' + S.editTrailer.id, { data });
    else await api('POST', '/trailers', { data });
  }
  await loadMe();
  if (wasSetUp) { toast('Trailer saved'); S.editTrailer = null; return nav('d-garage'); }
  toast('Profile complete — your garage is ready');
  nav('d-home');
}
/* ---------------- driver app ---------------- */
const svcIcon = key => svcIconFor(key);

async function vDHome(){
  const mine = await api('GET', '/requests/mine');
  const open = mine.filter(r => ['open','selected'].includes(r.status));
  const t = S.trucks[0]?.data, r = S.trailers[0]?.data;
  return `
  <h2 class="scr lg">Hey ${esc((S.me.name || 'driver').split(' ')[0])}</h2>
  <p class="scrsub">Broke down? Help is minutes away.</p>
  <button class="btn big" onclick="startRequest()">${ic('zap',18)} REQUEST HELP NOW</button>
  <div style="height:14px"></div>
  ${open.map(x=>`<div class="card click" onclick="nav('d-active',{activeRequestId:${x.id}})">
    <div class="row"><span class="mini k">${ic(svcIcon(x.service_key),15)} &nbsp;Request #${x.id} — ${esc(x.service_label)} · ${x.buyer_count} responder${x.buyer_count===1?'':'s'}</span>
    <span class="pill ${x.status==='open'?'red':'dark'}">${x.status.toUpperCase()}</span></div></div>`).join('')}
  <div class="cols2"><div>
  <div class="card">
    <div class="row"><span class="sec">My Garage</span><span class="faint" style="cursor:pointer" onclick="nav('d-garage')">Manage ›</span></div>
    ${t ? `<div class="checkrow"><span class="cico on">${ic('truck')}</span><div><b class="mini k">Unit ${esc(t.unit)} — ${esc(t.year)} ${esc(t.make)} ${esc(t.model)}</b><div class="faint">${esc(t.engine)} · ${esc(t.axles)} · ${esc(t.color)}</div></div></div>` : `<div class="checkrow"><span class="cico">${ic('truck')}</span><div class="mini"><a onclick="S.editTruck=null; nav('d-setup2')">Add your truck ›</a></div></div>`}
    ${r ? `<div class="checkrow"><span class="cico on">${ic('trailer')}</span><div><b class="mini k">Trailer ${esc(r.num)} — ${esc(r.type)}</b><div class="faint">${r.hazmat ? 'Hazmat: Class '+esc(r.hzClass)+' · UN '+esc(r.un) : 'No hazmat'}</div></div></div>` : `<div class="checkrow"><span class="cico">${ic('trailer')}</span><div class="mini"><a onclick="S.editTrailer=null; nav('d-setup3')">Add your trailer ›</a></div></div>`}
  </div></div><div>
  <div class="card">
    <span class="sec">History</span>
    ${mine.filter(x=>['completed','cancelled'].includes(x.status)).slice(0,5).map(x=>`
      <div class="checkrow"><span class="cico">${ic(svcIcon(x.service_key))}</span><div><b class="mini k">${esc(x.service_label)}</b><div class="faint">${timeAgo(x.created_at)} · ${x.status}</div></div></div>`).join('') || '<div class="faint" style="margin-top:8px">No past requests yet</div>'}
  </div></div></div>`;
}
function startRequest(){
  S.draft = { situation: ['On highway shoulder',"Can't move"], can_move: 'no',
              lat: null, lng: null, photos: [],
              licensed_only: !!S.me?.prefer_licensed_only,   // remembers last choice
              trade_filter: [],
              duty_class: S.trucks?.[0]?.data?.duty || 'heavy' };
  nav('d-request');
}
function vDRequest(){
  const cats = (S.catalog || []).filter(c => c.driver_visible);
  return `
  <h2 class="scr">What do you need?</h2>
  <p class="scrsub">Step 1 of 4 — pick a service</p>
  <div class="grid2s">
    ${cats.map(c=>`<div class="svc" onclick="pickSvc('${c.key}')">
      <div class="em">${ic(c.icon,26)}</div><div class="nm">${esc(c.label)}</div><div class="ds">${esc(c.blurb)}</div></div>`).join('')
      || '<div class="card"><span class="muted">No services available yet</span></div>'}
  </div>`;
}
function pickSvc(key){
  const c = catByKey(key);
  if (!c) return toast('That service is unavailable');
  if (!S.draft) startRequest();
  S.draft.service_key = key; S.draft.service_label = c.label; S.draft.icon = c.icon;
  S.draft.service_item = '';
  nav('d-details');
}
function vDDetails(){
  const d = S.draft;
  const t = S.trucks, r = S.trailers;
  return `
  <button class="back" onclick="nav('d-request')">${ic('chevL',15)} Back</button>
  <h2 class="scr">${ic(d.icon,20)} ${esc(d.service_label)}</h2>
  <p class="scrsub">Step 2 of 4 — the details providers need</p>
  <label class="f">Truck</label>
  <div class="chips" id="rq-truck">
    ${t.map((x,i)=>`<span class="chip ${i===0?'sel':''}" data-id="${x.id}" onclick="togOne(this)">Unit ${esc(x.data.unit)} · ${esc(x.data.make)} ${esc(x.data.model)}</span>`).join('')}
    <span class="chip ${t.length?'':'sel'}" data-id="" onclick="togOne(this)">No saved truck</span>
  </div>
  <label class="f">Trailer</label>
  <div class="chips" id="rq-trailer">
    ${r.map((x,i)=>`<span class="chip ${i===0?'sel':''}" data-id="${x.id}" onclick="togOne(this)">${esc(x.data.type)} #${esc(x.data.num)}${x.data.hazmat?' ⚠':''}</span>`).join('')}
    <span class="chip ${r.length?'':'sel'}" data-id="" onclick="togOne(this)">Bobtail / none</span>
  </div>
  ${subPicker(d)}
  ${d.service_key === 'tires' ? tirePicker(d) : ''}
  <label class="f">Situation</label>
  <div class="chips" id="rq-situation">
    ${['On highway shoulder','Truck stop / lot','On ramp','Blocking traffic'].map(x=>`<span class="chip ${d.situation.includes(x)?'sel':''}" onclick="tog(this)">${x}</span>`).join('')}
  </div>
  <label class="f">Can the truck move under its own power?</label>
  <div class="chips" id="rq-move">
    ${[['no',"Can't move"],['short','Short distance'],['yes','Yes']].map(([v,l])=>`<span class="chip ${d.can_move===v?'sel':''}" data-v="${v}" onclick="togOne(this)">${l}</span>`).join('')}
  </div>
  <label class="f">What happened?</label>
  <textarea rows="3" id="rq-desc" placeholder="Describe the problem — dash codes, sounds, what you see…">${esc(d.description || '')}</textarea>
  <label class="f">Photos (optional but providers respond faster with them)</label>
  <div class="chips" id="rq-photos">
    ${d.photos.map(p=>`<span class="chip">${ic('camera',13)} added</span>`).join('')}
    <label class="chip dashed" style="cursor:pointer">+ Add photo<input type="file" accept="image/*" style="display:none" onchange="uploadPhoto(this)"></label>
  </div>
  <div style="height:16px"></div>
  <button class="btn" onclick="saveDetails()">Continue ${ic('arrowR',15)}</button>`;
}
/* ---- optional refinement: which kind of work, from the admin catalog ---- */
function subPicker(d){
  const items = (catByKey(d.service_key)?.items) || [];
  if (!items.length) return '';
  return `
  <label class="f">What kind? <span style="text-transform:none; letter-spacing:0; font-weight:500">(optional — helps them bring the right parts)</span></label>
  <div class="chips" id="rq-subitem">
    ${items.map(i=>`<span class="chip ${i.label===d.service_item?'sel':''}" onclick="togOne(this)">${esc(i.label)}</span>`).join('')}
  </div>`;
}

/* ---- which tire failed: axle → side → inner/outer, no diagrams ---- */
const TIRE_AXLES = ['Steer axle','Drive axle 1','Drive axle 2','Drive axle 3',
                    'Trailer axle 1','Trailer axle 2','Trailer axle 3'];
function tirePicker(d){
  const tp = d.tire_position || {};
  const isSteer = /steer/i.test(tp.axle || '');
  return `
  <label class="f">Which tire?</label>
  <div class="chips" id="rq-tire-axle">
    ${TIRE_AXLES.map(a=>`<span class="chip ${a===tp.axle?'sel':''}" onclick="pickAxle(this)">${a}</span>`).join('')}
  </div>
  <label class="f">Which side?</label>
  <div class="chips" id="rq-tire-side">
    ${['Driver side','Passenger side'].map(x=>`<span class="chip ${x===tp.side?'sel':''}" onclick="togOne(this)">${x}</span>`).join('')}
  </div>
  ${isSteer ? '' : `
  <label class="f">Inside or outside?</label>
  <div class="chips" id="rq-tire-pos">
    ${['Outside','Inside','Super single (only one tire)'].map(x=>`<span class="chip ${x===tp.position?'sel':''}" onclick="togOne(this)">${x}</span>`).join('')}
  </div>`}
  <label class="f">What happened to it?</label>
  <div class="chips" id="rq-tire-problem">
    ${['Flat','Blowout','Low air','Sidewall damage','Tread separation','Wheel damage','Not sure'].map(x=>`<span class="chip ${x===tp.problem?'sel':''}" onclick="togOne(this)">${x}</span>`).join('')}
  </div>
  <div class="faint" style="margin-top:8px">${ic('check',12)} The tire size comes from your saved rig automatically, so they bring the right one.</div>`;
}
function pickAxle(el){
  togOne(el);
  S.draft.tire_position = readTirePicker();
  render();   // steer axles have no inner/outer, so the options change
}
function readTirePicker(){
  if (!$('rq-tire-axle')) return S.draft.tire_position || null;
  const axle = $('rq-tire-axle').querySelector('.chip.sel')?.textContent.trim() || '';
  if (!axle) return null;
  return {
    axle,
    side: $('rq-tire-side')?.querySelector('.chip.sel')?.textContent.trim() || '',
    position: /steer/i.test(axle) ? 'Single' : ($('rq-tire-pos')?.querySelector('.chip.sel')?.textContent.trim() || ''),
    problem: $('rq-tire-problem')?.querySelector('.chip.sel')?.textContent.trim() || ''
  };
}
async function uploadPhoto(input){
  if (!input.files[0]) return;
  const fd = new FormData(); fd.append('file', input.files[0]);
  const res = await fetch('/api/upload', { method: 'POST', body: fd });
  const data = await res.json();
  if (data.url){ S.draft.photos.push(data.url); toast('Photo added'); render(); }
}
function saveDetails(){
  const d = S.draft;
  d.truck_id = Number($('rq-truck').querySelector('.chip.sel')?.dataset.id) || null;
  d.trailer_id = Number($('rq-trailer').querySelector('.chip.sel')?.dataset.id) || null;
  d.duty_class = S.trucks.find(x=>x.id===d.truck_id)?.data?.duty || d.duty_class || 'heavy';
  d.situation = selOf('rq-situation');
  d.can_move = $('rq-move').querySelector('.chip.sel')?.dataset.v || 'no';
  d.description = qv('rq-desc');
  d.service_item = $('rq-subitem')?.querySelector('.chip.sel')?.textContent.trim() || '';
  if (d.service_key === 'tires') {
    const tp = readTirePicker();
    if (!tp || !tp.axle) return toast('Pick which tire so they bring the right one');
    d.tire_position = tp;
  }
  nav('d-location');
}
function vDLocation(){
  const d = S.draft;
  return `
  <button class="back" onclick="nav('d-details')">${ic('chevL',15)} Back</button>
  <h2 class="scr">Where are you?</h2>
  <p class="scrsub">Step 3 of 4 — this is how they find you</p>
  ${d.lat ? `
  <div class="card">
    <div class="row"><span class="sec">${ic('check',14)} Location locked</span>
      <a class="faint" onclick="captureGPS()">re-capture</a></div>
    <div class="mini listline" style="margin-top:6px">
      <span class="muted">Companies will see</span> &nbsp;<b class="k">${esc(d.area_label || 'locating…')}</b><br>
      <span class="muted">Exact GPS</span> &nbsp;${d.lat.toFixed(4)}, ${d.lng.toFixed(4)} <span class="faint">(only shown after they buy)</span>
    </div>
  </div>` : `
  <div class="card alert">
    <div class="mini" style="line-height:1.55">${ic('pin',14)} <b class="k">Tap below to share your location.</b> Your exact spot stays hidden until a company pays for the lead — they only see the general area first.</div>
    <div style="height:12px"></div>
    <button class="btn" onclick="captureGPS()">${ic('pin',16)} Use my GPS location</button>
  </div>`}
  <label class="f">Landmark or mile marker (optional, helps a lot)</label>
  <input type="text" id="rq-landmark" value="${esc(d.landmark || '')}" placeholder="I-5 NB shoulder, mile marker 253, past the Buttonwillow exit">
  <div class="faint" style="margin-top:6px">Only companies that buy your lead see this.</div>
  <div style="height:16px"></div>
  <button class="btn" onclick="saveLocation()" ${d.lat ? '' : 'disabled'}>Continue ${ic('arrowR',15)}</button>
  ${d.lat ? '' : '<div class="faint" style="text-align:center; margin-top:9px">Share your location to continue — or <a onclick="manualLocation()">enter it by hand</a></div>'}`;
}
async function lookupArea(){
  const d = S.draft;
  try {
    const g = await api('GET', `/geo?lat=${d.lat}&lng=${d.lng}`);
    d.area_label = g.area_label;
  } catch(e){ d.area_label = ''; }
  render();
}
function captureGPS(){
  if (!navigator.geolocation) return toast('No GPS on this device — enter it by hand');
  toast('Locating…');
  navigator.geolocation.getCurrentPosition(
    pos => {
      S.draft.lat = pos.coords.latitude; S.draft.lng = pos.coords.longitude;
      toast('Location locked'); lookupArea();
    },
    () => toast('GPS unavailable — enter it by hand instead'),
    { enableHighAccuracy: true, timeout: 10000 });
}
function manualLocation(){
  const txt = prompt('Type the nearest town and state (example: Buttonwillow, CA)');
  if (!txt) return;
  S.draft.lat = 35.4021; S.draft.lng = -119.4718;   // approximate; landmark carries the detail
  S.draft.area_label = txt.trim();
  S.draft.landmark = (S.draft.landmark || '') + (S.draft.landmark ? ' · ' : '') + txt.trim();
  toast('Saved — add a mile marker below so they can find you');
  render();
}
function saveLocation(){
  const d = S.draft;
  if (!d.lat) return toast('Share your location first');
  d.landmark = qv('rq-landmark');
  nav('d-review');
}
function vDReview(){
  const d = S.draft;
  const t = S.trucks.find(x=>x.id===d.truck_id)?.data || {};
  const r = S.trailers.find(x=>x.id===d.trailer_id)?.data || {};
  return `
  <button class="back" onclick="nav('d-location')">${ic('chevL',15)} Back</button>
  <h2 class="scr">Ready to send?</h2>
  <p class="scrsub">Step 4 of 4 — providers near you get alerted instantly</p>
  <div class="card">
    <div class="row"><b class="k" style="display:inline-flex;align-items:center;gap:7px">${ic(d.icon)} ${esc(d.service_label)}</b>
      <span class="pill solid">${d.can_move==='no' ? "CAN'T MOVE" : 'CAN MOVE'}</span></div>
    <div class="divider"></div>
    <div class="mini listline">
      <span class="muted">Truck</span> &nbsp;${t.make ? esc(`Unit ${t.unit} · ${t.year} ${t.make} ${t.model} · ${t.engine}`) : 'Not specified'}<br>
      <span class="muted">Trailer</span> &nbsp;${r.type ? esc(r.type) + (r.hazmat ? ` · <span style="color:var(--red);font-weight:700">Hazmat UN ${esc(r.un)}</span>` : '') : 'Bobtail / none'}<br>
      ${d.service_item ? `<span class="muted">Type</span> &nbsp;<b class="k">${esc(d.service_item)}</b><br>` : ''}
      ${d.tire_position ? `<span class="muted">Tire</span> &nbsp;<b class="k">${esc([d.tire_position.axle, d.tire_position.side, d.tire_position.position].filter(x=>x && x!=='Single').join(' · '))}</b>${d.tire_position.problem ? ' — '+esc(d.tire_position.problem) : ''}<br>` : ''}
      <span class="muted">Where</span> &nbsp;${esc(d.area_label)}<br>
      <span class="muted">Photos</span> &nbsp;${d.photos.length || 'none'}
    </div>
  </div>
  <div class="card">
    <span class="sec">Who should get this request?</span>
    <div class="chips" id="rq-licensed" style="margin-top:9px">
      <span class="chip ${d.licensed_only ? '' : 'sel'}" data-v="0" onclick="togOne(this); previewMatches()">All approved companies</span>
      <span class="chip ${d.licensed_only ? 'sel' : ''}" data-v="1" onclick="togOne(this); previewMatches()">${ic('check',13)} Licensed companies only</span>
    </div>
    <label class="f">Only companies whose main work is… <span style="text-transform:none; letter-spacing:0; font-weight:500">(optional)</span></label>
    <div class="chips" id="rq-trades">
      ${(S.trades||[]).map(t=>`<span class="chip ${(d.trade_filter||[]).includes(t.key)?'sel':''}" data-key="${t.key}" onclick="tog(this); previewMatches()">${esc(t.label)}</span>`).join('')}
    </div>
    <div class="faint" style="margin-top:10px; line-height:1.5" id="matchPreview">Checking how many companies match…</div>
  </div>
  <div class="card alert">
    <div class="mini" style="line-height:1.55">${ic('bell',14)} Qualified providers near you will be texted the moment you send. Up to <b class="k">4</b> can respond — you pick the winner. <b class="k">Free for you.</b></div>
  </div>
  <button class="btn big" onclick="sendRequest(this)">${ic('send',17)} SEND REQUEST</button>`;
}
function readFilters(){
  const d = S.draft;
  d.licensed_only = $('rq-licensed')?.querySelector('.chip.sel')?.dataset.v === '1';
  d.trade_filter = [...($('rq-trades')?.querySelectorAll('.chip.sel') || [])].map(c => c.dataset.key);
  return d;
}
// Show the cost of narrowing BEFORE sending, rather than discovering zero after.
async function previewMatches(){
  const d = readFilters();
  const el = $('matchPreview');
  if (!el || !d.lat) return;
  try {
    const qs = `lat=${d.lat}&lng=${d.lng}&service_key=${encodeURIComponent(d.service_key)}` +
               `&licensed_only=${d.licensed_only ? 1 : 0}&trades=${encodeURIComponent(JSON.stringify(d.trade_filter))}` +
               `&duty_class=${encodeURIComponent(d.duty_class || 'heavy')}`;
    const p = await api('GET', '/requests/preview?' + qs);
    const narrowed = d.licensed_only || d.trade_filter.length;
    el.innerHTML = p.matches === 0
      ? `<span style="color:var(--red)">${ic('warn',12)} <b>No companies match these filters.</b> ${p.without_filters} would be alerted without them — loosen the choices above, or send anyway and you can widen it after.</span>`
      : `${ic('check',12)} <b>${p.matches} compan${p.matches===1?'y':'ies'}</b> will be alerted${narrowed && p.without_filters > p.matches ? ` (${p.without_filters} without your filters)` : ''}.`;
  } catch(e){ el.textContent = ''; }
}
async function sendRequest(btn){
  btn.disabled = true;
  const d = readFilters();
  try {
    const res = await api('POST', '/requests', d);
    toast(res.notified === 0
      ? (d.licensed_only ? 'No licensed companies nearby — see options below' : 'No providers cover this area yet')
      : `${res.notified} provider${res.notified===1?'':'s'} notified${res.expanded ? ' (search radius expanded)' : ''}`);
    nav('d-active', { activeRequestId: res.request.id });
  } catch(e){ btn.disabled = false; }
}
// The bit a stranded driver actually cares about: somebody is coming, and this is
// when. The countdown ticks locally off the ETA the tech set, so it stays honest
// without polling, and it turns red rather than negative once the ETA passes.
function onTheWayCard(w){
  if (!w) return '';
  if (w.completed) return '';
  if (w.arrived) return `
    <div class="card" style="border-color:var(--red); background:var(--red-tint)">
      <div class="row"><b class="mini k" style="font-size:15px">${ic('check',16)} ${esc(w.tech_name || w.company)} is on scene</b></div>
      <div class="mini" style="margin-top:5px; color:#8c5057">${esc(w.company)}${w.tech_phone ? ' · ' + esc(w.tech_phone) : ''}</div>
    </div>`;
  const setAt = new Date(w.eta_set_at).getTime();
  const left = Math.round((setAt + (w.eta_minutes || 0) * 60000 - Date.now()) / 60000);
  const overdue = left < 0;
  startEtaTicker();
  return `
  <div class="card" style="border-color:var(--red)">
    <div class="row">
      <div>
        <b class="mini k" style="font-size:15px">${ic('truck',16)} ${esc(w.tech_name || w.company)} is on the way</b>
        <div class="faint" style="margin-top:4px">${esc(w.company)}${w.tech_phone ? ` · <a href="tel:${esc(w.tech_phone)}" style="color:var(--red); font-weight:700">${esc(w.tech_phone)}</a>` : ''}</div>
      </div>
      <div style="text-align:right">
        <div id="etaNum" style="font-size:30px; font-weight:800; letter-spacing:-1px; line-height:1; color:${overdue ? 'var(--red)' : 'var(--ink)'}">
          ${overdue ? Math.abs(left) : Math.max(0, left)}</div>
        <div class="faint" style="font-size:11px">${overdue ? 'min overdue' : 'min away'}</div>
      </div>
    </div>
  </div>`;
}
let etaTimer = null;
function startEtaTicker(){
  if (etaTimer) return;
  etaTimer = setInterval(() => {
    if (S.view !== 'd-active') { clearInterval(etaTimer); etaTimer = null; return; }
    render();
  }, 30000);
}

async function vDActive(){
  const d = await api('GET', '/requests/' + S.activeRequestId);
  const r = d.request;
  const filled = d.responders.length;
  return `
  <button class="back" onclick="nav('d-home')">${ic('chevL',15)} Home</button>
  <h2 class="scr">${r.status==='open' ? 'Help is on the way' : 'Request #'+r.id}</h2>
  <p class="scrsub">Request #${r.id} · ${esc(r.service_label)} · ${timeAgo(r.created_at)} · ${r.notified_count} compan${r.notified_count===1?'y':'ies'} alerted</p>
  ${onTheWayCard(d.on_the_way)}
  <div class="card">
    <div class="row"><span class="sec">Response Slots</span><span class="pill red">${filled ? filled + ' of 4 responded' : 'notifying…'}</span></div>
    <div class="slots">${[0,1,2].map(i=>`<i class="${i<Math.min(filled,3)?'f':''}"></i>`).join('')}<i class="${filled>3?'p':''}" style="${filled>3?'':'opacity:.55'}"></i></div>
    <div class="faint" style="margin-top:7px">3 standard slots + 1 premium slot · you choose the winner</div>
  </div>
  ${(r.licensed_only || (r.trade_filter||[]).length) && r.notified_count === 0 && r.status === 'open' ? `
    <div class="card alert">
      <div class="mini" style="line-height:1.55">${ic('warn',14)} <b class="k">Nobody matched your filters.</b>
      You narrowed this request, and no company nearby fits — so nobody was alerted.</div>
      <div style="height:10px"></div>
      <button class="btn" onclick="openToAll(${r.id})">Send to all approved companies instead</button>
    </div>` : ''}
  ${r.notified_count === 0 && r.status === 'open' && !(r.licensed_only || (r.trade_filter||[]).length) && (r.duty_class && r.duty_class !== 'heavy') ? `
    <div class="card alert">
      <div class="mini" style="line-height:1.55">${ic('warn',14)} <b class="k">No ${r.duty_class === 'medium' ? 'medium' : 'light'}-duty companies cover this area yet.</b>
      The shops nearby have told us they only work on heavy trucks. Your request stays open in case one widens their coverage — call around in the meantime.</div>
    </div>` : ''}
  ${filled === 0 && !((r.licensed_only || (r.trade_filter||[]).length) && r.notified_count === 0) && !(r.notified_count === 0 && r.duty_class && r.duty_class !== 'heavy') ? `<div class="card" style="text-align:center"><span class="muted">${ic('clock',13)} Waiting for providers to respond… you'll get a text the second one does.</span></div>` : ''}
  ${filled > 0 && r.status === 'open' ? `<div class="card alert">
    <div class="mini" style="line-height:1.55">${ic('chat',14)} <b class="k">Message them before you choose.</b> Ask for an ETA and a price, then compare. Choosing is final — it ends the request and tells the other companies they didn't get it.</div>
  </div>` : ''}
  ${d.responders.map(x=>`
    <div class="resp">
      <div class="row"><div>
        <span class="nm" style="cursor:pointer" onclick="nav('d-pubprofile',{viewProviderId:${x.provider_id}})">${esc(x.name)} <span style="color:var(--faint)">›</span></span>
        <div>${star5(Math.round(x.rating || 0))} <span class="faint">${x.rating ?? 'New'} · ${x.jobs_won} jobs${x.premium ? ' · premium responder' : ''}</span>
        ${x.primary_trade ? ` <span class="pill red" style="font-size:9.5px">${esc(tradeLabel(x.primary_trade).toUpperCase())}</span>` : ''}
        ${x.license_verified ? ` <span class="pill dark" style="font-size:9.5px">${ic('check',10)} LICENSED</span>` : ''}</div>
      </div>${r.selected_provider===x.provider_id ? '<span class="pill solid">CHOSEN</span>' : ''}</div>
      ${x.quote ? `<div class="quote"><span>Quoted: ${esc(x.quote.note || '')} ${x.quote.eta ? '· ETA '+esc(fmtEta(x.quote.eta)) : ''}</span><b class="k">${fmt$(x.quote.amount_cents)}</b></div>` : `<div class="quote"><span>No quote yet — chat with them</span><b style="color:var(--muted)">…</b></div>`}
      <div class="actions">
        <button class="btn chat" onclick="nav('d-chat',{chatKey:{r:${r.id},p:${x.provider_id}}})">${ic('chat',15)} Chat first</button>
        ${r.status==='open' ? `<button class="btn choose" onclick="askChoose(${r.id},${x.provider_id},'${esc(x.name).replace(/'/g,"")}')">${ic('check',15)} Choose</button>` : ''}
      </div>
    </div>`).join('')}
  ${r.status==='selected' ? `
    <button class="btn dark" onclick="completeRequest(${r.id})">${ic('check',16)} Mark job complete</button>` : ''}
  ${r.status==='completed' ? `
    <div class="card click" onclick="nav('d-rate',{rateRequestId:${r.id}})"><div class="row"><span class="mini k">${ic('star',14)} &nbsp;Rate this provider</span><span style="color:var(--red)">${ic('arrowR',16)}</span></div></div>` : ''}
  ${r.status==='open' ? `<button class="btn ghost" onclick="cancelRequest(${r.id})">Cancel request</button>` : ''}`;
}
async function openToAll(reqId){
  const res = await api('POST', `/requests/${reqId}/open-to-all`);
  toast(`${res.notified} more compan${res.notified===1?'y':'ies'} notified`);
  render();
}
function askChoose(reqId, provId, name){
  const el = document.createElement('div');
  el.className = 'modalwrap';
  el.id = 'confirmWrap';
  el.innerHTML = `
    <div class="modal">
      <h3>Choose this company?</h3>
      <p>They get your exact location and mile marker, and they're on their way.</p>
      <div class="who"><b class="k">${esc(name)}</b></div>
      <p>${ic('warn',13)} This can't be undone. The other companies will be told they didn't get the job, and your request closes to new responders.</p>
      <p>If you haven't asked for an ETA and price yet, chat with them first.</p>
      <div class="acts">
        <button class="btn ghost" onclick="closeConfirm()">Not yet</button>
        <button class="btn" onclick="confirmChoose(${reqId},${provId})">Yes, choose them</button>
      </div>
    </div>`;
  el.addEventListener('click', e => { if (e.target === el) closeConfirm(); });
  document.body.appendChild(el);
}
function closeConfirm(){ $('confirmWrap')?.remove(); }
async function confirmChoose(reqId, provId){
  closeConfirm();
  await api('POST', `/requests/${reqId}/select`, { provider_id: provId });
  toast('Chosen — they have your location now, the others were told');
  render();
}
async function completeRequest(reqId){
  await api('POST', `/requests/${reqId}/complete`);
  toast('Job marked complete'); render();
}
async function cancelRequest(reqId){
  await api('POST', `/requests/${reqId}/cancel`);
  toast('Request cancelled'); nav('d-home');
}
async function vDPubProfile(){
  const p = await api('GET', `/providers/${S.viewProviderId}/public`);
  const total = Math.max(1, p.rating_count);
  const bd = n => (p.breakdown.find(b=>b.stars===n)?.n) || 0;
  return `
  <button class="back" onclick="history.length ? nav('d-active') : nav('d-home')">${ic('chevL',15)} Back</button>
  <div class="cols2" style="margin-top:8px"><div>
  <div class="card" style="text-align:center; padding:22px">
    <b class="k" style="font-size:17px">${esc(p.name)}</b>
    <div style="margin-top:4px">${star5(Math.round(p.rating||0))} <b class="k" style="font-size:15px">${p.rating ?? ''}</b>
      <span class="faint">· ${p.rating_count ? p.rating_count + ' reviews' : 'New to RIGRX'} · ${p.jobs_won} jobs</span></div>
    ${p.primary_trade ? `<div class="muted" style="margin-top:6px">${esc(tradeLabel(p.primary_trade))}</div>` : ''}
    <div class="chips" style="justify-content:center; margin-top:12px">
      ${p.license_verified ? `<span class="pill dark">${ic('check',11)} License verified</span>` : '<span class="pill gray">License not verified</span>'}
      ${(p.badges||[]).map(b=>`<span class="pill dark">${esc(b)}</span>`).join('')}
      ${CAPS.filter(([k])=>p.capabilities?.[k]).map(([,label])=>`<span class="pill gray">${esc(label)}</span>`).join('')}
      <span class="pill gray">${esc(p.hours)}</span>
    </div>
  </div>
  <div class="card">
    <span class="sec">Rating breakdown</span>
    <div style="margin-top:10px">
      ${[5,4,3,2,1].map(n=>`
      <div class="row" style="margin-bottom:6px; gap:10px">
        <span class="mini" style="width:10px">${n}</span>
        <div style="flex:1; height:6px; border-radius:99px; background:var(--soft)"><div style="width:${Math.round(bd(n)/total*100)}%; height:6px; border-radius:99px; background:var(--red)"></div></div>
        <span class="faint" style="width:26px; text-align:right">${bd(n)}</span>
      </div>`).join('')}
    </div>
  </div>
  <div class="card">
    <span class="sec">Coverage</span>
    <div class="mini" style="margin-top:7px; line-height:1.8">${p.locations.map(l=>esc(l.label)+' ('+l.radius_mi+' mi)').join('<br>') || '—'}</div>
  </div>
  </div><div>
  <div class="card">
    <span class="sec">Recent reviews</span>
    ${p.reviews.map(rv=>`<div class="checkrow"><div><div>${star5(rv.stars)} <span class="faint">${timeAgo(rv.created_at)} · ${esc(rv.service_label)}</span></div>${rv.comment?`<div class="mini" style="margin-top:3px">"${esc(rv.comment)}"</div>`:''}</div></div>`).join('') || '<div class="faint" style="margin-top:8px">No reviews yet — new to RIGRX</div>'}
  </div>
  </div></div>`;
}
function vDRate(){
  S.rateStars = S.rateStars || 5;
  return `
  <button class="back" onclick="nav('d-home')">${ic('chevL',15)} Home</button>
  <h2 class="scr">How was the service?</h2>
  <p class="scrsub">Request #${S.rateRequestId}</p>
  <div class="card" style="text-align:center; padding:24px">
    <div class="stars" id="rateStars" style="gap:6px; justify-content:center">
      ${[1,2,3,4,5].map(n=>`<svg class="ic fill" width="34" height="34" viewBox="0 0 24 24" style="cursor:pointer; opacity:${n<=S.rateStars?1:.25}" onclick="S.rateStars=${n}; render()">${PATHS.star}</svg>`).join('')}
    </div>
    <div class="muted" style="margin-top:8px">${['','Poor','Fair','Good','Very good','Excellent'][S.rateStars]}</div>
  </div>
  <label class="f">What stood out?</label>
  <div class="chips" id="rate-tags">
    ${['Fast response','Fair price','Professional','Fixed right the first time','Good communication'].map(t=>`<span class="chip" onclick="tog(this)">${t}</span>`).join('')}
  </div>
  <label class="f">Comment (optional)</label>
  <textarea rows="3" id="rate-comment" placeholder="How did it go?"></textarea>
  <div style="height:16px"></div>
  <button class="btn" onclick="submitReview()">Submit review</button>`;
}
async function submitReview(){
  await api('POST', '/reviews', { request_id: S.rateRequestId, stars: S.rateStars,
    tags: selOf('rate-tags'), comment: qv('rate-comment') });
  toast('Thanks — your review is live on their profile');
  nav('d-home');
}
// Removing a rig only affects the garage. Requests already sent keep their own
// snapshot of the truck, so deleting one never rewrites past history.
async function removeTruck(id, label){
  if (!confirm(`Remove ${label || 'this truck'} from your garage?\n\nRequests you have already sent keep their details — this only stops it appearing when you ask for help.`)) return;
  await api('DELETE', '/trucks/' + id);
  await loadMe(); toast('Truck removed'); render();
}
async function removeTrailer(id, label){
  if (!confirm(`Remove ${label || 'this trailer'} from your garage?\n\nRequests you have already sent keep their details — this only stops it appearing when you ask for help.`)) return;
  await api('DELETE', '/trailers/' + id);
  await loadMe(); toast('Trailer removed'); render();
}
async function vDGarage(){
  return `
  <h2 class="scr">My Garage</h2>
  <p class="scrsub">Saved rigs make requests take 30 seconds</p>
  <div class="cols2"><div>
  ${S.trucks.map(x=>`<div class="card">
    <div class="row"><b class="mini k" style="display:inline-flex;align-items:center;gap:7px">${ic('truck')} ${esc(x.data.unit) ? 'Unit '+esc(x.data.unit)+' — ' : ''}${esc(x.data.year)} ${esc(x.data.make)} ${esc(x.data.model)} ${dutyPill(x.data.duty)}</b>
      <span style="display:inline-flex; gap:12px">
        <span class="faint" style="cursor:pointer" onclick='S.editTruck={id:${x.id},...${JSON.stringify(x.data)}}; nav("d-setup2")'>${ic('edit',13)} Edit</span>
        <span class="faint" style="cursor:pointer; color:var(--red)" onclick='removeTruck(${x.id}, "${esc((x.data.year||"") + " " + (x.data.make||"") + " " + (x.data.model||"")).trim().replace(/"/g,"")}")'>${ic('trash',13)} Delete</span>
      </span></div>
    <div class="faint" style="margin-top:7px; line-height:1.7">Engine: ${esc(x.data.engine)} · ${esc(x.data.trans)} · ${esc(x.data.axles)}<br>Tires: ${esc(x.data.steer)} / ${esc(x.data.drive)} · ${esc(x.data.wheels)}</div>
  </div>`).join('') || '<div class="card"><a onclick="S.editTruck=null; nav(\'d-setup2\')">+ Add your truck</a></div>'}
  </div><div>
  ${S.trailers.map(x=>`<div class="card">
    <div class="row"><b class="mini k" style="display:inline-flex;align-items:center;gap:7px">${ic('trailer')} Trailer ${esc(x.data.num)} — ${esc(x.data.type)}</b>
      <span style="display:inline-flex; gap:12px">
        <span class="faint" style="cursor:pointer" onclick='S.editTrailer={id:${x.id},...${JSON.stringify(x.data)}}; nav("d-setup3")'>${ic('edit',13)} Edit</span>
        <span class="faint" style="cursor:pointer; color:var(--red)" onclick='removeTrailer(${x.id}, "${esc((x.data.type||"trailer") + " " + (x.data.num||"")).trim().replace(/"/g,"")}")'>${ic('trash',13)} Delete</span>
      </span></div>
    <div class="faint" style="margin-top:7px; line-height:1.7">${esc(x.data.len)} · ${esc(x.data.axles)} · Tires: ${esc(x.data.tires)}<br>${x.data.hazmat ? 'Hazmat: Class '+esc(x.data.hzClass)+' · UN '+esc(x.data.un) : 'No hazmat'}</div>
  </div>`).join('') || '<div class="card"><a onclick="S.editTrailer=null; nav(\'d-setup3\')">+ Add your trailer</a></div>'}
  </div></div>
  <div class="row" style="gap:8px">
    <button class="btn ghost" onclick="S.editTruck=null; nav('d-setup2')">+ Add truck</button>
    <button class="btn ghost" onclick="S.editTrailer=null; nav('d-setup3')">+ Add trailer</button>
  </div>`;
}

/* ---------------- shared: message threads & chat ---------------- */
async function vThreads(){
  const rows = await api('GET', '/messages/threads');
  return `
  <h2 class="scr">Messages</h2>
  <p class="scrsub">${rows.length ? 'One thread per request & company' : 'No conversations yet'}</p>
  ${rows.map(t=>`<div class="card click" onclick="openThread(${t.request_id},${t.provider_id})">
    <div class="row"><div><b class="mini k">${esc(t.other_name || 'Conversation')}</b>
    <div class="faint">Request #${t.request_id} · ${esc(t.service_label)}${t.last_body ? ' — '+esc(t.last_body.slice(0,60)) : ''}</div></div>
    <span class="pill ${t.status==='open'?'red':'gray'}">${esc(t.status)}</span></div></div>`).join('')}`;
}
function openThread(reqId, provId){
  S.chatKey = { r: reqId, p: provId };
  nav(S.me.role === 'provider' ? 'p-chat' : 'd-chat');
}
async function chatView(backView){
  const { r, p } = S.chatKey;
  const d = await api('GET', `/messages/${r}/${p}`);
  const mine = uid => uid === S.me.id;
  return `
  <button class="back" onclick="nav('${backView}')">${ic('chevL',15)} Back</button>
  <div class="card" style="margin-top:8px"><div class="row"><b class="k">Request #${r} · ${esc(d.request.service_label)}</b>
    <span class="pill ${d.request.status==='open'?'red':'dark'}">${esc(d.request.status.toUpperCase())}</span></div></div>
  ${S.me.role !== 'provider' && d.request.status === 'open' ? `<div class="card alert" style="margin-top:10px">
    <div class="mini" style="line-height:1.5">${ic('lock',13)} Keep your exact spot to yourself until you pick someone — they already have the distance they need to quote you. Once you choose, they get the pin automatically.</div>
  </div>` : ''}
  <div class="chatbox" id="chatlog">
    ${d.messages.map(m=>`
      <div class="msg ${m.quote ? 'quotecard' : ''} ${mine(m.sender_id) ? 'me' : 'them'}">
        ${m.quote ? `${ic('tag',14)} <b class="k">QUOTE — ${fmt$(m.quote.amount_cents)}</b>${m.quote.eta ? ' · ETA '+esc(fmtEta(m.quote.eta)) : ''}${m.quote.note ? ' · '+esc(m.quote.note) : ''}` : esc(m.body)}
        <span class="t">${timeAgo(m.created_at)}</span>
      </div>`).join('') || '<div class="faint" style="text-align:center; padding:20px">Say hello — the other side is notified instantly</div>'}
  </div>
  ${S.me.role === 'provider' ? `
  <div class="card" style="margin-top:12px">
    <span class="sec">Send a structured quote</span>
    <div class="row" style="gap:8px; margin-top:8px">
      <input type="text" id="q-amt" placeholder="$ amount" style="flex:1">
      <input type="text" id="q-eta" placeholder="ETA (35 min)" style="flex:1">
      <button class="btn dark" style="width:auto; padding:12px 14px" onclick="sendQuote()">${ic('tag',14)} Quote</button>
    </div>
  </div>` : ''}
  <div class="chatin"><input type="text" id="chatIn" placeholder="Type a message…" onkeydown="if(event.key==='Enter')sendChat()"><button onclick="sendChat()">${ic('send',17)}</button></div>`;
}
async function sendChat(){
  const body = qv('chatIn').trim();
  if (!body) return;
  await api('POST', `/messages/${S.chatKey.r}/${S.chatKey.p}`, { body });
  render();
}
async function sendQuote(){
  const amt = Math.round(parseFloat(qv('q-amt').replace(/[^0-9.]/g,'')) * 100);
  if (!amt) return toast('Enter a dollar amount');
  await api('POST', `/messages/${S.chatKey.r}/${S.chatKey.p}`, {
    body: '', quote: { amount_cents: amt, eta: qv('q-eta'), note: '' } });
  toast('Quote sent'); render();
}
/* ---------------- provider onboarding ---------------- */
const CITIES = [
  ['Bakersfield, CA',35.3733,-119.0187],['Fresno, CA',36.7378,-119.7871],['Visalia, CA',36.3302,-119.2921],
  ['Buttonwillow, CA',35.4021,-119.4718],['Lost Hills, CA',35.6164,-119.6943],['Mojave, CA',35.0525,-118.1739],
  ['Barstow, CA',34.8958,-117.0173],['Lancaster, CA',34.6868,-118.1542],['Santa Clarita, CA',34.3917,-118.5426],
  ['Los Angeles, CA',34.0549,-118.2426],['Stockton, CA',37.9577,-121.2908],['Sacramento, CA',38.5816,-121.4944]
];


// Picking a trade badges the company AND pre-checks the services that trade
// normally performs — one decision instead of two.
function pickTrade(el){
  togOne(el);
  const t = tradeByKey(el.dataset.key);
  if (!t) return;
  for (const [catKey, items] of Object.entries(t.presets || {})) {
    const group = $('svc-' + catKey);
    if (!group) continue;
    [...group.querySelectorAll('.chip')].forEach(chip => {
      if (items.includes(chip.textContent.trim())) chip.classList.add('sel');
    });
  }
  toast(t.label + ' — typical services checked, adjust anything below');
}

/* Yes/no flags that make matching precise without a long form. */
const CAPS = [
  ['scale',   'Works at weigh stations & inspection facilities'],
  ['hazmat',  'Will service placarded hazmat loads'],
  ['loaded',  'Will service a loaded trailer'],
  ['tanker',  'Services cargo tanks / tankers'],
  ['rotator', 'Has a rotator or heavy wrecker'],
  ['aluminum','Aluminum welding capable'],
  ['tires_stocked', 'Carries tire inventory on the truck']
];

function vPSetup1(){
  const p = S.provider || {};
  return authShell(`
  ${isSetUpProvider() ? setupTop(null, null, 'p-settings') : ''}
  ${progress(1,5)}
  <h2 class="scr">Tell us about your company</h2>
  <p class="scrsub">Step 1 of 5 · leads start the day you're approved</p>
  <label class="f">Business name</label><input type="text" id="po-name" value="${esc(p.name)}">
  <div class="grid2">
    <div><label class="f">Dispatch phone (text alerts)</label><input type="text" id="po-phone" value="${esc(p.dispatch_phone || S.me?.phone)}"></div>
    <div><label class="f">After-hours phone</label><input type="text" id="po-after" value="${esc(p.after_phone)}"></div>
  </div>
  <label class="f">Dispatch email</label><input type="text" id="po-email" value="${esc(p.email)}">
  <label class="f">Hours</label>
  <div class="chips" id="po-hours"><span class="chip ${p.hours!=='Scheduled'?'sel':''}" onclick="togOne(this)">24 / 7</span><span class="chip ${p.hours==='Scheduled'?'sel':''}" onclick="togOne(this)">Scheduled</span></div>
  <div style="height:16px"></div>
  <button class="btn" onclick="savePSetup1()">Continue ${ic('arrowR',15)}</button>`);
}
async function savePSetup1(){
  if (!qv('po-name').trim()) return toast('Enter your business name');
  S.provider = await api('PUT', '/provider/profile', {
    name: qv('po-name'), dispatch_phone: qv('po-phone'), after_phone: qv('po-after'),
    email: qv('po-email'), hours: selOf('po-hours')[0] || '24 / 7' });
  await loadMe();
  nav('p-setup2');
}
function vPSetup2(){
  const locs = S.provider?.locations || [];
  return authShell(`
  ${isSetUpProvider()
    ? setupTop('p-settings', 'Settings', 'p-feed')
    : setupTop('p-setup1', 'Back')}
  ${progress(2,5)}
  <h2 class="scr">Locations & coverage</h2>
  <p class="scrsub">Step 2 of 5 — you get every lead inside ANY location's radius</p>
  ${locs.map(l=>`
  <div class="card">
    <div class="row"><b class="mini k">${ic('pin',14)} ${esc(l.label)}</b>
      <span style="display:inline-flex; align-items:center; gap:8px"><span class="pill red">${l.radius_mi} mi radius</span>
      <a class="faint" onclick="delLocation(${l.id})">remove</a></span></div>
  </div>`).join('') || '<div class="card alert"><div class="mini">Add at least one location — this is how leads find you.</div></div>'}
  <div class="card" style="border-style:dashed">
    <span class="sec">Add a location</span>
    <label class="f">City / base</label>
    <select id="loc-city">${CITIES.map(c=>`<option value="${c[1]},${c[2]}">${c[0]}</option>`).join('')}</select>
    <div class="grid2">
      <div><label class="f">Label</label><input type="text" id="loc-label" placeholder="Bakersfield — HQ"></div>
      <div><label class="f">Service radius (miles)</label><input type="text" id="loc-radius" value="50"></div>
    </div>
    <label class="f">Location phone (optional)</label><input type="text" id="loc-phone" placeholder="(661) 555-0000">
    <div style="height:10px"></div>
    <button class="btn dark" onclick="addLocation()">+ Add location</button>
  </div>
  <button class="btn" onclick="${locs.length ? "nav('p-setup3')" : "toast('Add at least one location first')"}">Continue ${ic('arrowR',15)}</button>`, true);
}
async function addLocation(){
  const [lat, lng] = qv('loc-city').split(',').map(Number);
  const cityName = $('loc-city').selectedOptions[0].textContent;
  await api('POST', '/provider/locations', {
    label: qv('loc-label') || cityName, lat, lng,
    radius_mi: parseInt(qv('loc-radius')) || 50, phone: qv('loc-phone') });
  await loadMe(); toast('Location added'); render();
}
async function delLocation(id){
  await api('DELETE', '/provider/locations/' + id);
  await loadMe(); render();
}
function vPSetup3(){
  const services = S.provider?.services || {};
  return authShell(`
  ${isSetUpProvider()
    ? setupTop('p-settings', 'Settings', 'p-feed')
    : setupTop('p-setup2', 'Back')}
  ${progress(3,5)}
  <h2 class="scr">What services do you offer?</h2>
  <p class="scrsub">Step 3 of 5 — start with what kind of shop you are, then adjust. More boxes = more leads; your rating keeps it honest.</p>
  <div class="card" style="border-color:var(--red)">
    <span class="sec">What kind of company are you?</span>
    <div class="faint" style="margin:6px 0 10px">This becomes your badge on RIGRX, and it checks the services that trade usually performs. Drivers can choose to send a request only to companies whose main work matches.</div>
    <div class="chips" id="p-trade">
      ${(S.trades||[]).map(t=>`<span class="chip ${t.key===(S.provider?.primary_trade||'')?'sel':''}" data-key="${t.key}" onclick="pickTrade(this)">${ic(t.icon,14)} ${esc(t.label)}</span>`).join('')}
    </div>
  </div>
  ${(S.catalog||[]).map(c=>`
  <div class="card">
    <span class="sec">${esc(c.label)}</span>
    <div class="chips" style="margin-top:9px" id="svc-${c.key}">
      ${c.items.map(i=>`<span class="chip ${selectedFor(services, c).includes(i.label)?'sel':''}" onclick="tog(this)">${esc(i.label)}</span>`).join('')
        || '<span class="faint">No services listed under this category yet</span>'}
    </div>
  </div>`).join('')}
  <div class="card" style="border-style:dashed">
    <span class="sec">Something we didn't list?</span>
    <div class="row" style="margin-top:10px; gap:8px">
      <input type="text" id="custom-svc" placeholder="e.g. Mobile alignment" style="flex:1">
      <button class="btn dark" style="width:auto; padding:12px 16px" onclick="addCustomSvc()">Add</button>
    </div>
    <div class="chips" style="margin-top:10px">
      ${(S.provider?.custom||[]).map(c=>`<span class="chip sel">${esc(c.name)} <span class="faint">(${c.status})</span></span>`).join('')}
    </div>
    <div class="faint" style="margin-top:8px">Custom services go to RIGRX for approval, then join the catalog for everyone</div>
  </div>
  <button class="btn" onclick="savePSetup3()">Continue ${ic('arrowR',15)}</button>`, true);
}
async function addCustomSvc(){
  const name = qv('custom-svc').trim();
  if (!name) return;
  await api('POST', '/provider/custom-service', { name });
  await loadMe(); toast(`"${name}" added — pending RIGRX approval`); render();
}
// Selections may still be stored under an old category label; read either.
function selectedFor(services, cat){
  return (services?.[cat.key] || services?.[cat.label] || []);
}
async function savePSetup3(){
  const services = {};
  for (const c of (S.catalog||[])) services[c.key] = selOf('svc-' + c.key);
  if (!Object.values(services).some(v=>v.length)) return toast('Select at least one service');
  const trade = $('p-trade')?.querySelector('.chip.sel')?.dataset.key || '';
  if (!trade) return toast('Pick what kind of company you are first');
  await api('PUT', '/provider/profile', { services, primary_trade: trade });
  await loadMe();
  nav('p-setup4');
}
function vPSetup4(){
  const e = S.provider?.equipment || {};
  const c = S.provider?.capabilities || {};
  return authShell(`
  ${isSetUpProvider()
    ? setupTop('p-settings', 'Settings', 'p-feed')
    : setupTop('p-setup3', 'Back')}
  ${progress(4,5)}
  <h2 class="scr">Equipment & capacity</h2>
  <p class="scrsub">Step 4 of 5 — drivers see this as proof you can handle the job</p>
  <div class="card" style="margin-bottom:16px">
    <span class="sec">Truck sizes you work on</span>
    <div class="faint" style="margin:6px 0 10px">Pick every class you'll take. Leads outside your picks never reach you — and medium duty is a busy market most heavy-only shops skip.</div>
    <div class="chips" id="p-duty">
      ${(EQ().SERVED_CLASSES || []).map(d=>`<span class="chip ${(S.provider?.duty_classes || ['heavy','medium']).includes(d.key)?'sel':''}" data-k="${d.key}" onclick="tog(this)">${esc(d.label)}</span>`).join('')}
    </div>
  </div>
  <div class="grid2">
    <div><label class="f">Heavy wreckers</label><input type="text" id="eq-wreckers" value="${esc(e.wreckers)}"></div>
    <div><label class="f">Rotator</label><input type="text" id="eq-rotator" value="${esc(e.rotator)}" placeholder="No / Yes — 60 ton"></div>
  </div>
  <div class="grid2">
    <div><label class="f">Service trucks</label><input type="text" id="eq-service" value="${esc(e.service)}"></div>
    <div><label class="f">Landoll / traveling axle</label><input type="text" id="eq-landoll" value="${esc(e.landoll)}"></div>
  </div>
  <div class="grid2">
    <div><label class="f">Tire trucks</label><input type="text" id="eq-tire" value="${esc(e.tiretrucks)}"></div>
    <div><label class="f">Fuel trucks</label><input type="text" id="eq-fuel" value="${esc(e.fueltrucks)}"></div>
  </div>
  <div class="card" style="margin-top:18px">
    <span class="sec">What can you take on?</span>
    <div class="faint" style="margin:6px 0 10px">Seven quick answers that send you the right leads and keep the wrong ones away.</div>
    <div class="chips" id="p-caps">
      ${CAPS.map(([k,label])=>`<span class="chip ${c[k]?'sel':''}" data-k="${k}" onclick="tog(this)">${label}</span>`).join('')}
    </div>
  </div>
  <div style="height:8px"></div>
  <button class="btn" onclick="savePSetup4()">Continue ${ic('arrowR',15)}</button>`);
}
async function savePSetup4(){
  const caps = {};
  [...($('p-caps')?.querySelectorAll('.chip') || [])].forEach(ch => {
    if (ch.classList.contains('sel')) caps[ch.dataset.k] = true;
  });
  const duty = [...($('p-duty')?.querySelectorAll('.chip.sel') || [])].map(c => c.dataset.k);
  if (!duty.length) return toast('Pick at least one truck size you work on');
  await api('PUT', '/provider/profile', { capabilities: caps, duty_classes: duty, equipment: {
    wreckers: qv('eq-wreckers'), rotator: qv('eq-rotator'), service: qv('eq-service'),
    landoll: qv('eq-landoll'), tiretrucks: qv('eq-tire'), fueltrucks: qv('eq-fuel') } });
  await loadMe();
  nav('p-setup5');
}
function vPSetup5(){
  const v = S.provider?.verification || {};
  return authShell(`
  ${isSetUpProvider()
    ? setupTop('p-settings', 'Settings', 'p-feed')
    : setupTop('p-setup4', 'Back')}
  ${progress(5,5)}
  <h2 class="scr">Verification & billing</h2>
  <p class="scrsub">Step 5 of 5 — drivers trust RIGRX because every company is vetted</p>
  <label class="f">Business / tow license #</label>
  <input type="text" id="vf-license" value="${esc(v.license)}" placeholder="CA-TOW-88412">
  <label class="f">Certificate of insurance (PDF or photo)</label>
  <label class="chip dashed" style="cursor:pointer; display:inline-flex">${v.coi_file ? '✓ Uploaded — replace' : '+ Upload COI'}<input type="file" style="display:none" onchange="uploadDoc(this,'coi_file')"></label>
  <label class="f">W-9 (PDF or photo)</label>
  <label class="chip dashed" style="cursor:pointer; display:inline-flex">${v.w9_file ? '✓ Uploaded — replace' : '+ Upload W-9'}<input type="file" style="display:none" onchange="uploadDoc(this,'w9_file')"></label>
  <div class="card alert" style="margin-top:16px">
    <div class="mini" style="line-height:1.55">${ic('card',13)} <b class="k">Card on file:</b> ${S.simulatedPayments ? 'payments are in simulation mode until Stripe keys are added — no card needed to test.' : 'you will be asked for a card before your first lead purchase.'}</div>
  </div>
  <div class="card alert">
    <div class="mini" style="line-height:1.55">${ic('clock',13)} Your account goes to <b class="k">RIGRX review</b> (usually same day). You can browse masked leads right away — buying unlocks once you're approved.</div>
  </div>
  <button class="btn" onclick="savePSetup5()">${ic('check',16)} Submit & open my dashboard</button>`);
}
async function uploadDoc(input, key){
  if (!input.files[0]) return;
  const fd = new FormData(); fd.append('file', input.files[0]);
  const res = await fetch('/api/upload', { method: 'POST', body: fd });
  const data = await res.json();
  if (data.url){
    const v = { ...(S.provider?.verification || {}), [key]: data.url };
    await api('PUT', '/provider/profile', { verification: v });
    await loadMe(); toast('Uploaded'); render();
  }
}
async function savePSetup5(){
  const v = { ...(S.provider?.verification || {}), license: qv('vf-license') };
  await api('PUT', '/provider/profile', { verification: v });
  await loadMe();
  toast('Application submitted — pending RIGRX approval');
  nav('p-feed');
}

/* ---------------- provider app ---------------- */
function pendingBanner(approved){
  return approved ? '' : `<div class="card alert">
    <div class="mini k">${ic('clock',14)} Account pending RIGRX approval — you can browse masked leads, but buying unlocks after approval.</div></div>`;
}
async function vPFeed(){
  const d = await api('GET', '/leads');
  return `
  <h2 class="scr">Live Leads</h2>
  <p class="scrsub">Open requests inside your coverage that match your services</p>
  ${pendingBanner(d.approved)}
  ${d.approved && !d.license_verified ? `<div class="card alert">
    <div class="mini" style="line-height:1.55">${ic('warn',14)} <b class="k">Your license isn't verified yet.</b>
    ${d.missed_licensed_leads ? `You missed <b class="k">${d.missed_licensed_leads} lead${d.missed_licensed_leads===1?'':'s'}</b> this week from drivers who asked for licensed companies only.` : 'Some drivers request licensed companies only, and those leads stay hidden from you.'}
    Add your license number and insurance in <a onclick="nav('p-setup5')">Settings</a> and RIGRX will review it.</div>
  </div>` : ''}
  ${d.leads.length ? `<div class="cols2"><div>` +
    d.leads.filter((_,i)=>i%2===0).map(leadCard).join('') + `</div><div>` +
    d.leads.filter((_,i)=>i%2===1).map(leadCard).join('') +
    `<div class="card" style="border-style:dashed; text-align:center"><span class="faint">${ic('mobile',12)} text + ${ic('bell',12)} live alert the second a matching lead drops</span></div></div></div>`
  : `<div class="card" style="text-align:center; padding:26px"><span class="muted">${ic('clock',14)} No open leads in your area right now.<br><span class="faint">You'll get a text the moment one drops. Widen your radius or add services in Settings to see more.</span></span></div>`}`;
}
// A one-word size badge so a heavy-only shop can tell at a glance what rolled in
function dutyPill(cls){
  if (!cls || cls === 'heavy') return '<span class="pill gray" style="margin-right:6px">HEAVY</span>';
  if (cls === 'medium') return '<span class="pill dark" style="margin-right:6px">MEDIUM DUTY</span>';
  return '<span class="pill dark" style="margin-right:6px">LIGHT DUTY</span>';
}
function leadCard(l){
  return `<div class="lead" onclick="nav('p-lead',{leadId:${l.id}})">
    <div class="row"><span class="ty">${ic(svcIcon(l.service_key))} ${esc(l.service_label)}</span><span class="pill ${l.slots.total===0?'solid':'gray'}">${timeAgo(l.created_at)}</span></div>
    <div class="mini" style="margin:8px 0 3px">${dutyPill(l.duty_class)}${esc(l.truck_class)} + <b class="k">${esc(l.trailer_type)}${l.hazmat ? ' (hazmat)' : ''}</b> · ${l.can_move==='no' ? "can't move" : 'can move'}</div>
    ${l.tire_position ? `<div class="mini" style="margin:3px 0"><b class="k" style="color:var(--red)">${esc([l.tire_position.axle, l.tire_position.side, l.tire_position.position].filter(x=>x && x!=='Single').join(' · '))}</b>${l.tire_position.size ? ' — '+esc(l.tire_position.size) : ''}${l.tire_position.problem ? ' · '+esc(l.tire_position.problem) : ''}</div>` : ''}
    ${(l.spec||[]).length ? `<div class="faint" style="margin:3px 0">${l.spec.slice(0,3).map(x=>esc(x.k)+': '+esc(x.v)).join(' · ')}</div>` : ''}
    <div class="muted mini">${ic('pin',12)} ${esc(l.area_label)} · <b class="k">${l.band} from you</b></div>
    <div class="slots">${[0,1,2].map(i=>`<i class="${i<l.slots.standard?'f':''}"></i>`).join('')}<i class="${l.slots.total>3?'p':''}" style="${l.premium||l.slots.total>3?'':'opacity:.5'}"></i></div>
    <div class="row" style="margin-top:10px">
      ${l.purchased ? `<span class="pill solid">YOURS</span><span class="unlockprice">Open ›</span>`
        : l.premium ? `<span class="pill dark">SOLD OUT — PREMIUM OPEN</span><span class="unlockprice" style="color:var(--ink)">Force in ${fmt$(l.price_cents)} ›</span>`
        : `<span class="pill red">${l.slots.standardLeft} of 3 slots left</span><span class="unlockprice">Unlock ${fmt$(l.price_cents)} ›</span>`}
    </div>
  </div>`;
}
async function vPLead(){
  const l = await api('GET', '/leads/' + S.leadId);
  const full = l.full;
  return `
  <button class="back" onclick="nav('p-feed')">${ic('chevL',15)} All leads</button>
  <div class="row" style="margin-top:8px"><h2 class="scr" style="margin:0; display:flex; align-items:center; gap:8px">${ic(svcIcon(l.service_key),21)} Lead #${l.id}</h2>
    ${l.purchased ? '<span class="pill solid">UNLOCKED</span>' : ''}</div>
  <p class="scrsub" style="margin-top:4px">${esc(l.service_label)} · posted ${timeAgo(l.created_at)} ·
    ${l.purchased ? 'respond fast to win the job' : l.premium ? '<b style="color:var(--ink)">premium slot only</b>' : `<b style="color:var(--red)">${l.slots.standardLeft} of 3 slots left</b>`}</p>
  <div class="cols2"><div>
  <div class="card">
    <div class="mini listline">
      <span class="muted">Rig</span> &nbsp;${dutyPill(l.duty_class)}${esc(l.truck_class)} + ${esc(l.trailer_type)}<br>
      <span class="muted">Hazmat</span> &nbsp;${l.hazmat ? `<span style="color:var(--red);font-weight:700">Yes — Class ${esc(l.hazmat_info?.class)}, UN ${esc(l.hazmat_info?.un)}</span>` : 'No'}<br>
      <span class="muted">Mobility</span> &nbsp;${l.can_move==='no' ? "Can't move under own power" : l.can_move==='short' ? 'Can limp a short distance' : 'Can move'}<br>
      <span class="muted">Area</span> &nbsp;${esc(l.area_label)}<br>
      <span class="muted">Driver rating</span> &nbsp;${l.driver_rating ? star5(Math.round(l.driver_rating)) + ' ' + l.driver_rating + ' as rated by providers' : 'New driver'}
    </div>
  </div>
  ${l.tire_position ? `<div class="card" style="border-color:var(--red)">
    <span class="sec">${ic('tire',13)} The failed tire</span>
    <div class="mini listline" style="margin-top:6px">
      <span class="muted">Position</span> &nbsp;<b class="k">${esc([l.tire_position.axle, l.tire_position.side, l.tire_position.position].filter(x=>x && x!=='Single').join(' · '))}</b><br>
      <span class="muted">Size</span> &nbsp;<b class="k">${esc(l.tire_position.size || 'not on file')}</b><br>
      ${l.tire_position.wheel ? `<span class="muted">Wheel</span> &nbsp;${esc(l.tire_position.wheel)}<br>` : ''}
      <span class="muted">Problem</span> &nbsp;${esc(l.tire_position.problem || '—')}
    </div>
  </div>` : ''}
  ${(l.spec||[]).length ? `<div class="card">
    <span class="sec">Equipment on this rig</span>
    <div class="mini listline" style="margin-top:6px">
      ${l.spec.map(x=>`<span class="muted">${esc(x.k)}</span> &nbsp;${esc(x.v)}`).join('<br>')}
    </div>
  </div>` : ''}
  ${l.capability_warning ? `<div class="card alert"><div class="mini">${ic('warn',14)} ${esc(l.capability_warning)}</div></div>` : ''}
  ${full ? `
  <div class="card">
    <div class="row"><b class="k">${esc(full.driver_name)}</b><b style="color:var(--red);display:inline-flex;align-items:center;gap:5px">${ic('phone',14)} ${esc(full.driver_phone)}</b></div>
    <div class="divider"></div>
    <div class="mini listline">
      ${full.won ? `
        <span class="muted">Exact spot</span> &nbsp;<b class="k">${esc(full.landmark || (full.lat.toFixed(4)+', '+full.lng.toFixed(4)))}</b><br>
`
      : `
        <span class="muted">Distance</span> &nbsp;<b class="k">${full.distance_mi != null ? full.distance_mi + ' mi · about ' + full.eta_min + ' min' : 'add a location in Settings'}</b><br>
        <span class="muted">Exact spot</span> &nbsp;<span style="color:var(--muted)">${ic('lock',12)} unlocks if the driver picks you</span><br>`}
      <span class="muted">Problem</span> &nbsp;"${esc(full.description || '—')}"<br>
      <span class="muted">Truck</span> &nbsp;${esc([full.truck.year, full.truck.make, full.truck.model, full.truck.engine, full.truck.color].filter(Boolean).join(' · ') || '—')}<br>
      <span class="muted">Trailer</span> &nbsp;${esc([full.trailer.type, full.trailer.len].filter(Boolean).join(' · ') || '—')}<br>
      <span class="muted">Photos</span> &nbsp;${(full.photos||[]).map(p=>`<a href="${esc(p)}" target="_blank">${ic('camera',13)} view</a>`).join(' · ') || 'none'}
    </div>
    ${full.won ? `<div class="divider"></div>${directions(full.lat, full.lng)}`
      : `<div class="divider"></div><div class="faint" style="line-height:1.5">${ic('lock',12)} You have the driver and the distance so you can quote accurately. The exact pin and mile marker unlock the moment they choose you — that keeps four trucks from rolling to the same breakdown.</div>`}
  </div>` : `
  <div class="card">
    <span class="sec">${ic('lock',13)} Unlocks when you buy</span>
    <div class="mini locked" style="margin-top:9px; line-height:1.8">
      Driver name & direct phone number<br>
      Exact GPS pin + landmark / mile marker<br>
      Full truck & trailer specs + photos<br>
      Instant in-app chat with the driver
    </div>
  </div>`}
  </div><div>
  ${full ? `
  <button class="btn" onclick="openThread(${l.id}, ${S.me.id})">${ic('chat',16)} Message the driver now</button>
  <div style="height:8px"></div>
  ${l.selected_provider === S.me.id ? '<div class="card alert"><b class="mini k">The driver chose YOU for this job</b></div>' : ''}
  ` : `
  <div class="card alert"><div class="mini" style="line-height:1.55">${ic('zap',13)} First 3 buyers get this lead at the standard price. After that, one final <b class="k">premium slot</b> at 2×. Max 4 companies ever see this driver's info.</div></div>
  <button class="btn big" id="buyBtn" onclick="buyLead(this)">${ic('unlock',17)} ${l.premium ? 'FORCE IN' : 'UNLOCK LEAD'} — ${fmt$(l.price_cents)}</button>
  <div class="faint" style="text-align:center; margin-top:9px">${S.simulatedPayments ? 'Payment simulation mode — no real charge' : ic('card',12) + ' Charged to your card on file'} · unreachable-driver refund policy applies</div>`}
  </div></div>`;
}
async function buyLead(btn){
  btn.disabled = true; btn.textContent = 'Processing…';
  try {
    const res = await api('POST', `/leads/${S.leadId}/buy`);
    toast(`Lead unlocked — you're responder ${res.slot} of 4${res.simulated ? ' (simulated payment)' : ''}`);
    render();
  } catch(e){ render(); }
}
async function vPMyLeads(){
  const rows = await api('GET', '/myleads');
  const f = S.leadFilter || '';
  const shown = f === 'won' ? rows.filter(x => x.won)
              : f === 'open' ? rows.filter(x => x.request_status === 'open' && !x.won)
              : rows;
  const spent = shown.filter(x=>!x.refunded).reduce((a,x)=>a+x.amount_cents, 0);
  const heads = { '': ['My Leads', "Everything you've purchased"],
                  'won': ['Jobs won', 'Leads where the driver chose you'],
                  'open': ['Still open', "Leads the driver hasn't chosen anyone for yet — chase these"],
                  'spend': ['Lead spend', 'Every purchase, newest first'] };
  const h = heads[f] || heads[''];
  return `
  ${f ? `<button class="back" onclick="nav('p-stats')">${ic('chevL',15)} Stats</button>` : ''}
  <h2 class="scr">${h[0]}</h2>
  <p class="scrsub">${h[1]}</p>
  ${f ? `<div class="tiles"><div class="tile"><div class="l">Showing</div><div class="v">${shown.length}</div>
      <div class="d">of ${rows.length} lead${rows.length===1?'':'s'} bought</div></div>
    <div class="tile"><div class="l">Spent on these</div><div class="v">${fmt$(spent)}</div></div></div>` : ''}
  ${shown.map(x=>`<div class="card click" onclick="nav('p-lead',{leadId:${x.request_id}})">
    <div class="row"><div><b class="mini k">Lead #${x.request_id} — ${esc(x.service_label)}</b>
      <div class="faint">${esc(x.area_label)} · bought ${timeAgo(x.created_at)} · ${fmt$(x.amount_cents)}${x.premium ? ' (premium)' : ''}${x.refunded ? ' · REFUNDED' : ''}</div></div>
    <span class="pill ${x.won ? 'solid' : x.request_status==='open' ? 'red' : 'gray'}">${x.won ? 'WON' : esc(x.request_status)}</span></div>
  </div>`).join('') || `<div class="card" style="text-align:center"><span class="muted">${
      f === 'won' ? "No wins yet — chat fast and quote clearly, that's what gets you chosen"
    : f === 'open' ? 'Nothing open right now'
    : 'No leads purchased yet — check Live Leads'}</span></div>`}`;
}
/* ---------------- directions ---------------- */
// Hand navigation off to whatever the person already uses rather than routing trucks
// ourselves. Google Maps is preinstalled on Android; on iPhone the default is Apple
// Maps and Google has to be downloaded — so the big button follows the platform and
// the alternates sit underneath for anyone with a preference.
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function mapLinks(lat, lng){
  return {
    google: `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`,
    apple:  `https://maps.apple.com/?daddr=${lat},${lng}&dirflg=d`,
    waze:   `https://waze.com/ul?ll=${lat},${lng}&navigate=yes`
  };
}

// Big primary button + small alternates + the raw coordinates, which matter when a
// tech is reading them to someone over the phone or typing them into a truck nav unit.
function directions(lat, lng, opts = {}){
  if (lat == null || lng == null) return '';
  const L = mapLinks(lat, lng);
  const ios = isIOS();
  const primary = ios ? { href: L.apple, label: 'Apple Maps' } : { href: L.google, label: 'Google Maps' };
  const alts = ios ? [['Google Maps', L.google], ['Waze', L.waze]]
                   : [['Apple Maps', L.apple], ['Waze', L.waze]];
  const coords = `${(+lat).toFixed(5)}, ${(+lng).toFixed(5)}`;
  return `
  <a class="btn ${opts.subtle ? 'ghost' : 'dark'}" style="display:block; text-align:center; text-decoration:none"
     href="${primary.href}" target="_blank" rel="noopener">${ic('pin',16)} Get directions</a>
  <div class="row" style="gap:10px; margin-top:8px; flex-wrap:wrap; justify-content:flex-start">
    <span class="faint">Open in:</span>
    ${alts.map(([n,h])=>`<a href="${h}" target="_blank" rel="noopener" class="faint" style="color:var(--red); font-weight:600">${n}</a>`).join('')}
    <span class="faint" style="cursor:pointer; margin-left:auto" onclick="copyCoords('${coords}')" title="Copy the coordinates">${coords} ${ic('folder',11)}</span>
  </div>`;
}
function copyCoords(text){
  navigator.clipboard?.writeText(text).then(
    () => toast('Coordinates copied'),
    () => toast(text));
}

/* ---------------- company people & jobs ---------------- */
const memberRole = () => (S.me?.member_role || (S.me?.role === 'provider' ? 'owner' : ''));
const isTech    = () => memberRole() === 'tech';
const isOwner   = () => memberRole() === 'owner';

const ROLE_LABEL = { owner: 'Owner', dispatcher: 'Dispatcher', tech: 'Technician' };

async function vPPeople(){
  const rows = await api('GET', '/provider/members');
  const locs = S.provider?.locations || [];
  const locOpts = ['<option value="">Any yard</option>'].concat(
    locs.map(l=>`<option value="${l.id}">${esc(l.label || 'Yard ' + l.id)}</option>`)).join('');
  return `
  <h2 class="scr">Your team</h2>
  <p class="scrsub">Everyone signs in with their own mobile number — no passwords to hand out or reset</p>
  ${isOwner() ? `
  <div class="card">
    <span class="sec">Add someone</span>
    <div class="grid2" style="margin-top:8px">
      <div><label class="f" style="margin-top:0">Name</label><input type="text" id="mb-name" placeholder="Dale Prescott"></div>
      <div><label class="f" style="margin-top:0">Mobile number</label><input type="tel" id="mb-phone" placeholder="(661) 555-0134"></div>
    </div>
    <div class="grid2">
      <div><label class="f">Role</label>
        <select id="mb-role">
          <option value="tech">Technician — sees only the jobs you give them</option>
          <option value="dispatcher">Dispatcher — gets lead alerts and hands work out</option>
        </select></div>
      <div><label class="f">Yard</label><select id="mb-loc">${locOpts}</select></div>
    </div>
    <div class="faint" style="margin:10px 0">A dispatcher tied to a yard is only alerted for leads near that yard. Leave it on "Any yard" to hear about everything.</div>
    <button class="btn" onclick="addMember()">${ic('plus',16)} Add to team &amp; text them the link</button>
  </div>` : ''}

  ${rows.filter(m=>!m.archived_at).map(m=>`
    <div class="card">
      <div class="row"><div>
        <b class="mini k">${esc(m.name || m.phone)}</b>
        <span class="pill ${m.member_role==='owner'?'solid':m.member_role==='dispatcher'?'red':'gray'}" style="margin-left:6px">${ROLE_LABEL[m.member_role] || m.member_role}</span>
        <div class="faint" style="margin-top:3px">${esc(m.phone)}${m.location_label ? ' · ' + esc(m.location_label) : ' · any yard'}${m.assignable ? ' · can be assigned jobs' : ''}</div>
      </div>
      ${isOwner() && m.member_role !== 'owner' ? `
        <button class="btn ghost" style="width:auto; padding:9px 14px; font-size:12px" onclick="removeMember(${m.id},'${esc(m.name||m.phone).replace(/'/g,'')}')">Remove</button>` : ''}
      </div>
    </div>`).join('')}

  <div class="card" style="background:var(--soft)">
    <div class="mini" style="line-height:1.6">
      <b class="k">Owner</b> runs the account — billing, coverage, services and this page.<br>
      <b class="k">Dispatcher</b> gets the lead alerts for their yard, buys leads, talks to drivers and assigns jobs.<br>
      <b class="k">Technician</b> sees only the jobs assigned to them — never the lead feed, never what anything cost.
    </div>
  </div>`;
}
async function addMember(){
  const name = qv('mb-name').trim(), phone = qv('mb-phone').trim();
  if (!name || !phone) return toast('Name and mobile number both needed');
  await api('POST', '/provider/members', { name, phone,
    member_role: $('mb-role').value, member_location_id: $('mb-loc').value || null });
  toast(name + ' added — we texted them a sign-in link');
  render();
}
async function removeMember(id, name){
  if (!confirm(`Remove ${name} from your team?\n\nThey lose access immediately. Any job they had open goes back to your queue.`)) return;
  const r = await api('DELETE', '/provider/members/' + id);
  toast(r.unassigned_jobs ? `Removed — ${r.unassigned_jobs} job${r.unassigned_jobs===1?'':'s'} back in the queue` : 'Removed');
  render();
}

/* ---------------- dispatcher: the job queue ---------------- */
const jobState = j =>
  j.completed_at ? { k:'done',    t:'COMPLETE',  c:'gray' }
: j.arrived_at   ? { k:'arrived', t:'ON SCENE',  c:'solid' }
: j.enroute_at   ? { k:'enroute', t:'ON THE WAY',c:'solid' }
: j.accepted_at  ? { k:'accepted',t:'ACCEPTED',  c:'dark' }
: j.assigned_tech? { k:'assigned',t:'WAITING TO ACCEPT', c:'red' }
:                  { k:'new',     t:'NEEDS A TECH', c:'red' };

async function vPJobs(){
  const d = await api('GET', '/jobs');
  const live = d.jobs.filter(j=>!j.completed_at), done = d.jobs.filter(j=>j.completed_at);
  const techOpts = j => d.techs.map(t=>`<option value="${t.id}" ${t.id===j.assigned_tech?'selected':''}>${esc(t.name || t.phone)}</option>`).join('');
  const card = j => {
    const st = jobState(j);
    return `
    <div class="card ${st.k==='new'||j.assign_bounced ? 'alert' : ''}">
      <div class="row"><div>
        <b class="mini k">Job #${j.id} — ${esc(j.service_label)}</b>
        <div class="faint" style="margin-top:3px">${esc(j.driver_name || 'Driver')} · ${esc(j.driver_phone||'')} · ${esc(j.area_label)} · won ${timeAgo(j.created_at)}</div>
      </div><span class="pill ${st.c}">${st.t}</span></div>
      ${j.assign_bounced && !j.assigned_tech ? `<div class="mini" style="color:var(--red); margin-top:7px">${ic('warn',13)} Nobody accepted this — it came back to you. Reassign it.</div>` : ''}
      ${j.tech_name ? `<div class="mini" style="margin-top:7px">${ic('user',13)} ${esc(j.tech_name)}${j.eta_minutes && st.k==='enroute' ? ` · ETA ${j.eta_minutes} min` : ''}</div>` : ''}
      ${!j.completed_at ? `<div class="mini" style="margin-top:9px">${ic('pin',12)} ${esc(j.landmark || j.area_label)}</div>
        <div style="margin-top:8px">${directions(j.lat, j.lng, { subtle:true })}</div>` : ''}
      ${!j.completed_at ? `
      <div class="row" style="gap:8px; margin-top:10px; flex-wrap:wrap">
        <select id="as-${j.id}" style="flex:1; min-width:150px">
          <option value="">Assign to…</option>${techOpts(j)}
        </select>
        <button class="btn dark" style="width:auto; padding:11px 16px; font-size:13px" onclick="assignJob(${j.id})">
          ${j.assigned_tech ? 'Reassign' : 'Assign'}</button>
      </div>` : ''}
    </div>`;
  };
  return `
  <h2 class="scr">Jobs</h2>
  <p class="scrsub">Work you won — assign it to someone and watch it move</p>
  ${!d.techs.length ? `<div class="card alert"><div class="mini">${ic('warn',14)} Nobody on your team can be assigned work yet. Add your techs in <a onclick="nav('p-people')">Your team</a>.</div></div>` : ''}
  ${live.length ? live.map(card).join('') : '<div class="card" style="text-align:center"><span class="muted">No live jobs. Buy a lead and win it and it lands here.</span></div>'}
  ${done.length ? `<div style="height:16px"></div><span class="sec">Completed (${done.length})</span>${done.map(card).join('')}` : ''}`;
}
async function assignJob(id){
  const techId = $('as-' + id)?.value;
  if (!techId) return toast('Pick someone first');
  await api('POST', `/jobs/${id}/assign`, { tech_id: Number(techId) });
  toast('Assigned — we texted them');
  render();
}

/* ---------------- technician: one screen, only their work ---------------- */
async function vTechJobs(){
  const rows = await api('GET', '/tech/jobs');
  const live = rows.filter(j=>!j.completed_at), done = rows.filter(j=>j.completed_at);
  const card = j => {
    const st = jobState(j);
    const tp = j.tire_position;
    return `
    <div class="card">
      <div class="row"><div><b class="mini k">${esc(j.service_label)}</b>
        <div class="faint" style="margin-top:3px">${esc(j.area_label)}</div></div>
        <span class="pill ${st.c}">${st.t}</span></div>

      ${!j.accepted_at ? `
        <div class="mini" style="margin:10px 0">${esc(j.duty_class === 'medium' ? 'Medium duty' : j.duty_class === 'light' ? 'Light duty' : 'Heavy duty')} · ${esc(j.truck?.make || '')} ${esc(j.truck?.model || '')}</div>
        <div class="row" style="gap:8px">
          <button class="btn" onclick="jobAction(${j.id},'accept')">${ic('check',16)} Accept this job</button>
          <button class="btn ghost" style="width:auto; padding:13px 16px" onclick="jobAction(${j.id},'decline')">Can't take it</button>
        </div>` : `
        <div class="mini listline" style="margin:10px 0; line-height:1.9">
          <span class="muted">Driver</span> &nbsp;<b class="k">${esc(j.driver_name || '')}</b> ·
            <a href="tel:${esc(j.driver_phone||'')}" style="color:var(--red); font-weight:700">${esc(j.driver_phone||'')}</a><br>
          <span class="muted">Where</span> &nbsp;${esc(j.landmark || j.area_label)}<br>
          <span class="muted">Problem</span> &nbsp;${esc(j.description || j.service_label)}<br>
          ${tp ? `<span class="muted">Tire</span> &nbsp;<b class="k" style="color:var(--red)">${esc([tp.axle, tp.side, tp.position].filter(x=>x&&x!=='Single').join(' · '))}</b>${tp.size ? ' — ' + esc(tp.size) : ''}<br>` : ''}
          ${(() => { const rig = [j.truck?.year, j.truck?.make, j.truck?.model].filter(Boolean).join(' ');
            const tr = j.trailer?.type ? ' + ' + j.trailer.type : '';
            return (rig || tr) ? `<span class="muted">Rig</span> &nbsp;${esc(rig)}${esc(tr)}${j.trailer?.hazmat ? ' <span style="color:var(--red); font-weight:700">(HAZMAT)</span>' : ''}` : ''; })()}
        </div>
        <div style="margin-bottom:12px">${directions(j.lat, j.lng)}</div>
        ${!j.enroute_at ? `
          <div class="row" style="gap:8px">
            <input type="number" id="eta-${j.id}" placeholder="ETA min" value="30" style="width:110px">
            <button class="btn" onclick="jobEnroute(${j.id})">${ic('truck',16)} On my way</button>
          </div>`
        : !j.arrived_at ? `
          <div class="mini" style="margin-bottom:8px">${ic('clock',13)} Driver is expecting you in about ${j.eta_minutes} min</div>
          <div class="row" style="gap:8px">
            <button class="btn" onclick="jobAction(${j.id},'arrived')">${ic('check',16)} I've arrived</button>
            <button class="btn ghost" style="width:auto; padding:13px 16px" onclick="jobLate(${j.id})">Running late</button>
          </div>`
        : `<button class="btn" onclick="jobAction(${j.id},'complete')">${ic('check',16)} Job complete</button>`}
      `}
    </div>`;
  };
  return `
  <h2 class="scr">My jobs</h2>
  <p class="scrsub">${live.length ? 'Tap Accept, then keep the driver posted' : 'Nothing assigned right now'}</p>
  ${live.map(card).join('') || '<div class="card" style="text-align:center"><span class="muted">No jobs assigned to you yet. Your dispatcher will send one over — you\'ll get a text.</span></div>'}
  ${done.length ? `<div style="height:16px"></div><span class="sec">Finished (${done.length})</span>
    ${done.slice(0,10).map(j=>`<div class="card"><div class="row"><div><b class="mini k">${esc(j.service_label)}</b>
      <div class="faint">${esc(j.area_label)} · ${timeAgo(j.completed_at)}</div></div>
      <span class="pill gray">COMPLETE</span></div></div>`).join('')}` : ''}`;
}
async function jobAction(id, action){
  if (action === 'decline' && !confirm("Hand this job back to your dispatcher?")) return;
  await api('POST', `/jobs/${id}/${action}`);
  toast({ accept:'Accepted', decline:'Sent back to dispatch', arrived:'Driver has been told you arrived',
          complete:'Job closed — the driver has been asked to rate you' }[action] || 'Done');
  render();
}
async function jobEnroute(id){
  const eta = Number(qv('eta-' + id)) || 30;
  await api('POST', `/jobs/${id}/enroute`, { eta_minutes: eta });
  toast('Driver notified — they can see your ETA counting down');
  render();
}
async function jobLate(id){
  const mins = prompt('How many more minutes?', '15');
  if (mins === null) return;
  await api('POST', `/jobs/${id}/late`, { eta_minutes: Number(mins) || 15 });
  toast('Driver has been updated');
  render();
}

async function vPStats(){
  const s = await api('GET', '/provider/stats');
  const days = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  const week = days.map(d => [d, s.week.find(w=>w.day.trim()===d)?.n || 0]);
  const max = Math.max(1, ...week.map(w=>w[1]));
  return `
  <h2 class="scr">${esc(S.provider?.name || 'My Company')}</h2>
  <p class="scrsub">Performance on RIGRX</p>
  <div class="tiles">
    ${pTile('Leads bought', s.leads_bought, 'tap for the list', "'p-myleads'", "{leadFilter:''}")}
    ${pTile('Jobs won', s.jobs_won, s.win_rate + '% win rate', "'p-myleads'", "{leadFilter:'won'}")}
    ${pTile('Lead spend', fmt$(s.spend_cents), 'every purchase', "'p-myleads'", "{leadFilter:'spend'}")}
    ${pTile('Your rating', s.rating ?? '—', `${s.rating_count} review${s.rating_count===1?'':'s'} from drivers`, "'p-reviews'")}
    ${pTile('Cost per job won', s.cost_per_win_cents == null ? '—' : fmt$(s.cost_per_win_cents),
        s.cost_per_win_cents == null ? 'win one to see this' : 'lead spend per job you won', "'p-myleads'", "{leadFilter:'won'}")}
    ${pTile('Avg reply time', s.avg_reply_mins == null ? '—' : s.avg_reply_mins + ' min',
        s.never_replied ? s.never_replied + ' bought but never messaged' : 'from buying to first message', "'p-myleads'", "{leadFilter:''}")}
  </div>
  <div class="cols2"><div>
  <div class="card">
    <span class="sec">Leads bought — last 7 days</span>
    <div class="bars7">
      ${week.map(w=>`<div class="b"><span class="val">${w[1]||''}</span><div class="bar" style="height:${Math.round(w[1]/max*100)}%"></div><span class="lb">${w[0]}</span></div>`).join('')}
    </div>
  </div></div><div>
  <div class="card">
    <span class="sec">What these numbers mean</span>
    <div class="mini listline" style="margin-top:8px; line-height:1.9">
      <span class="muted">Win rate</span> &nbsp;How often the driver picked you after you bought. Chatting first and quoting a clear ETA is what moves this.<br>
      <span class="muted">Cost per job won</span> &nbsp;Total lead spend divided by jobs won. Compare it to what an average job is worth to you — that's whether RIGRX pays.<br>
      <span class="muted">Avg reply time</span> &nbsp;How long you take to message the driver after buying. The first company to respond wins most of the time.
    </div>
  </div></div></div>`;
}
// Same clickable tile the admin dashboard uses, so every number opens its data.
function pTile(label, value, sub, view, extra){
  return `
  <div class="tile click" onclick="nav(${view}${extra ? ',' + extra : ''})">
    <div class="row"><div class="l">${label}</div><span style="color:var(--faint)">${ic('arrowR',13)}</span></div>
    <div class="v">${value}</div>${sub ? `<div class="d">${sub}</div>` : ''}
  </div>`;
}
async function vPReviews(){
  const d = await api('GET', '/provider/reviews');
  const total = d.reviews.length;
  const avg = total ? (d.reviews.reduce((a,r)=>a+r.stars,0)/total).toFixed(1) : null;
  const countFor = n => d.breakdown.find(b=>b.stars===n)?.n || 0;
  const tagCounts = {};
  d.reviews.forEach(r => (r.tags||[]).forEach(t => tagCounts[t] = (tagCounts[t]||0)+1));
  const topTags = Object.entries(tagCounts).sort((a,b)=>b[1]-a[1]);
  return `
  <button class="back" onclick="nav('p-stats')">${ic('chevL',15)} Stats</button>
  <h2 class="scr">What drivers said</h2>
  <p class="scrsub">Every rating left for you, and the job it came from</p>
  ${total ? `
  <div class="cols2"><div>
  <div class="card">
    <div class="row"><div>
      <div style="font-size:40px; font-weight:800; letter-spacing:-1.5px; line-height:1">${avg}</div>
      <div>${star5(Math.round(avg))}</div>
      <div class="faint" style="margin-top:3px">${total} review${total===1?'':'s'}</div>
    </div></div>
    <div class="divider"></div>
    ${[5,4,3,2,1].map(n=>`
      <div class="row" style="margin:5px 0"><span class="mini" style="width:44px">${n} star</span>
        <span style="flex:1; height:7px; background:var(--soft); border-radius:4px; overflow:hidden; margin:0 10px">
          <span style="display:block; height:100%; width:${Math.round(countFor(n)/total*100)}%; background:var(--red)"></span></span>
        <span class="faint" style="width:22px; text-align:right">${countFor(n)}</span></div>`).join('')}
  </div>
  ${topTags.length ? `<div class="card">
    <span class="sec">What they mention most</span>
    <div class="chips" style="margin-top:9px">
      ${topTags.map(([t,n])=>`<span class="chip sel">${esc(t)} · ${n}</span>`).join('')}
    </div>
  </div>` : ''}
  </div><div>
  ${d.reviews.map(r=>`
    <div class="card click" onclick="nav('p-lead',{leadId:${r.request_id}})">
      <div class="row"><div>${star5(r.stars)}</div>
        <span class="faint">${timeAgo(r.created_at)}</span></div>
      ${r.comment ? `<div class="mini" style="margin-top:6px">"${esc(r.comment)}"</div>` : ''}
      ${(r.tags||[]).length ? `<div class="chips" style="margin-top:8px">${r.tags.map(t=>`<span class="chip">${esc(t)}</span>`).join('')}</div>` : ''}
      <div class="faint" style="margin-top:7px">Lead #${r.request_id} · ${esc(r.service_label)} · ${esc(r.area_label)}</div>
    </div>`).join('')}
  </div></div>` : `
  <div class="card" style="text-align:center">
    <span class="muted">No reviews yet. Drivers are asked to rate you after they mark the job complete —
    the fastest way to your first one is to win a job and do it well.</span>
  </div>`}`;
}
async function vPSettings(){
  const p = S.provider || {};
  const svcCount = Object.values(p.services || {}).reduce((a,b)=>a+(b?.length||0),0);
  return `
  <h2 class="scr">Company Settings</h2>
  <p class="scrsub">What you do & where you cover controls which leads you see</p>
  ${pendingBanner(p.approved)}
  <div class="cols2"><div>
  <div class="card">
    <div class="row"><span class="sec">Company</span><span class="faint" style="cursor:pointer" onclick="nav('p-setup1')">${ic('edit',13)} Edit</span></div>
    <div class="mini" style="margin-top:7px; line-height:1.8"><b class="k">${esc(p.name)}</b>${p.primary_trade ? ` <span class="pill red">${esc(tradeLabel(p.primary_trade).toUpperCase())}</span>` : ' <span class="pill gray">NO TRADE SET</span>'}<br>${esc(p.dispatch_phone)} · ${esc(p.email)}<br>${esc(p.hours)}</div>
  </div>
  <div class="card">
    <div class="row"><span class="sec">Locations & coverage</span><span class="faint" style="cursor:pointer" onclick="nav('p-setup2')">${ic('edit',13)} Edit</span></div>
    ${(p.locations||[]).map(l=>`<div class="checkrow"><span class="cico on">${ic('pin',15)}</span><div class="mini"><b class="k">${esc(l.label)}</b><div class="faint">${l.radius_mi} mi radius${l.phone ? ' · '+esc(l.phone) : ''}</div></div></div>`).join('') || '<div class="faint" style="margin-top:8px">No locations yet</div>'}
  </div>
  <div class="card">
    <div class="row"><span class="sec">Services offered (${svcCount})</span><span class="faint" style="cursor:pointer" onclick="nav('p-setup3')">${ic('edit',13)} Edit</span></div>
    ${Object.entries(p.services||{}).filter(([,v])=>v?.length).map(([k,items])=>`
      <div class="checkrow"><span class="cico on">${ic('check',15)}</span><div class="mini"><b class="k">${esc(catByKey(k)?.label || k)}</b><div class="faint">${items.map(esc).join(' · ')}</div></div></div>`).join('') || '<div class="faint" style="margin-top:8px">No services selected yet</div>'}
  </div>
  </div><div>
  <div class="card">
    <div class="row"><span class="sec">Equipment & capabilities</span><span class="faint" style="cursor:pointer" onclick="nav('p-setup4')">${ic('edit',13)} Edit</span></div>
    <div class="chips" style="margin-top:7px">
      ${(p.duty_classes || ['heavy','medium']).map(k=>`<span class="pill red">${k === 'heavy' ? 'HEAVY' : k === 'medium' ? 'MEDIUM DUTY' : 'LIGHT DUTY'}</span>`).join('')}
    </div>
    <div class="mini" style="margin-top:7px; line-height:1.8">${['wreckers','rotator','service','landoll'].map(k=>p.equipment?.[k] ? esc(p.equipment[k]) + ' ' + k : '').filter(Boolean).join(' · ') || '—'}</div>
    <div class="chips" style="margin-top:10px">
      ${CAPS.filter(([k])=>p.capabilities?.[k]).map(([,label])=>`<span class="pill dark">${ic('check',10)} ${esc(label)}</span>`).join('') || '<span class="faint">No capability flags set — you may be missing matching leads</span>'}
    </div>
  </div>
  <div class="card">
    <div class="row"><span class="sec">Verification</span><span class="faint" style="cursor:pointer" onclick="nav('p-setup5')">${ic('edit',13)} Edit</span></div>
    <div class="checkrow"><span class="cico ${p.verification?.license?'on':''}">${ic('check',15)}</span><span class="mini">License ${p.verification?.license ? '— '+esc(p.verification.license) : '(add it)'}</span></div>
    <div class="checkrow"><span class="cico ${p.verification?.coi_file?'on':''}">${ic('check',15)}</span><span class="mini">Certificate of insurance ${p.verification?.coi_file ? '— uploaded' : '(upload)'}</span></div>
    <div class="checkrow"><span class="cico ${p.approved?'on':''}">${ic(p.approved?'check':'clock',15)}</span><span class="mini">${p.approved ? 'Approved — you can buy leads' : 'Pending RIGRX review'}</span></div>
    <div class="checkrow"><span class="cico ${p.license_verified?'on':''}">${ic(p.license_verified?'check':'clock',15)}</span><span class="mini">${p.license_verified ? 'License verified — you receive licensed-only leads' : 'License not verified — you miss licensed-only leads'}</span></div>
  </div>
  <div class="card"><span class="sec">Billing</span>
    <div class="mini" style="margin-top:7px; line-height:1.7">${S.simulatedPayments ? ic('zap',13)+' Payment simulation mode — connect Stripe keys to charge real cards' : ic('card',13)+' Card ····'+esc(p.card_last4 || '????')+' · one-tap lead purchase'}</div></div>
  </div></div>`;
}

/* ---------------- admin ---------------- */
async function vAHome(){
  const o = await api('GET', '/admin/overview');
  const tile = (label, value, sub, view, extra) => `
    <div class="tile click" onclick="nav('${view}'${extra ? ','+extra : ''})">
      <div class="row"><div class="l">${label}</div><span style="color:var(--faint)">${ic('arrowR',13)}</span></div>
      <div class="v">${value}</div>${sub ? `<div class="d">${sub}</div>` : ''}
    </div>`;
  return `
  <h2 class="scr">RIGRX Admin</h2>
  <p class="scrsub">The whole marketplace at a glance — click any number to see what's behind it</p>
  <div class="tiles">
    ${tile('Requests (24h)', o.requests_24h, 'tap for the list', 'a-requests', `{adminReqWindow:'24h'}`)}
    ${tile('Revenue (24h)', fmt$(o.revenue_24h_cents), 'every lead sold today', 'a-purchases', `{adminSalesWindow:'24h'}`)}
    ${tile('Revenue (total)', fmt$(o.revenue_total_cents), 'all lead sales', 'a-purchases', `{adminSalesWindow:''}`)}
    ${tile('Fill rate', o.fill_rate + '%', 'requests nobody bought', 'a-requests', `{adminReqWindow:'unfilled'}`)}
    ${tile('Drivers', o.drivers, 'who is requesting help', 'a-drivers')}
    ${tile('Providers', o.providers, `${o.pending_providers} awaiting approval`, 'a-providers')}
  </div>
  ${o.pending_providers ? `<div class="card click alert" onclick="nav('a-providers')"><div class="row"><span class="mini k">${ic('clock',14)} ${o.pending_providers} provider${o.pending_providers===1?'':'s'} waiting for approval</span><span style="color:var(--red)">${ic('arrowR',16)}</span></div></div>` : ''}`;
}
async function vADrivers(){
  const showArch = !!S.showArchived;
  const rows = await api('GET', '/admin/drivers' + (showArch ? '?archived=1' : ''));
  const archived = rows.filter(d=>d.archived_at), active = rows.filter(d=>!d.archived_at);
  const row = d => `<div class="card click" onclick="nav('a-driver',{adminDriverId:${d.id}})">
    <div class="row"><div><b class="mini k">${esc(d.name || '(no name yet)')}</b>
      <div class="faint">${esc(d.phone)}${d.company ? ' · '+esc(d.company) : ''} · ${d.requests} request${d.requests===1?'':'s'} · ${d.trucks} truck${d.trucks===1?'':'s'} · joined ${timeAgo(d.created_at)}</div></div>
    <span style="display:inline-flex; gap:8px; align-items:center">
      ${d.archived_at ? '<span class="pill dark">ARCHIVED</span>' : ''}
      <span class="pill ${d.revenue_cents?'solid':'gray'}">${fmt$(d.revenue_cents)} earned</span>
      <span style="color:var(--red)">${ic('arrowR',16)}</span></span>
  </div></div>`;
  return `
  <h2 class="scr">Drivers</h2>
  <p class="scrsub">Everyone who has requested help — click for their full history</p>
  ${active.map(row).join('') || '<div class="card"><span class="muted">No drivers yet</span></div>'}
  <div style="height:16px"></div>
  <div class="row"><span class="sec">Archived${showArch ? ` (${archived.length})` : ''}</span>
    <span class="faint" style="cursor:pointer" onclick="S.showArchived=${!showArch}; render()">${showArch ? 'Hide archived' : 'Show archived'} ›</span></div>
  ${showArch ? (archived.map(row).join('') || '<div class="card"><span class="muted">Nobody archived</span></div>') : ''}`;
}

/* ---------------- archive & restore (admin) ---------------- */
// No delete anywhere on purpose: removing a user would cascade away purchases other
// companies paid for and rewrite the revenue history. Archiving locks them out and
// hides them, and every record survives.
function archiveCard(userId, who, archivedAt, reason){
  if (archivedAt) return `
  <div class="card" style="border-color:var(--red)">
    <span class="sec" style="color:var(--red)">${ic('warn',13)} Archived</span>
    <div class="mini" style="margin:7px 0 4px">Archived ${timeAgo(archivedAt)}. They cannot sign in, receive alerts, or appear anywhere in the app.</div>
    ${reason ? `<div class="faint" style="margin-bottom:10px">Reason: ${esc(reason)}</div>` : '<div style="height:8px"></div>'}
    <button class="btn" onclick="restoreUser(${userId})">${ic('check',16)} Restore this account</button>
  </div>`;
  return `
  <div class="card">
    <span class="sec">Archive this ${who}</span>
    <div class="faint" style="margin:6px 0 10px; line-height:1.5">
      Locks them out immediately and hides them from every list, the lead feed and matching.
      Nothing is deleted — purchases, requests and reviews all stay, and you can restore them at any time.
    </div>
    <input type="text" id="arch-reason-${userId}" placeholder="Why? (optional, only you see this)">
    <div style="height:9px"></div>
    <button class="btn ghost" onclick="archiveUser(${userId}, '${who}')">${ic('box',15)} Archive</button>
  </div>`;
}
async function archiveUser(id, who){
  if (!confirm(`Archive this ${who}?\n\nThey will be signed out and locked out immediately, and will have to create a new account to come back. Nothing is deleted and you can restore them any time.`)) return;
  const reason = qv('arch-reason-' + id);
  const r = await api('POST', `/admin/users/${id}/archive`, { reason });
  toast(r.cancelled_requests ? `Archived — ${r.cancelled_requests} open request${r.cancelled_requests===1?'':'s'} closed` : 'Archived');
  render();
}
async function restoreUser(id){
  await api('POST', `/admin/users/${id}/restore`);
  toast('Restored — they can sign in again');
  render();
}

async function vADriver(){
  const d = await api('GET', '/admin/drivers/' + S.adminDriverId);
  const u = d.driver;
  return `
  <button class="back" onclick="nav('a-drivers')">${ic('chevL',15)} All drivers</button>
  <h2 class="scr" style="margin-top:8px">${esc(u.name || '(no name)')}${u.archived_at ? ' <span class="pill dark" style="font-size:10px; vertical-align:middle">ARCHIVED</span>' : ''}</h2>
  <p class="scrsub">${esc(u.phone)} · ${esc(u.driver_type || 'driver')} · joined ${timeAgo(u.created_at)}${u.rating ? ' · rated '+u.rating+' by providers' : ''}</p>
  <div class="cols2"><div>
  <div class="card">
    <span class="sec">Contact</span>
    <div class="mini listline" style="margin-top:6px">
      <span class="muted">Phone</span> &nbsp;${esc(u.phone)}<br>
      <span class="muted">Email</span> &nbsp;${esc(u.email || '—')}<br>
      <span class="muted">Company</span> &nbsp;${esc(u.company || '—')}
    </div>
  </div>
  ${archiveCard(u.id, 'driver', u.archived_at, u.archive_reason)}
  <div class="card">
    <span class="sec">Equipment on file</span>
    ${d.trucks.map(t=>`<div class="checkrow"><span class="cico on">${ic('truck',15)}</span><div class="mini"><b class="k">Unit ${esc(t.data.unit)} — ${esc(t.data.year)} ${esc(t.data.make)} ${esc(t.data.model)}</b><div class="faint">${esc(t.data.engine)} · ${esc(t.data.axles)} · tires ${esc(t.data.steer)} / ${esc(t.data.drive)}</div></div></div>`).join('')}
    ${d.trailers.map(t=>`<div class="checkrow"><span class="cico on">${ic('trailer',15)}</span><div class="mini"><b class="k">Trailer ${esc(t.data.num)} — ${esc(t.data.type)}</b><div class="faint">${t.data.hazmat ? 'Hazmat Class '+esc(t.data.hzClass)+' · UN '+esc(t.data.un) : 'No hazmat'}</div></div></div>`).join('')}
    ${!d.trucks.length && !d.trailers.length ? '<div class="faint" style="margin-top:8px">Nothing saved yet</div>' : ''}
  </div>
  </div><div>
  <div class="card">
    <span class="sec">Requests (${d.requests.length})</span>
    ${d.requests.map(r=>`<div class="checkrow" style="cursor:pointer" onclick="nav('a-request',{adminRequestId:${r.id}})">
      <span class="cico ${r.status==='open'?'on':''}">${ic(svcIcon(r.service_key),15)}</span>
      <div class="mini" style="flex:1"><b class="k">#${r.id} — ${esc(r.service_label)}</b>
      <div class="faint">${esc(r.area_label)} · ${r.buyers} bought · ${fmt$(r.revenue_cents)} · ${timeAgo(r.created_at)}</div></div>
      <span class="pill ${r.status==='open'?'red':'gray'}">${esc(r.status)}</span></div>`).join('') || '<div class="faint" style="margin-top:8px">No requests yet</div>'}
  </div>
  </div></div>`;
}
async function vAProviders(){
  const showArch = !!S.showArchived;
  const rows = await api('GET', '/admin/providers' + (showArch ? '?archived=1' : ''));
  const archived = rows.filter(p=>p.archived_at);
  const active = rows.filter(p=>!p.archived_at);
  const pending = active.filter(p=>!p.approved), live = active.filter(p=>p.approved);
  const row = p => `<div class="card click" onclick="nav('a-provider',{adminProviderId:${p.user_id}})">
    <div class="row"><div><b class="mini k">${esc(p.name || '(no name yet)')}</b>
      <div class="faint">${p.primary_trade ? esc(tradeLabel(p.primary_trade)) + ' · ' : ''}${esc(p.phone)} · ${p.location_count} location${p.location_count===1?'':'s'} ·
      License: ${p.verification?.license ? esc(p.verification.license) : 'none given'}</div></div>
    <span style="display:inline-flex; gap:6px; align-items:center">
      ${p.license_verified ? '<span class="pill dark">LICENSE VERIFIED</span>' : ''}
      ${p.archived_at ? '<span class="pill dark">ARCHIVED</span>' : p.approved ? '<span class="pill solid">APPROVED</span>' : '<span class="pill red">NEEDS REVIEW</span>'}
      <span style="color:var(--red)">${ic('arrowR',16)}</span>
    </span></div></div>`;
  return `
  <h2 class="scr">Providers</h2>
  <p class="scrsub">Click any company to see its full profile before you decide</p>
  ${pending.length ? `<span class="sec">Waiting for review (${pending.length})</span>${pending.map(row).join('')}<div style="height:14px"></div>` : ''}
  <span class="sec">Approved (${live.length})</span>
  ${live.map(row).join('') || '<div class="card"><span class="muted">None yet</span></div>'}
  <div style="height:16px"></div>
  <div class="row"><span class="sec">Archived${showArch ? ` (${archived.length})` : ''}</span>
    <span class="faint" style="cursor:pointer" onclick="S.showArchived=${!showArch}; render()">${showArch ? 'Hide archived' : 'Show archived'} ›</span></div>
  ${showArch ? (archived.map(row).join('') || '<div class="card"><span class="muted">Nobody archived</span></div>') : ''}
  ${await waitlistCard()}`;
}
// Companies that raised their hand from outside a live corridor. This list is the
// map of where to expand next, so it lives right under the approval queue.
async function waitlistCard(){
  let rows = [];
  try { rows = await api('GET', '/admin/waitlist'); } catch(e){ return ''; }
  const waiting = rows.filter(r => !r.contacted);
  return `
  <div style="height:22px"></div>
  <div class="row"><span class="sec">Coverage waitlist${waiting.length ? ' (' + waiting.length + ' not yet contacted)' : ''}</span></div>
  <div class="faint" style="margin:6px 0 10px">Companies who found the recruiting page from outside a live area. Where they cluster is where to open next.</div>
  ${rows.length ? rows.map(r=>`
    <div class="card" style="${r.contacted ? 'opacity:.55' : ''}">
      <div class="row"><div>
        <b class="mini k">${esc(r.company)}</b>${r.trade ? ` <span class="pill red" style="font-size:9.5px">${esc(r.trade.toUpperCase())}</span>` : ''}
        <div class="faint">${[r.city, r.state].filter(Boolean).map(esc).join(', ') || 'no location given'}
          ${r.contact ? ' · ' + esc(r.contact) : ''}${r.phone ? ' · ' + esc(r.phone) : ''}${r.email ? ' · ' + esc(r.email) : ''}
          · ${timeAgo(r.created_at)}</div>
        ${r.note ? `<div class="mini" style="margin-top:6px">${esc(r.note)}</div>` : ''}
      </div>
      <button class="btn ghost" style="width:auto; padding:9px 14px; font-size:12px" onclick="toggleWaitlist(${r.id})">
        ${r.contacted ? 'Mark not contacted' : 'Mark contacted'}</button></div>
    </div>`).join('') : '<div class="card"><span class="muted">Nobody on the waitlist yet</span></div>'}`;
}
async function toggleWaitlist(id){
  await api('POST', `/admin/waitlist/${id}/contacted`);
  render();
}
async function vAProvider(){
  const p = await api('GET', '/admin/providers/' + S.adminProviderId);
  const v = p.verification || {};
  const svcCount = Object.values(p.services || {}).reduce((a,b)=>a+(b?.length||0),0);
  const missing = [];
  if (!p.name) missing.push('business name');
  if (!p.dispatch_phone) missing.push('dispatch phone');
  if (!p.email) missing.push('dispatch email');
  if (!p.locations.length) missing.push('service location');
  if (!svcCount) missing.push('services offered');
  if (!v.license) missing.push('license number');
  if (!v.coi_file) missing.push('certificate of insurance');
  if (!v.w9_file) missing.push('W-9');
  return `
  <button class="back" onclick="nav('a-providers')">${ic('chevL',15)} All providers</button>
  <div class="row" style="margin-top:8px; flex-wrap:wrap; gap:8px">
    <h2 class="scr" style="margin:0">${esc(p.name || '(no name yet)')}</h2>
    <span style="display:inline-flex; gap:6px">
      ${p.license_verified ? '<span class="pill dark">LICENSE VERIFIED</span>' : '<span class="pill gray">LICENSE NOT VERIFIED</span>'}
      ${p.approved ? '<span class="pill solid">APPROVED</span>' : '<span class="pill red">NEEDS REVIEW</span>'}
    </span>
  </div>
  <p class="scrsub" style="margin-top:4px">Signed up ${timeAgo(p.signed_up)} · ${p.stats.leads_bought} leads bought · ${fmt$(p.stats.spend)} spent</p>

  ${missing.length ? `<div class="card alert"><div class="mini">${ic('warn',14)} <b class="k">Profile incomplete —</b> missing: ${missing.join(', ')}. You can still approve them; drivers just see less.</div></div>`
    : `<div class="card"><div class="mini">${ic('check',14)} <b class="k">Profile complete</b> — every onboarding field is filled in.</div></div>`}

  <div class="cols2"><div>
  <div class="card">
    <span class="sec">Contact</span>
    <div class="mini listline" style="margin-top:6px">
      <span class="muted">Account phone</span> &nbsp;${esc(p.phone)}<br>
      <span class="muted">Dispatch</span> &nbsp;${esc(p.dispatch_phone || '—')}<br>
      <span class="muted">After hours</span> &nbsp;${esc(p.after_phone || '—')}<br>
      <span class="muted">Email</span> &nbsp;${esc(p.email || '—')}<br>
      <span class="muted">Hours</span> &nbsp;${esc(p.hours || '—')}
    </div>
  </div>
  <div class="card">
    <span class="sec">Coverage (${p.locations.length})</span>
    ${p.locations.map(l=>`<div class="checkrow"><span class="cico on">${ic('pin',15)}</span><div class="mini"><b class="k">${esc(l.label)}</b><div class="faint">${l.radius_mi} mi radius · ${l.lat.toFixed(3)}, ${l.lng.toFixed(3)}${l.phone ? ' · '+esc(l.phone) : ''}</div></div></div>`).join('') || '<div class="faint" style="margin-top:8px">No locations — they will never match a lead</div>'}
  </div>
  <div class="card">
    <span class="sec">Services offered (${svcCount})</span>
    ${Object.entries(p.services||{}).filter(([,x])=>x?.length).map(([cat,items])=>`
      <div class="checkrow"><span class="cico on">${ic('check',15)}</span><div class="mini"><b class="k">${esc(cat)}</b><div class="faint">${items.map(esc).join(' · ')}</div></div></div>`).join('') || '<div class="faint" style="margin-top:8px">None selected</div>'}
    ${p.custom.length ? `<div class="checkrow"><span class="cico">${ic('plus',15)}</span><div class="mini"><b class="k">Custom requests</b><div class="faint">${p.custom.map(c=>esc(c.name)+' ('+c.status+')').join(' · ')}</div></div></div>` : ''}
  </div>
  <div class="card">
    <span class="sec">Equipment</span>
    <div class="mini" style="margin-top:6px; line-height:1.8">${Object.entries(p.equipment||{}).filter(([,x])=>x).map(([k,x])=>`${esc(k)}: <b class="k">${esc(x)}</b>`).join(' · ') || '—'}</div>
  </div>
  <div class="card">
    <span class="sec">Capabilities claimed</span>
    <div class="chips" style="margin-top:8px">
      ${CAPS.filter(([k])=>p.capabilities?.[k]).map(([,label])=>`<span class="pill dark">${esc(label)}</span>`).join('') || '<span class="faint">None set</span>'}
    </div>
  </div>
  </div><div>

  <div class="card" style="border-color:var(--red)">
    <span class="sec">License & documents</span>
    <div class="mini listline" style="margin-top:6px">
      <span class="muted">License #</span> &nbsp;${v.license ? '<b class="k">'+esc(v.license)+'</b>' : '<span style="color:var(--muted)">not provided</span>'}<br>
      <span class="muted">Insurance (COI)</span> &nbsp;${v.coi_file ? `<a href="${esc(v.coi_file)}" target="_blank">open document ›</a>` : '<span style="color:var(--muted)">not uploaded</span>'}<br>
      <span class="muted">W-9</span> &nbsp;${v.w9_file ? `<a href="${esc(v.w9_file)}" target="_blank">open document ›</a>` : '<span style="color:var(--muted)">not uploaded</span>'}<br>
      <span class="muted">Verified on</span> &nbsp;${p.license_verified_at ? new Date(p.license_verified_at).toLocaleDateString() : '—'}
    </div>
    <div style="height:12px"></div>
    ${p.license_verified
      ? `<button class="btn ghost" onclick="adminLicense(${p.user_id}, false)">Remove license verification</button>`
      : `<button class="btn dark" onclick="adminLicense(${p.user_id}, true)">${ic('check',15)} Mark license as verified</button>`}
    <div class="faint" style="margin-top:8px; line-height:1.5">Verified companies also receive requests from drivers who chose "licensed companies only." Approval and license verification are separate — an unlicensed company can still work on RIGRX.</div>
  </div>

  <div class="card">
    <span class="sec">Platform access</span>
    <div class="faint" style="margin:6px 0 10px; line-height:1.5">Approved companies see leads and can buy them. Suspending stops both immediately.</div>
    ${p.approved
      ? `<button class="btn ghost" onclick="adminProv(${p.user_id},'reject')">Suspend this company</button>`
      : `<button class="btn" onclick="adminProv(${p.user_id},'approve')">${ic('check',16)} Approve — allow them to buy leads</button>`}
  </div>

  ${archiveCard(p.user_id, 'company', p.archived_at, p.archive_reason)}

  <div class="card">
    <span class="sec">Private notes (only you see these)</span>
    <textarea rows="3" id="adm-notes" placeholder="e.g. spoke with the owner, insurance checks out">${esc(p.admin_notes)}</textarea>
    <div style="height:8px"></div>
    <button class="btn ghost" onclick="saveAdminNotes(${p.user_id})">Save notes</button>
  </div>

  ${p.reviews.length ? `<div class="card"><span class="sec">Recent driver reviews</span>
    ${p.reviews.map(r=>`<div class="checkrow"><div><div>${star5(r.stars)} <span class="faint">${timeAgo(r.created_at)}</span></div>${r.comment?`<div class="mini" style="margin-top:3px">"${esc(r.comment)}"</div>`:''}</div></div>`).join('')}</div>` : ''}
  </div></div>`;
}
async function adminProv(id, action){
  await api('POST', `/admin/providers/${id}/${action}`);
  toast(action==='approve' ? 'Provider approved & notified' : 'Provider suspended'); render();
}
async function adminLicense(id, verified){
  await api('POST', `/admin/providers/${id}/license`, { verified });
  toast(verified ? 'License verified — they now get licensed-only leads' : 'License verification removed'); render();
}
async function saveAdminNotes(id){
  await api('POST', `/admin/providers/${id}/notes`, { notes: qv('adm-notes') });
  toast('Notes saved');
}
async function vAPricing(){
  const rows = await api('GET', '/admin/pricing');
  return `
  <h2 class="scr">Lead Pricing</h2>
  <p class="scrsub">Per service type — standard slots (×3) and the premium 4th slot</p>
  ${rows.map(p=>`<div class="card">
    <div class="row" style="flex-wrap:wrap; gap:10px"><b class="mini k" style="min-width:180px">${esc(p.label)}</b>
      <span style="display:inline-flex; gap:8px; align-items:center">
        <span class="faint">Standard $</span><input type="text" id="std-${p.service_key}" value="${p.standard_cents/100}" style="width:70px; padding:8px">
        <span class="faint">Premium $</span><input type="text" id="prm-${p.service_key}" value="${p.premium_cents/100}" style="width:70px; padding:8px">
        <button class="btn dark" style="width:auto; padding:9px 14px; font-size:12px" onclick="savePrice('${p.service_key}')">Save</button>
      </span></div></div>`).join('')}`;
}
async function savePrice(key){
  await api('PUT', '/admin/pricing/' + key, {
    standard_cents: Math.round(parseFloat(qv('std-'+key)) * 100),
    premium_cents: Math.round(parseFloat(qv('prm-'+key)) * 100) });
  toast('Price updated');
}
async function vAPurchases(){
  const w = S.adminSalesWindow || '';
  const rows = await api('GET', '/admin/purchases' + (w === '24h' ? '?window=24h' : ''));
  const total = rows.filter(x=>!x.refunded).reduce((a,x)=>a+x.amount_cents,0);
  return `
  <h2 class="scr">Lead Sales${w === '24h' ? ' — last 24 hours' : ''}</h2>
  <p class="scrsub">${fmt$(total)} from ${rows.length} sale${rows.length===1?'':'s'} · click a sale to open the request behind it</p>
  <div class="chips" style="margin-bottom:14px">
    ${[['','All time'],['24h','Last 24h']].map(([v,l])=>
      `<span class="chip ${w===v?'sel':''}" onclick="nav('a-purchases',{adminSalesWindow:'${v}'})">${l}</span>`).join('')}
  </div>
  ${rows.map(x=>`<div class="card click" onclick="nav('a-request',{adminRequestId:${x.request_id}})">
    <div class="row">
      <div>
        <b class="mini k">${fmt$(x.amount_cents)} — ${esc(x.provider_name)}${x.won?' <span class="pill solid" style="font-size:9px">WON THE JOB</span>':''}</b>
        <div class="faint">Request #${x.request_id} · ${esc(x.service_label)} · ${esc(x.area_label)} · from ${esc(x.driver_name || 'driver')} · slot ${x.slot}${x.premium?' (premium)':''} · ${timeAgo(x.created_at)}</div>
      </div>
      ${x.refunded ? '<span class="pill gray">REFUNDED</span>' : `<button class="btn ghost" style="width:auto;padding:8px 12px;font-size:12px" onclick="event.stopPropagation();adminRefund(${x.id})">Refund</button>`}
    </div></div>`).join('') || '<div class="card" style="text-align:center"><span class="muted">No sales yet</span></div>'}`;
}
async function adminRefund(id){
  await api('POST', `/admin/purchases/${id}/refund`);
  toast('Refunded'); render();
}
async function vACustom(){
  const rows = await api('GET', '/admin/custom-services');
  return `
  <h2 class="scr">Requested Services</h2>
  <p class="scrsub">Services companies asked for that you don't offer yet. Approving adds it to the category you pick, so every company can then select it.</p>
  ${rows.map(c=>`<div class="card"><div class="row">
    <div><b class="mini k">"${esc(c.name)}"</b><div class="faint">by ${esc(c.provider_name)} · ${esc(c.status)}</div></div>
    ${c.status==='pending' ? `<span style="display:inline-flex;gap:6px; align-items:center; flex-wrap:wrap">
      <select id="cs-cat-${c.id}" style="width:auto; padding:8px">
        ${(S.catalog||[]).map(cat=>`<option value="${cat.id}">Add under ${esc(cat.label)}</option>`).join('')}
      </select>
      <button class="btn" style="width:auto;padding:8px 12px;font-size:12px" onclick="adminCustom(${c.id},'approve')">Approve</button>
      <button class="btn ghost" style="width:auto;padding:8px 12px;font-size:12px" onclick="adminCustom(${c.id},'reject')">Reject</button></span>`
    : `<span class="pill ${c.status==='approved'?'solid':'gray'}">${esc(c.status.toUpperCase())}</span>`}
  </div></div>`).join('') || '<div class="card"><span class="muted">Nothing pending</span></div>'}`;
}
async function adminCustom(id, action){
  const catId = action === 'approve' ? Number(qv('cs-cat-' + id)) : null;
  await api('POST', `/admin/custom-services/${id}/${action}`, catId ? { category_id: catId } : {});
  if (action === 'approve') { await loadCatalog(); toast('Approved and added to the catalog for everyone'); }
  render();
}
async function vARequests(){
  const w = S.adminReqWindow || '';
  const qs = w === '24h' ? '?window=24h' : w === 'unfilled' ? '?unfilled=1' : w === 'filled' ? '?filled=1' : '';
  const rows = await api('GET', '/admin/requests' + qs);
  const titles = { '24h': 'Requests — last 24 hours', 'unfilled': 'Requests nobody bought', 'filled': 'Requests that sold', '': 'Requests' };
  return `
  <h2 class="scr">${titles[w]}</h2>
  <p class="scrsub">Click any request to see everything in it, including all messages</p>
  <div class="chips" style="margin-bottom:14px">
    ${[['','All'],['24h','Last 24h'],['filled','Sold'],['unfilled','Unsold']].map(([v,l])=>
      `<span class="chip ${w===v?'sel':''}" onclick="nav('a-requests',{adminReqWindow:'${v}'})">${l}</span>`).join('')}
  </div>
  ${rows.map(r=>`<div class="card click" onclick="nav('a-request',{adminRequestId:${r.id}})"><div class="row">
    <div><b class="mini k">#${r.id} — ${esc(r.service_label)}${r.licensed_only ? ' <span class="pill dark" style="font-size:9px">LICENSED ONLY</span>' : ''}</b>
    <div class="faint">${esc(r.driver_name || 'driver')} · ${esc(r.area_label)} · ${r.notified_count} notified · ${r.buyers} bought · ${timeAgo(r.created_at)}</div></div>
    <span style="display:inline-flex; gap:8px; align-items:center">
      <span class="pill ${r.revenue_cents?'solid':'gray'}">${fmt$(r.revenue_cents)}</span>
      <span class="pill ${r.status==='open'?'red':'gray'}">${esc(r.status.toUpperCase())}</span>
      <span style="color:var(--red)">${ic('arrowR',16)}</span></span>
  </div></div>`).join('') || '<div class="card" style="text-align:center"><span class="muted">Nothing here</span></div>'}`;
}
async function vARequest(){
  const d = await api('GET', '/admin/requests/' + S.adminRequestId);
  const r = d.request, dr = d.driver;
  const t = r.truck || {}, tr = r.trailer || {};
  const thread = list => list.length
    ? `<div class="chatbox" style="margin-top:10px">${list.map(m=>`
        <div class="msg ${m.quote ? 'quotecard ' : ''}${m.from_driver ? 'them' : 'me'}" style="max-width:88%">
          <b class="k" style="font-size:10.5px; opacity:.75">${m.from_driver ? esc(dr.name || 'Driver') : esc(m.sender_name)}</b><br>
          ${m.quote ? `${ic('tag',13)} QUOTE ${fmt$(m.quote.amount_cents)}${m.quote.eta ? ' · ETA '+esc(fmtEta(m.quote.eta)) : ''}` : esc(m.body)}
          <span class="t">${new Date(m.created_at).toLocaleString()}</span></div>`).join('')}</div>`
    : '<div class="faint" style="margin-top:8px">No messages in this thread</div>';
  return `
  <button class="back" onclick="nav('a-requests')">${ic('chevL',15)} All requests</button>
  <div class="row" style="margin-top:8px; flex-wrap:wrap; gap:8px">
    <h2 class="scr" style="margin:0; display:flex; align-items:center; gap:8px">${ic(svcIcon(r.service_key),21)} Request #${r.id}</h2>
    <span style="display:inline-flex; gap:6px">
      ${r.licensed_only ? '<span class="pill dark">LICENSED ONLY</span>' : ''}
      <span class="pill ${r.status==='open'?'red':'solid'}">${esc(r.status.toUpperCase())}</span>
    </span>
  </div>
  <p class="scrsub" style="margin-top:4px">${esc(r.service_label)} · ${timeAgo(r.created_at)} · ${r.notified_count} compan${r.notified_count===1?'y':'ies'} alerted · ${d.buyers.length} bought · <b style="color:var(--red)">${fmt$(d.revenue_cents)} revenue</b></p>

  <div class="cols2"><div>
  <div class="card">
    <span class="sec">Who sent it</span>
    <div class="mini listline" style="margin-top:6px">
      <span class="muted">Driver</span> &nbsp;<a onclick="nav('a-driver',{adminDriverId:${r.driver_id}})">${esc(dr.name || 'unnamed')} ›</a><br>
      <span class="muted">Phone</span> &nbsp;${esc(dr.phone)}<br>
      <span class="muted">Company</span> &nbsp;${esc(dr.company || '—')}<br>
      <span class="muted">Type</span> &nbsp;${esc(dr.type || '—')}${dr.rating ? ` · rated ${dr.rating} by providers` : ''}
    </div>
  </div>
  <div class="card">
    <span class="sec">What was in the request</span>
    <div class="mini listline" style="margin-top:6px">
      <span class="muted">Problem</span> &nbsp;${r.description ? '"'+esc(r.description)+'"' : '<span style="color:var(--muted)">no description given</span>'}<br>
      <span class="muted">Mobility</span> &nbsp;${r.can_move==='no' ? "Can't move" : r.can_move==='short' ? 'Can limp a short distance' : 'Can move'}<br>
      <span class="muted">Situation</span> &nbsp;${(r.situation||[]).map(esc).join(' · ') || '—'}<br>
      <span class="muted">Area shown</span> &nbsp;${esc(r.area_label)}<br>
      <span class="muted">Exact spot</span> &nbsp;${esc(r.landmark || '—')}<br>
      <span class="muted">GPS</span> &nbsp;<a href="https://maps.google.com/?q=${r.lat},${r.lng}" target="_blank">${r.lat.toFixed(4)}, ${r.lng.toFixed(4)} ›</a><br>
      <span class="muted">Photos</span> &nbsp;${(r.photos||[]).map(p=>`<a href="${esc(p)}" target="_blank">view</a>`).join(' · ') || 'none'}
    </div>
  </div>
  <div class="card">
    <span class="sec">Equipment on the request</span>
    <div class="mini listline" style="margin-top:6px">
      <span class="muted">Truck</span> &nbsp;${esc([t.year,t.make,t.model,t.engine,t.color].filter(Boolean).join(' · ') || '—')}<br>
      <span class="muted">Tires</span> &nbsp;${esc([t.steer,t.drive].filter(Boolean).join(' / ') || '—')}<br>
      <span class="muted">Trailer</span> &nbsp;${esc([tr.type,tr.len,tr.axles].filter(Boolean).join(' · ') || '—')}<br>
      <span class="muted">Hazmat</span> &nbsp;${tr.hazmat ? `<span style="color:var(--red);font-weight:700">Class ${esc(tr.hzClass)} · UN ${esc(tr.un)}</span>` : 'No'}
    </div>
  </div>
  ${d.reviews.length ? `<div class="card"><span class="sec">Reviews from this job</span>
    ${d.reviews.map(rv=>`<div class="checkrow"><div><div>${star5(rv.stars)} <span class="faint">by ${esc(rv.reviewer_name)} · ${timeAgo(rv.created_at)}</span></div>${rv.comment?`<div class="mini" style="margin-top:3px">"${esc(rv.comment)}"</div>`:''}</div></div>`).join('')}</div>` : ''}
  </div><div>

  <div class="card">
    <span class="sec">Who bought this lead (${d.buyers.length} of 4)</span>
    ${d.buyers.map(b=>`
      <div style="border-top:1px solid var(--border); margin-top:10px; padding-top:10px">
        <div class="row">
          <div><b class="mini k"><a onclick="nav('a-provider',{adminProviderId:${b.provider_id}})">${esc(b.provider_name)} ›</a></b>
            <div class="faint">Slot ${b.slot}${b.premium?' (premium)':''} · ${esc(b.provider_phone)} · bought ${timeAgo(b.created_at)}${b.license_verified?' · licensed':''}</div></div>
          <span style="display:inline-flex; gap:6px">
            ${r.selected_provider===b.provider_id ? '<span class="pill solid">WON</span>' : ''}
            <span class="pill ${b.refunded?'gray':'dark'}">${b.refunded ? 'REFUNDED' : fmt$(b.amount_cents)}</span>
          </span>
        </div>
        ${thread(b.thread)}
      </div>`).join('') || '<div class="faint" style="margin-top:8px">Nobody bought this lead — it was alerted to ' + r.notified_count + ' companies</div>'}
  </div>
  ${d.orphan_threads.length ? `<div class="card"><span class="sec">Other message threads</span>
    ${d.orphan_threads.map(o=>thread(o.thread)).join('')}</div>` : ''}
  </div></div>`;
}


/* ---------------- admin: service catalog ---------------- */
const ICON_CHOICES = ['truck','tire','zap','wrench','trailer','fuel','key','box','chart','tag','pin','check','warn','camera','card','clock','bell','mobile','user','folder'];

async function vACatalog(){
  const cats = await api('GET', '/catalog?all=1');
  S.catalogAdmin = cats;
  return `
  <h2 class="scr">Services</h2>
  <p class="scrsub">Everything here drives the app: what drivers can request, what companies can offer, and how the two get matched.</p>

  <div class="card" style="border-style:dashed">
    <span class="sec">Add a category</span>
    <div class="grid2" style="margin-top:10px">
      <div><label class="f" style="margin-top:0">Name</label><input type="text" id="nc-label" placeholder="Auto Glass Repair"></div>
      <div><label class="f" style="margin-top:0">One-line description</label><input type="text" id="nc-blurb" placeholder="Windshields, chips, mirrors"></div>
    </div>
    <div class="grid2">
      <div><label class="f">Lead price $</label><input type="text" id="nc-std" value="25"></div>
      <div><label class="f">Premium 4th slot $</label><input type="text" id="nc-prem" value="50"></div>
    </div>
    <label class="f">Icon</label>
    <div class="chips" id="nc-icon">
      ${ICON_CHOICES.map((n,i)=>`<span class="chip ${i===7?'sel':''}" data-icon="${n}" onclick="togOne(this)">${ic(n,16)}</span>`).join('')}
    </div>
    <label class="f">Show on the driver's request screen?</label>
    <div class="chips" id="nc-visible">
      <span class="chip sel" onclick="togOne(this)">Yes</span><span class="chip" onclick="togOne(this)">Providers only</span>
    </div>
    <div style="height:12px"></div>
    <button class="btn" onclick="addCategory()">${ic('plus',16)} Add category</button>
  </div>

  ${cats.map(c=>`
  <div class="card ${c.active?'':'.'}" style="${c.active?'':'opacity:.6'}">
    <div class="row" style="flex-wrap:wrap; gap:8px">
      <b class="mini k" style="display:inline-flex; align-items:center; gap:8px; font-size:14px">${ic(c.icon,17)} ${esc(c.label)}</b>
      <span style="display:inline-flex; gap:6px; align-items:center">
        ${c.driver_visible ? '<span class="pill red">DRIVERS SEE IT</span>' : '<span class="pill gray">PROVIDERS ONLY</span>'}
        <span class="pill dark">${c.standard_cents!=null ? fmt$(c.standard_cents) : 'no price'}${c.premium_cents!=null ? ' / '+fmt$(c.premium_cents) : ''}</span>
        ${c.active ? '' : '<span class="pill gray">OFF</span>'}
      </span>
    </div>
    <div class="faint" style="margin-top:4px">${esc(c.blurb || 'no description')} · key <code style="font-size:11px">${esc(c.key)}</code></div>

    <div class="chips" style="margin-top:10px">
      ${c.items.map(i=>`<span class="chip sel">${esc(i.label)} <span style="cursor:pointer; opacity:.6" onclick="removeItem(${i.id})">✕</span></span>`).join('')
        || '<span class="faint">No services under this category yet — add one below</span>'}
    </div>
    <div class="row" style="gap:8px; margin-top:10px">
      <input type="text" id="ni-${c.id}" placeholder="Add a service, e.g. Windshield replacement" style="flex:1">
      <button class="btn dark" style="width:auto; padding:11px 15px; font-size:12.5px" onclick="addItem(${c.id})">Add</button>
    </div>

    <div class="divider"></div>
    <div class="row" style="flex-wrap:wrap; gap:8px">
      <span style="display:inline-flex; gap:8px; align-items:center; flex-wrap:wrap">
        <span class="faint">Name</span><input type="text" id="ec-label-${c.id}" value="${esc(c.label)}" style="width:150px; padding:8px">
        <span class="faint">$</span><input type="text" id="ec-std-${c.id}" value="${c.standard_cents!=null?c.standard_cents/100:25}" style="width:56px; padding:8px">
        <span class="faint">prem $</span><input type="text" id="ec-prem-${c.id}" value="${c.premium_cents!=null?c.premium_cents/100:50}" style="width:56px; padding:8px">
        <button class="btn dark" style="width:auto; padding:9px 13px; font-size:12px" onclick="saveCategory(${c.id})">Save</button>
      </span>
      <span style="display:inline-flex; gap:6px">
        <button class="btn ghost" style="width:auto; padding:9px 13px; font-size:12px" onclick="toggleCat(${c.id},'driver_visible',${!c.driver_visible})">${c.driver_visible?'Hide from drivers':'Show to drivers'}</button>
        <button class="btn ghost" style="width:auto; padding:9px 13px; font-size:12px" onclick="toggleCat(${c.id},'active',${!c.active})">${c.active?'Turn off':'Turn on'}</button>
      </span>
    </div>
  </div>`).join('')}
  <div class="card" style="background:var(--soft)">
    <div class="mini" style="line-height:1.55">${ic('warn',14)} Categories get turned off rather than deleted, so past requests keep their labels and your revenue reports stay intact. A new category reaches nobody until service companies check something under it — so add them as demand shows up.</div>
  </div>
  ${await otherEntriesCard()}`;
}
// What people typed when the dropdown didn't have their answer — the shopping list
// for what to add to the built-in lists.
async function otherEntriesCard(){
  let rows = [];
  try { rows = await api('GET', '/admin/other-entries'); } catch(e){ return ''; }
  const label = f => ({
    truck_make:'Truck make', truck_model:'Truck model', truck_year:'Truck year',
    truck_engine:'Engine', truck_trans:'Transmission', truck_axles:'Axle config',
    steer_tire:'Steer tire size', drive_tire:'Drive tire size', wheels:'Wheels',
    truck_color:'Color', trailer_type:'Trailer type', trailer_length:'Trailer length',
    trailer_axles:'Trailer axles', trailer_susp:'Suspension', trailer_tire:'Trailer tire',
    reefer_make:'Reefer unit', trailer_doors:'Doors', liftgate:'Liftgate', hazmat_class:'Hazmat class'
  })[f] || f;
  return `
  <div class="card">
    <span class="sec">"Other" answers — what the dropdowns are missing</span>
    <div class="faint" style="margin:6px 0 12px">Every time someone picks "Other…" and types their own answer, it lands here. Anything showing up repeatedly belongs in the built-in list.</div>
    ${rows.length ? `<table class="tbl"><tr><th>Field</th><th>What they typed</th><th>Class</th><th>Times</th><th>Last seen</th></tr>
      ${rows.map(r=>`<tr><td>${esc(label(r.field))}</td><td><b class="k">${esc(r.value)}</b></td><td>${esc(r.duty_class||'—')}</td><td>${r.times > 1 ? `<span class="pill red">${r.times}</span>` : r.times}</td><td class="faint">${timeAgo(r.last_seen)}</td></tr>`).join('')}
    </table>` : '<div class="faint">Nothing yet — the lists are covering everyone so far.</div>'}
  </div>`;
}
async function addCategory(){
  const label = qv('nc-label').trim();
  if (!label) return toast('Give the category a name');
  await api('POST', '/admin/catalog', {
    label, blurb: qv('nc-blurb'),
    standard: qv('nc-std'), premium: qv('nc-prem'),
    icon: $('nc-icon').querySelector('.chip.sel')?.dataset.icon || 'box',
    driver_visible: $('nc-visible').querySelector('.chip.sel')?.textContent.trim() === 'Yes'
  });
  await loadCatalog();
  toast('"' + label + '" added — now add the services under it');
  render();
}
async function saveCategory(id){
  await api('PUT', '/admin/catalog/' + id, {
    label: qv('ec-label-'+id), standard: qv('ec-std-'+id), premium: qv('ec-prem-'+id) });
  await loadCatalog(); toast('Saved'); render();
}
async function toggleCat(id, field, value){
  await api('PUT', '/admin/catalog/' + id, { [field]: value });
  await loadCatalog(); render();
}
async function addItem(catId){
  const label = qv('ni-'+catId).trim();
  if (!label) return;
  await api('POST', `/admin/catalog/${catId}/items`, { label });
  await loadCatalog(); toast('Added'); render();
}
async function removeItem(itemId){
  await api('DELETE', '/admin/catalog/items/' + itemId);
  await loadCatalog(); render();
}

/* ---------------- shell & render ---------------- */
const VIEWS = {
  signin: vSignin, code: vCode,
  'd-setup1': vDSetup1, 'd-setup2': vDSetup2, 'd-setup3': vDSetup3,
  'd-home': vDHome, 'd-request': vDRequest, 'd-details': vDDetails, 'd-location': vDLocation,
  'd-review': vDReview, 'd-active': vDActive, 'd-chat': ()=>chatView('d-threads'), 'd-threads': vThreads,
  'd-pubprofile': vDPubProfile, 'd-rate': vDRate, 'd-garage': vDGarage,
  'p-setup1': vPSetup1, 'p-setup2': vPSetup2, 'p-setup3': vPSetup3, 'p-setup4': vPSetup4, 'p-setup5': vPSetup5,
  'p-feed': vPFeed, 'p-lead': vPLead, 'p-myleads': vPMyLeads, 'p-chat': ()=>chatView('p-threads'), 'p-threads': vThreads,
  'p-stats': vPStats, 'p-reviews': vPReviews, 'p-people': vPPeople, 'p-jobs': vPJobs, 't-jobs': vTechJobs, 'p-settings': vPSettings,
  'a-home': vAHome, 'a-providers': vAProviders, 'a-provider': vAProvider, 'a-pricing': vAPricing,
  'a-purchases': vAPurchases, 'a-custom': vACustom, 'a-catalog': vACatalog, 'a-requests': vARequests, 'a-request': vARequest,
  'a-drivers': vADrivers, 'a-driver': vADriver
};
const AUTH_LAYOUT = new Set(['signin','code','d-setup1','d-setup2','d-setup3','p-setup1','p-setup2','p-setup3','p-setup4','p-setup5','loading']);
const NAVS = {
  driver: [
    {ico:'home', label:'Home', v:'d-home', also:['d-request','d-details','d-location','d-review','d-active','d-pubprofile','d-rate']},
    {ico:'chat', label:'Messages', v:'d-threads', also:['d-chat']},
    {ico:'truck', label:'Garage', v:'d-garage'}],
  provider: [
    {ico:'zap', label:'Live Leads', v:'p-feed', also:['p-lead']},
    {ico:'wrench', label:'Jobs', v:'p-jobs'},
    {ico:'folder', label:'My Leads', v:'p-myleads'},
    {ico:'chat', label:'Messages', v:'p-threads', also:['p-chat']},
    {ico:'chart', label:'Stats', v:'p-stats', also:['p-reviews']},
    {ico:'user', label:'Your team', v:'p-people'},
    {ico:'sliders', label:'Settings', v:'p-settings'}],
  // A tech gets one screen and nothing else — no feed, no prices, no other jobs.
  tech: [
    {ico:'wrench', label:'My jobs', v:'t-jobs'}],
  admin: [
    {ico:'home', label:'Overview', v:'a-home'},
    {ico:'check', label:'Providers', v:'a-providers', also:['a-provider']},
    {ico:'user', label:'Drivers', v:'a-drivers', also:['a-driver']},
    {ico:'wrench', label:'Services', v:'a-catalog'},
    {ico:'tag', label:'Pricing', v:'a-pricing'},
    {ico:'card', label:'Sales', v:'a-purchases'},
    {ico:'plus', label:'Requested', v:'a-custom'},
    {ico:'zap', label:'Requests', v:'a-requests', also:['a-request']}]
};
let renderSeq = 0;
async function render(){
  const seq = ++renderSeq;
  const root = $('root');
  const fn = VIEWS[S.view];
  if (!fn){ root.innerHTML = authShell('<div class="card">Page not found. <a onclick="nav(homeFor())">Go home</a></div>'); return; }
  let html;
  try { html = await fn(); }
  catch(e){ console.error(e); html = `<div class="card alert" style="margin-top:20px"><div class="mini">Couldn't load this page — check your connection and try again.</div></div>`; }
  if (seq !== renderSeq) return; // a newer navigation happened while loading
  if (AUTH_LAYOUT.has(S.view) || !S.me){ root.innerHTML = AUTH_LAYOUT.has(S.view) ? html : authShell(html); return; }
  const navKey = S.me.role === 'provider' && (S.me.member_role === 'tech') ? 'tech' : S.me.role;
  const items = (NAVS[navKey] || NAVS.driver)
    .filter(t => !(t.v === 'p-settings' && S.me.member_role === 'dispatcher'))
    .map(t => ({ ...t, act: t.v === S.view || (t.also || []).includes(S.view) }));
  const who = S.me.role === 'provider'
    ? `${esc(S.provider?.name || S.me.name || 'My company')}<br><span class="faint">${
        S.me.member_role === 'tech' ? esc(S.me.name || 'Technician') + ' · technician'
        : S.me.member_role === 'dispatcher' ? esc(S.me.name || '') + ' · dispatcher'
        : (S.provider?.approved ? 'Verified provider' : 'Pending approval')}</span>`
    : `${esc(S.me.name || S.me.phone)}<br><span class="faint">${S.me.role === 'admin' ? 'RIGRX admin' : 'Driver · ' + esc(S.me.phone)}</span>`;
  root.innerHTML = `
  <div class="shell">
    <div class="sidebar">
      <div class="slogo click" onclick="nav(homeFor())" title="Back to home">RIG<span>RX</span></div>
      ${items.map(t=>`<button class="${t.act?'active':''}" onclick="nav('${t.v}')">${ic(t.ico,19)} ${t.label}</button>`).join('')}
      <div class="spacer"></div>
      <button onclick="signOut()">${ic('out',18)} Sign out</button>
      <div class="whoami">${who}</div>
    </div>
    <div class="main">
      <div class="topbar">
        <div class="logo click" onclick="nav(homeFor())" title="Back to home">RIG<span>RX</span></div>
        <div class="sub">${S.me.role==='provider' ? esc(S.provider?.name || '') : esc((S.me.name || '').split(' ')[0])} &nbsp;·&nbsp; <a onclick="signOut()">Sign out</a></div>
      </div>
      <div class="content${S.me.role==='driver' ? '' : ' wide'}">${html}</div>
    </div>
  </div>
  <div class="tabbar">
    ${items.map(t=>`<button class="${t.act?'active':''}" onclick="nav('${t.v}')">${ic(t.ico,21)}${t.label}</button>`).join('')}
  </div>`;
}

/* ---------------- boot ---------------- */
(async function boot(){
  await loadCatalog();
  try { await loadMe(); } catch(e){}
  if (S.me) connectWS();
  nav(homeFor());
})();
