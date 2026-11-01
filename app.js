'use strict';
const VERSION = 'rt-v8';
/* RDA Rack Track: whitetail movement favorability estimate. All tunables up here. */
const CFG = {
  BASE: 50,
  // Additive terms (points). Sizes reflect how well each effect is supported by research (see "How the score works").
  TEMP_ABS: [[-10,0],[25,5],[40,8],[50,4],[60,-4],[70,-12],[200,-20]], // [upper °F, pts] heat is the best-supported weather effect
  TEMP_DROP_PER_F: 0.6, TEMP_DROP_MAX: 8, TEMP_RISE_MAX: -6,              // vs same hour yesterday (weak evidence)
  WIND: [[1,-3],[5,1],[16,4],[27,3],[35,-4],[999,-10]],                  // PSU: bucks moved MORE with wind; others mixed
  GUST: [[35,0],[45,-4],[999,-8]],
  SKY: {clearCool:5, clearWarm:-6, partly:3, overcastCool:1, overcastWarm:-1, warmF:60, coolF:50}, // weakly supported
  PRESS_FALL_3H: -1.5, PRESS_FALL_PTS: 2, POST_FRONT_FALL_12H: -3, POST_FRONT_RISE_3H: 1, POST_FRONT_PTS: 3, PRESS_HIGH: 1022, PRESS_HIGH_PTS: 1, // not supported by GPS studies: kept small
  PRIME_DAMP: 0.75,   // Auburn: weather mattered least at dawn/dusk, so non-rain weather terms are damped in prime windows
  // Wet weather multiplies the dry score, then caps it (rut bonus can't lift it past the cap).
  // PSU collars: bucks travelled ~40% less on rainy October days (0.8 -> 0.5 mi); does unaffected.
  WET: { // [multiplier, cap, label]
    fog:[0.85,55,'Fog'], drizzle:[0.70,40,'Drizzle'], light:[0.65,35,'Light rain'], steady:[0.55,25,'Steady rain'], heavy:[0.45,15,'Heavy rain'],
    storm:[0.35,10,'Thunderstorm'], snowLight:[0.95,75,'Light snow'], snow:[0.80,50,'Snow'], snowHeavy:[0.55,25,'Heavy snow']},
  WINDY_RAIN_MPH: 16, WINDY_RAIN_RELIEF: [0.15, 10], // PSU: light rain + strong wind didn't cut buck movement
  NOW_CACHE_MIN: 5, OBS_MAX_AGE_MIN: 90,
  RUT: [ // northern MN/WI calendar approximation [startMonth, startDay, endMonth, endDay, name, bonus, blurb]
    [1,1,10,19,'Early season',0,'Bed-to-feed patterns rule. Hunt food sources at last light.'],
    [10,20,10,31,'Pre-rut / seeking',8,'Scrapes and rubs are opening up and bucks are cruising more in daylight.'],
    [11,1,11,10,'Seeking / chasing',10,'Bucks are on their feet checking does. All-day sits pay off.'],
    [11,11,11,24,'Peak breeding',7,'Bucks are locked down with does but still move a lot. Cover funnels and doe bedding.'],
    [11,25,11,30,'Post-rut',3,'Tired bucks go back to food. Late lockdown tail.'],
    [12,1,12,4,'Late season',0,'Food is king. Cold snaps push daylight feeding.'],
    [12,5,12,20,'Second rut',4,'Unbred does and fawns come into heat. A small secondary bump.'],
    [12,21,12,31,'Late season',0,'Food is king. Cold snaps push daylight feeding.']],
  PRIME_DAWN: [-60, 120], PRIME_DUSK: [-150, 30],                        // minutes around sunrise / sunset
  DAY_WEIGHTS: {prime: 0.75, midday: 0.25},
  RAIN_REPORT: {dry:[0,'Not raining'], light:[0.05,'Light'], steady:[0.15,'Steady'], heavy:[0.3,'Heavy']}, RAIN_REPORT_MIN: 120,
  // Display calibration (raw model points -> 0-100 shown). Monotonic piecewise-linear, so ordering never changes.
  // Anchored on harness scenarios: thunderstorm raw 10 -> ~6, ideal rut dawn raw ~80 -> ~92, neutral 50 -> 50.
  CAL: [[0,0],[10,6],[25,18],[35,30],[50,50],[65,72],[80,92],[95,99],[100,100]],
  BANDS: [[0,35,'Poor','#ff5d5d'],[35,50,'Fair','#f2b84b'],[50,65,'Good','#a6d94a'],[65,80,'Great','#3ecf8e'],[80,101,'Prime','#2ee6c8']],
  CACHE_MIN: 30, KEY_LOCS: 'rt_locs', KEY_CACHE: 'rt_wx2_'
};
const $ = s => document.querySelector(s), view = $('#view');
const clamp = (v,a,b) => Math.max(a, Math.min(b, v));
const band = (x, table) => { for (const [u,p] of table) if (x < u) return p; return table[table.length-1][1]; };
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'], CMP = ['N','NE','E','SE','S','SW','W','NW'];
const compass = d => CMP[Math.round(d/45)%8];
const C16 = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'], compass16 = d => d==null?'':C16[Math.round(((d%360)+360)%360/22.5)%16];
const prevail = a => { let x=0,y=0; for (const h of a){ const r=h.wd*Math.PI/180, k=h.w||1; x+=Math.sin(r)*k; y+=Math.cos(r)*k; } return compass16((Math.atan2(x,y)*180/Math.PI+360)%360); };
const bandOf = s => CFG.BANDS.find(b => s < b[1]) || CFG.BANDS[CFG.BANDS.length-1];
const color = s => bandOf(s)[3];
const label = s => bandOf(s)[2];
const cal = r => { const C = CFG.CAL; r = clamp(r,0,100); for (let i=1;i<C.length;i++) if (r <= C[i][0]) { const [a,A] = C[i-1], [b,B] = C[i]; return A + (r-a)/(b-a)*(B-A); } return 100; };
// local-time strings ("2026-10-31T14:00") -> minutes on a fake UTC clock; avoids timezone bugs
const tm = s => { const [d,t='00:00'] = s.split('T'), [y,m,dd] = d.split('-').map(Number), [h,mi] = t.split(':').map(Number); return Date.UTC(y,m-1,dd,h,mi)/6e4; };
const fmtClock = iso => new Date(iso).toLocaleTimeString([], {hour:'numeric', minute:'2-digit'});
const fmtT = m => { const d = new Date(m*6e4); let h = d.getUTCHours(), mi = d.getUTCMinutes(); const ap = h<12?'a':'p'; h = h%12||12; return h+(mi?':'+String(mi).padStart(2,'0'):'')+ap; };

function rutFor(dateStr){ const [,m,d] = String(dateStr).slice(0,10).split('-').map(Number), k = m*100+d;
  for (const r of CFG.RUT) if (k >= r[0]*100+r[1] && k <= r[2]*100+r[3]) return {name:r[4], bonus:r[5], blurb:r[6]};
  return {name:'Season', bonus:0, blurb:''}; }

/* ---------- storage ---------- */
const getLocs = () => { try { return JSON.parse(localStorage.getItem(CFG.KEY_LOCS)) || []; } catch { return []; } };
const setLocs = l => localStorage.setItem(CFG.KEY_LOCS, JSON.stringify(l));

const rainKey = l => 'rt_rain_' + l.lat.toFixed(3) + ',' + l.lon.toFixed(3);
function getRain(l){ try { const r = JSON.parse(localStorage.getItem(rainKey(l))); if (r && Date.now() < r.exp) return r; } catch {} localStorage.removeItem(rainKey(l)); return null; }
function setRain(l, lvl){ if (!lvl) return localStorage.removeItem(rainKey(l)); localStorage.setItem(rainKey(l), JSON.stringify({lvl, at:Date.now(), exp:Date.now()+CFG.RAIN_REPORT_MIN*6e4})); }
const miles = (a,b,c,d) => { const r=Math.PI/180, x=Math.sin((c-a)*r/2)**2+Math.cos(a*r)*Math.cos(c*r)*Math.sin((d-b)*r/2)**2; return 3958.8*2*Math.asin(Math.sqrt(x)); };
/* ---------- geocoding ---------- */
async function geocode(q){
  q = q.trim(); const isZip = /^\d{5}$/.test(q), isAddr = /\d/.test(q) && !isZip || q.includes(',');
  const om = async () => { const r = await (await fetch('https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&format=json&name='+encodeURIComponent(q)+(isZip?'&countryCode=US':''))).json();
    const g = r.results && r.results[0]; return g && {name:(isZip?q+' · ':'')+g.name+(g.admin1?', '+g.admin1:''), lat:g.latitude, lon:g.longitude, st:g.admin1||''}; };
  const nm = async () => { const r = await (await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&addressdetails=1&q='+encodeURIComponent(q))).json();
    const g = r[0]; if (!g) return null; const a = g.address||{};
    return {name:(isZip?q+' · ':'')+(a.city||a.town||a.village||a.hamlet||a.county||g.display_name.split(',')[0])+(a.state?', '+a.state:''), lat:+g.lat, lon:+g.lon, st:a.state||''}; };
  const order = isAddr ? [nm, om] : [om, nm];
  for (const f of order) { try { const g = await f(); if (g) return g; } catch (e) {} }
  return null;
}

/* ---------- weather ---------- */
const HV = 'weather_code,temperature_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m,cloud_cover,precipitation,precipitation_probability,pressure_msl';
const MV = 'weather_code,temperature_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m,precipitation';
async function weather(loc, force){
  const key = CFG.KEY_CACHE + loc.lat.toFixed(3) + ',' + loc.lon.toFixed(3);
  let c; try { c = JSON.parse(localStorage.getItem(key)); } catch {}
  if (c && !force && Date.now()-c.t < CFG.CACHE_MIN*6e4) return c;
  try {
    const u = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&hourly=${HV}&minutely_15=${MV}&daily=sunrise,sunset&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&timezone=auto&past_days=1&forecast_days=7`;
    const r = await fetch(u); if (!r.ok) throw new Error('HTTP '+r.status);
    c = {t:Date.now(), d:await r.json()}; localStorage.setItem(key, JSON.stringify(c)); return c;
  } catch (e) { if (c) { c.stale = true; return c; } throw e; }
}

// WMO weather_code -> implied in/hr (so "raining" never scores as dry when the amount rounds to 0)
const CODE_RATE = {51:.01,53:.02,55:.03,56:.02,57:.03,61:.04,63:.12,65:.3,66:.06,67:.15,71:.03,73:.08,75:.2,77:.02,80:.05,81:.15,82:.35,85:.08,86:.2,95:.3,96:.35,99:.4};
const CODE_TXT = c => c==null?'':c<=1?'Clear':c==2?'Partly cloudy':c==3?'Overcast':c<=48?'Fog':c<=57?'Drizzle':c<=67?'Rain':c<=77?'Snow':c<=82?'Rain showers':c<=86?'Snow showers':'Thunderstorm';
const effPr = (pr, code, pp) => Math.max(pr||0, CODE_RATE[code]||0, (pp||0) >= 70 ? 0.01 : 0);
const WX_RE = /rain|drizzle|shower|snow|sleet|thunder|precip|mist/i;
// NWS text -> implied in/hr
const txtRate = t => !t ? 0 : /thunder/i.test(t)?.3 : /heavy/i.test(t)?.3 : /snow|sleet/i.test(t)?.05 : /shower/i.test(t)?.05 : /light/i.test(t)&&/rain/i.test(t)?.02 : /rain/i.test(t)?.06 : /drizzle|mist/i.test(t)?.01 : 0;
async function getJ(u, nws){ const r = await fetch(u, nws?{headers:{Accept:'application/geo+json'}}:{}); if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); }
// Right-now data: Open-Meteo current + 15-min nowcast, NWS nearest-station observation + hourly forecast (US). Cached 5 min.
async function nowcast(loc, force){
  const key = 'rt_now_' + loc.lat.toFixed(3) + ',' + loc.lon.toFixed(3);
  let c; try { c = JSON.parse(localStorage.getItem(key)); } catch {}
  if (c && !force && Date.now()-c.t < CFG.NOW_CACHE_MIN*6e4) return c;
  const n = {t:Date.now()};
  const om = getJ(`https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&current=temperature_2m,precipitation,rain,showers,snowfall,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,wind_gusts_10m,pressure_msl&minutely_15=precipitation,weather_code&forecast_minutely_15=12&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&timezone=auto`)
    .then(j => { n.om = j.current; n.m15 = j.minutely_15; }).catch(()=>{});
  const nws = (async () => {
    const pk = 'rt_pt2_' + loc.lat.toFixed(3) + ',' + loc.lon.toFixed(3); let pt; try { pt = JSON.parse(localStorage.getItem(pk)); } catch {}
    if (!pt) { const p = (await getJ(`https://api.weather.gov/points/${loc.lat.toFixed(4)},${loc.lon.toFixed(4)}`,1)).properties;
      const st = (await getJ(p.observationStations,1)).features.slice(0,3).map(f=>({id:f.properties.stationIdentifier, nm:f.properties.name, lat:f.geometry.coordinates[1], lon:f.geometry.coordinates[0]}));
      pt = {st, fh:p.forecastHourly}; localStorage.setItem(pk, JSON.stringify(pt)); }
    await Promise.all([
      (async () => { for (const st of pt.st) { const id = st.id; try { const o = (await getJ(`https://api.weather.gov/stations/${id}/observations/latest`,1)).properties;
        const age = (Date.now()-Date.parse(o.timestamp))/6e4; if (age > CFG.OBS_MAX_AGE_MIN || o.temperature.value==null) continue;
        const pw = (o.presentWeather||[]).map(w=>w.rawString||w.weather||'').join(' ');
        n.obs = {id, nm:st.nm, mi:miles(loc.lat,loc.lon,st.lat,st.lon), ts:o.timestamp, age, txt:o.textDescription||'', pw, t:o.temperature.value*9/5+32,
          w:o.windSpeed.value==null?null:o.windSpeed.value/1.609, wd:o.windDirection.value,
          pr:o.precipitationLastHour&&o.precipitationLastHour.value!=null?o.precipitationLastHour.value/25.4:null}; return; } catch {} } })(),
      (async () => { try { const ps = (await getJ(pt.fh,1)).properties.periods.slice(0,3);
        n.nwsh = ps.map(p=>({start:p.startTime, pp:(p.probabilityOfPrecipitation||{}).value||0, txt:p.shortForecast, t:p.temperature, w:parseInt(p.windSpeed)||null})); } catch {} })()]);
  })().catch(()=>{});
  await Promise.all([om, nws]);
  if (!n.om && !n.obs) { if (c) { c.stale = true; return c; } throw new Error('no current data'); }
  localStorage.setItem(key, JSON.stringify(n)); return n;
}
// Merge sources into one "right now" reading (observed beats modeled)
function nowRead(n){
  const om = n.om||{}, ob = n.obs, h0 = (n.nwsh||[])[0];
  const m15 = n.m15 && n.m15.precipitation ? n.m15.precipitation.slice(0,8) : [];
  const m15c = n.m15 && n.m15.weather_code ? n.m15.weather_code.slice(0,8) : [];
  const omRate = Math.max((om.precipitation||0)*4, CODE_RATE[om.weather_code]||0);
  const obsTxt = ob ? (ob.pw+' '+ob.txt) : '';
  const obsRate = ob ? Math.max(ob.pr||0, WX_RE.test(obsTxt) ? Math.max(txtRate(obsTxt), .01) : 0) : 0;
  const next2 = Math.max(0, ...m15.map((v,i)=>Math.max((v||0)*4, CODE_RATE[m15c[i]]||0)));
  const pp2 = Math.max(0, ...(n.nwsh||[]).slice(0,2).map(p=>p.pp));
  const rate = Math.max(omRate, obsRate, h0 && WX_RE.test(h0.txt) && h0.pp>=50 ? txtRate(h0.txt)||.01 : 0);
  const t = ob && ob.t!=null ? ob.t : om.temperature_2m, w = ob && ob.w!=null ? ob.w : om.wind_speed_10m, wd = ob && ob.wd!=null ? ob.wd : om.wind_direction_10m;
  const sky = ob && ob.txt ? ob.txt : CODE_TXT(om.weather_code);
  // first wet 15-min step in the next hour (Open-Meteo 15-min nowcast; HRRR-based in the US)
  const m15t = n.m15 && n.m15.time ? n.m15.time.slice(0,8) : [], nowL = om.time ? tm(om.time) : null;
  let firstWet = null; for (let i=0;i<m15.length;i++){ const r = Math.max((m15[i]||0)*4, CODE_RATE[m15c[i]]||0); if (r>0.004 && nowL!=null && m15t[i]) { const dm = tm(m15t[i])-nowL; if (dm>=-14 && dm<=60) { firstWet = {in:Math.max(0,dm), rate:r}; break; } } }
  const ob1 = ob && WX_RE.test(obsTxt);
  return {t, w, wd, rate, wet: rate>0.004, code: ob1 && !(om.weather_code>=51) ? (/thunder/i.test(obsTxt)?95:/snow/i.test(obsTxt)?71:/drizzle/i.test(obsTxt)?53:61) : om.weather_code, firstWet, sky, cc:om.cloud_cover, next2, pp2, omTime:om.time, ob, h0,
    src: (ob?`NWS ${ob.id} obs `:'')+(om.time?'Open-Meteo now':'')};
}

/* ---------- model ---------- */
// Classify precipitation from WMO code and/or rate (in/hr)
function wetClass(code, pr){
  if (code>=95) return 'storm';
  if (code==45||code==48) return 'fog';
  if (code>=71&&code<=77 || code==85||code==86) return code==75||code==86||pr>=0.2?'snowHeavy':code==73||pr>=0.06?'snow':'snowLight';
  if (code>=51&&code<=57) return 'drizzle';
  return pr>=0.2?'heavy':pr>=0.05?'steady':'light';
}
// One scoring path for hourly and 15-min points. x: {t,t24,w,g,cc,pr,pp,code,d3,d12,p,time,prime,sure}
function scoreHour(x){
  const f = {}, k = x.prime ? CFG.PRIME_DAMP : 1, S = CFG.SKY;
  f.temp = band(x.t, CFG.TEMP_ABS)*k;
  f.change = x.t24==null ? 0 : clamp(-(x.t-x.t24)*CFG.TEMP_DROP_PER_F, CFG.TEMP_RISE_MAX, CFG.TEMP_DROP_MAX)*k;
  f.wind = (band(x.w, CFG.WIND) + band(x.g||0, CFG.GUST))*k;
  f.cloud = (x.cc<30 ? (x.t>=S.warmF?S.clearWarm:x.t<S.coolF?S.clearCool:0) : x.cc<85 ? S.partly : (x.t>=S.warmF?S.overcastWarm:x.t<S.coolF?S.overcastCool:0))*k;
  f.press = (x.d3 <= CFG.PRESS_FALL_3H ? CFG.PRESS_FALL_PTS : (x.d3 >= CFG.POST_FRONT_RISE_3H && x.d12 <= CFG.POST_FRONT_FALL_12H) ? CFG.POST_FRONT_PTS : x.p >= CFG.PRESS_HIGH ? CFG.PRESS_HIGH_PTS : 0)*k;
  f.rut = rutFor(x.time).bonus;
  const dry = clamp(CFG.BASE + Object.values(f).reduce((a,b)=>a+b,0), 0, 100);
  const codeWet = x.code!=null && (x.code==45||x.code==48||x.code>=51);
  let q = x.sure ? 1 : Math.max((x.pp||0)/100, codeWet?0.6:0, x.pr>0.004?0.5:0);
  if (x.code==45||x.code==48) q = Math.max(q, 1);
  let wc = null, s = dry;
  if (q > 0.05) {
    wc = wetClass(x.code, x.pr); let [m, cap] = CFG.WET[wc];
    if ((wc==='light'||wc==='drizzle') && x.w >= CFG.WINDY_RAIN_MPH) { m += CFG.WINDY_RAIN_RELIEF[0]; cap += CFG.WINDY_RAIN_RELIEF[1]; }
    const wet = Math.min(dry*m, cap); s = dry*(1-q) + wet*q;
  }
  f.precip = s - dry;
  return {s: Math.round(cal(s)), raw: Math.round(s), f, wc: q>0.05?wc:null, q};
}

function model(d, nr, rep){
  const H = d.hourly, n = H.time.length, T = H.time.map(tm), hours = [];
  const curH = nr && nr.omTime ? nr.omTime.slice(0,13)+':00' : null;
  const nowM = Math.floor((Date.now()/6e4 + (d.utc_offset_seconds||0)/60)/60)*60;
  const repEnd = rep ? Math.floor(((rep.exp)/6e4 + (d.utc_offset_seconds||0)/60)/60)*60 : 0, repStart = rep ? Math.floor((rep.at/6e4 + (d.utc_offset_seconds||0)/60)/60)*60 : 0;
  for (let i=0;i<n;i++){
    const p = H.pressure_msl, f = {}, live = curH && H.time[i]===curH;
    let t = H.temperature_2m[i], w = H.wind_speed_10m[i], wd = H.wind_direction_10m[i], pr = effPr(H.precipitation[i], H.weather_code&&H.weather_code[i], H.precipitation_probability[i]), pp = H.precipitation_probability[i];
    if (live) { if (nr.t!=null) t = nr.t; if (nr.w!=null) w = nr.w; if (nr.wd!=null) wd = nr.wd; pr = Math.max(pr, nr.rate); pp = Math.max(pp||0, nr.pp2||0, nr.wet?100:0); }
    const rp = rep && T[i] >= Math.min(repStart,nowM) && T[i] <= repEnd; const dryRep = rp && rep.lvl==='dry'; if (dryRep) { pr = 0; pp = 0; } else if (rp) { pr = Math.max(pr, CFG.RAIN_REPORT[rep.lvl][0]); pp = 100; }
    const t24 = i>=24 ? H.temperature_2m[i-24] : null, d3 = i>=3 ? p[i]-p[i-3] : 0, d12 = i>=15 ? p[i-3]-p[i-15] : 0;
    let code = H.weather_code ? H.weather_code[i] : null, cc = H.cloud_cover[i];
    if (live && nr.code!=null) code = nr.wet ? Math.max(code||0, nr.code) : nr.code; if (live && nr.cc!=null) cc = nr.cc;
    if (dryRep && code>=51) code = 3; else if (rp && !(code>=51)) code = null;
    const day = H.time[i].slice(0,10), dl = d.daily.time.indexOf(day), srm = dl>=0?tm(d.daily.sunrise[dl]):0, ssm = dl>=0?tm(d.daily.sunset[dl]):0;
    const prime = dl>=0 && ((T[i] >= srm+CFG.PRIME_DAWN[0] && T[i] <= srm+CFG.PRIME_DAWN[1]) || (T[i] >= ssm+CFG.PRIME_DUSK[0] && T[i] <= ssm+CFG.PRIME_DUSK[1]));
    const r = scoreHour({t, t24, w, g:H.wind_gusts_10m[i], cc, pr, pp, code, d3, d12, p:p[i], time:H.time[i], prime, sure: !dryRep && (rp || (live && nr.wet))});
    const s = r.s; Object.assign(f, r.f);
    hours.push({i, m:T[i], time:H.time[i], s, f, t, t24, w, g:H.wind_gusts_10m[i], wd, cc, pr, pp:pp||0, p:p[i], dp:d3, d12, code, prime, live, rp, wc:r.wc, q:r.q});
  }
  const days = d.daily.time.map((date, k) => {
    const sr = tm(d.daily.sunrise[k]), ss = tm(d.daily.sunset[k]);
    const hs = hours.filter(h => h.time.startsWith(date));
    const inPrime = h => (h.m >= sr+CFG.PRIME_DAWN[0] && h.m <= sr+CFG.PRIME_DAWN[1]) || (h.m >= ss+CFG.PRIME_DUSK[0] && h.m <= ss+CFG.PRIME_DUSK[1]);
    const prime = hs.filter(inPrime), mid = hs.filter(h => !inPrime(h) && h.m > sr && h.m < ss);
    const avg = a => a.length ? a.reduce((x,h)=>x+h.s,0)/a.length : null;
    const pa = avg(prime), ma = avg(mid);
    const score = Math.round(pa==null ? (avg(hs)||0) : ma==null ? pa : pa*CFG.DAY_WEIGHTS.prime + ma*CFG.DAY_WEIGHTS.midday);
    const src = prime.length ? prime : hs, fs = {};
    for (const key of ['temp','change','wind','cloud','precip','press','rut']) fs[key] = src.reduce((a,h)=>a+h.f[key],0)/(src.length||1);
    return {date, k, sr, ss, hs, rp: hs.some(h=>h.rp), score, fs, reason: reason(fs, hs, src, prime), rut: rutFor(date)};
  });
  return {hours, days: days.slice(1)}; // drop the past day (only used for day-over-day change)
}
function reason(fs, hs, src, prime){
  const tx = [];
  const tAvg = src.reduce((a,h)=>a+h.t,0)/(src.length||1), wAvg = src.reduce((a,h)=>a+h.w,0)/(src.length||1);
  const dir = compass(src.reduce((a,h)=>a+h.wd,0)/(src.length||1));
  const P = prime && prime.length ? prime : src, ppMax = Math.max(0, ...P.map(h=>h.pp||0)), wet = P.filter(h=>h.wc && h.wc!=='snowLight');
  if (wet.length && fs.precip <= -4 && (ppMax >= 25 || wet.some(h=>h.rp||h.live))) { const worst = wet.reduce((a,h)=>CFG.WET[h.wc][1]<CFG.WET[a.wc][1]?h:a);
    tx.push(`− ${CFG.WET[worst.wc][2].toLowerCase()} ${worst.rp||worst.live&&worst.pp>=100?'now':ppMax+'% chance'} at dawn/dusk`); }
  const ranked = Object.entries(fs).filter(([k])=>k!=='precip'&&k!=='rut').sort((a,b)=>Math.abs(b[1])-Math.abs(a[1]));
  const say = {temp:v=> v>0?`cool ${Math.round(tAvg)}°F`:`warm ${Math.round(tAvg)}°F`,
    change:v=> v>0?'temps dropping vs yesterday':'warmer than yesterday',
    wind:v=> v>0?`${Math.round(wAvg)} mph ${dir} wind`:`${Math.round(wAvg)} mph ${dir} wind`,
    cloud:v=> v>0?'clear and cool':'sunny and warm', press:v=>'front moving through'};
  for (const [k,v] of ranked){ if (tx.length===2) break; if (Math.abs(v) < 2.5) continue; tx.push((v>0?'+ ':'− ')+say[k](v)); }
  return tx.length ? tx.join(' · ') : 'Average conditions';
}
// 15-minute series when Open-Meteo has minutely_15 (US); cloud/pressure interpolated from hourly
function fine(d, mdl, day){
  const M = d.minutely_15; if (!M || !M.time) return null;
  const out = [], hs = mdl.hours;
  for (let j=0;j<M.time.length;j++){
    if (!M.time[j].startsWith(day.date) || M.temperature_2m[j]==null) continue;
    const m = tm(M.time[j]), hi = hs.findIndex(h => h.m > m) - 1; if (hi < 0) continue;
    const h = hs[hi];
    const pr15 = Math.max(effPr((M.precipitation[j]||0)*4, M.weather_code&&M.weather_code[j], h.pp), (h.live||h.rp)?h.pr:0);
    const r = scoreHour({t:M.temperature_2m[j], t24:h.t24, w:M.wind_speed_10m[j], g:M.wind_gusts_10m[j], cc:h.cc, pr:pr15, pp:h.pp, code:(h.live||h.rp)?h.code:(M.weather_code?M.weather_code[j]:h.code), d3:h.dp, d12:h.d12, p:h.p, time:h.time, prime:h.prime, sure:h.live&&h.q===1||h.rp});
    out.push({m, s: r.s, t:M.temperature_2m[j], w:M.wind_speed_10m[j], g:M.wind_gusts_10m[j], wd:M.wind_direction_10m[j], pr:pr15, cc:h.cc, p:h.p, dp:h.dp, pp:h.pp});
  }
  return out.length > 40 ? out : null;
}

/* best 2-hour block (avg score) within daylight sunrise-30 .. sunset+30 */
function bestWindow(pts, day){
  const D = pts.filter(p => p.m >= day.sr-30 && p.m <= day.ss+30); let best = null;
  for (const p of D){ const v = D.filter(q => q.m >= p.m && q.m < p.m+120); if (!v.length || v[v.length-1].m - p.m < 60) continue;
    const a = v.reduce((x,q)=>x+q.s,0)/v.length; if (!best || a > best[2]) best = [p.m, p.m+120, a]; }
  return best || [D[0]?.m||pts[0].m, (D[0]?.m||pts[0].m)+120, (D[0]||pts[0]).s];
}
/* ---------- legal shooting hours (deer) ---------- */
const LEGAL = {
  MN: {pre:30, post:30, rule:'½ hour before sunrise to ½ hour after sunset', src:'https://www.revisor.mn.gov/statutes/cite/97B.075', srcName:'Minn. Stat. 97B.075(b) (big game)'},
  WI: {pre:30, post:20, rule:'30 min before sunrise to 20 min after sunset', src:'https://dnr.wisconsin.gov/topic/Hunt/regulations/OnlineHuntingRegulations/ShootingHoursDeerBearElkSmallGameFallTurkey', srcName:'WI DNR deer shooting hours tables', note:'WI officially uses printed DNR tables by area and longitude zone; this is computed from local sunrise/sunset and may differ by a few minutes.'}};
const ST_ABBR = {minnesota:'MN', wisconsin:'WI', mn:'MN', wi:'WI'};
function bboxState(lat, lon){ if (lat==null||lon==null) return null;
  const inMN = lat>=43.49&&lat<=49.39&&lon>=-97.24&&lon<=-89.48, inWI = lat>=42.49&&lat<=47.31&&lon>=-92.89&&lon<=-86.8;
  if (inMN && !inWI) return 'MN'; if (inWI && !inMN) return 'WI';
  if (inMN && inWI) { if (lat>46.8 && lon<-92.0) return 'MN'; if (lon<=-92.75) return 'MN'; if (lon>=-92.6 && lat<46.6) return 'WI'; }
  return null; }
function locState(l){ if (!l) return null; const pick = v => ST_ABBR[String(v||'').trim().toLowerCase()] || null;
  if (l.st && pick(l.st)) return pick(l.st);
  const nm = String(l.name||''); const m = nm.match(/\b(Minnesota|Wisconsin)\b/i) || nm.match(/,\s*(MN|WI)\b/i); if (m) return pick(m[1]);
  return pick(nm.split(',').pop()); }
async function ensureState(l, idx){ if (locState(l)) { const s0 = locState(l); if (l.st !== s0) { const L = getLocs(); if (L[idx] && L[idx].lat===l.lat) { L[idx].st = s0; setLocs(L); } l.st = s0; } return; }
  let st = null;
  try { const r = await (await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&zoom=5&lat=${l.lat}&lon=${l.lon}`)).json(); st = ST_ABBR[String((r.address||{}).state||'').toLowerCase()] || null; } catch {}
  st = st || bboxState(l.lat, l.lon); if (!st) return;
  const L = getLocs(); if (L[idx] && L[idx].lat===l.lat) { L[idx].st = st; setLocs(L); } l.st = st; }
function migrateLocs(){ const L = getLocs(); let ch = 0; L.forEach(l => { const s0 = locState(l) || bboxState(l.lat, l.lon); if (s0 && l.st !== s0) { l.st = s0; ch = 1; } }); if (ch) setLocs(L); }
try { migrateLocs(); } catch {}
const legalFor = (l, day) => { const k = locState(l), r = LEGAL[k||'MN']; return {a: day.sr - r.pre, b: day.ss + r.post, r, st:k||'MN', guess:!k}; };
const legalLine = (l, d, big) => { const lg = legalFor(l, d); return `<div class="sun">☀ Sunrise ${fmtT(d.sr)} · Sunset ${fmtT(d.ss)}</div><div class="legal${big?' big':''}"><small class="rule">${lg.st}${lg.guess?' rule (state unknown)':''}: ${lg.r.rule}</small><div class="lt">Legal shooting time: ${fmtT(lg.a)} – ${fmtT(lg.b)}</div></div>`; };
const stPicker = l => locState(l) ? '' : `<div class="legal pick">State not detected — using MN rule. Set state: <button class="sg" data-st="MN">MN</button><button class="sg" data-st="WI">WI</button></div>`;
/* ---------- SVG charts ---------- */
function chart(pts, key, opt){
  const W = 360, H = opt.h||110, L = 30, R = 8, Tp = opt.dirs ? 18 : 8, B = 18, x0 = pts[0].m, x1 = pts[pts.length-1].m;
  const vals = pts.map(p=>p[key]).concat(opt.key2 ? pts.map(p=>p[opt.key2]||0) : []); let lo = opt.min ?? Math.min(...vals), hi = opt.max ?? Math.max(...vals);
  if (hi-lo < (opt.span||1)) { const c=(hi+lo)/2; lo=c-(opt.span||1)/2; hi=c+(opt.span||1)/2; } if (opt.min!=null && lo<opt.min){ hi+=opt.min-lo; lo=opt.min; }
  if (opt.pad && opt.max==null) hi += (hi-lo)*opt.pad; if (opt.nice) { const st = opt.nice; lo = Math.floor(lo/st)*st; hi = Math.ceil(hi/st)*st; }
  const X = m => L + (m-x0)/(x1-x0||1)*(W-L-R), Y = v => Tp + (1-(v-lo)/(hi-lo||1))*(H-Tp-B);
  let g = '';
  const {sr, ss} = opt.day;
  g += `<rect x="${L}" y="${Tp}" width="${Math.max(0,X(sr)-L)}" height="${H-Tp-B}" fill="#000" opacity=".35"/><rect x="${X(ss)}" y="${Tp}" width="${Math.max(0,W-R-X(ss))}" height="${H-Tp-B}" fill="#000" opacity=".35"/>`;
  if (opt.legal){ const la = X(Math.max(x0,opt.legal.a)), lb = X(Math.min(x1,opt.legal.b)); g += `<rect x="${la}" y="${H-B-3}" width="${Math.max(0,lb-la)}" height="3" fill="#3ecf8e" opacity=".8"/><line x1="${la}" x2="${la}" y1="${Tp}" y2="${H-B}" stroke="#3ecf8e" stroke-width=".8" stroke-dasharray="2 3" opacity=".7"/><line x1="${lb}" x2="${lb}" y1="${Tp}" y2="${H-B}" stroke="#3ecf8e" stroke-width=".8" stroke-dasharray="2 3" opacity=".7"/><text x="${la+2}" y="${Tp+8}" fill="#3ecf8e" font-size="8">Legal ${fmtT(opt.legal.a)}</text><text x="${lb-2}" y="${Tp+8}" fill="#3ecf8e" font-size="8" text-anchor="end">${fmtT(opt.legal.b)}</text><rect x="${la}" y="${Tp}" width="${Math.max(0,lb-la)}" height="${H-Tp-B}" fill="#3ecf8e" opacity=".05"/>`; }
  for (const [a,b] of [[sr+CFG.PRIME_DAWN[0], sr+CFG.PRIME_DAWN[1]], [ss+CFG.PRIME_DUSK[0], ss+CFG.PRIME_DUSK[1]]])
    g += `<rect x="${X(a)}" y="${Tp}" width="${X(b)-X(a)}" height="${H-Tp-B}" fill="#e8792b" opacity=".13"/>`;
  if (opt.bands) for (const [a,b,nm,c] of CFG.BANDS){ const ya = Y(clamp(a,lo,hi)), yb = Y(clamp(b,lo,hi)); if (ya-yb < 1) continue;
    g += `<rect x="${L}" y="${yb}" width="${W-L-R}" height="${ya-yb}" fill="${c}" opacity=".07"/>`; if (ya-yb >= 9) g += `<text x="${W-R-3}" y="${yb+9}" fill="${c}" font-size="8" text-anchor="end" opacity=".75">${nm}</text>`; }
  const nt = opt.ticks || 2;
  const tv = opt.bands ? [lo, ...CFG.BANDS.map(b=>b[0]).filter(v=>v>lo+7&&v<hi-7), hi] : Array.from({length:nt+1},(_,k)=>lo+(hi-lo)*k/nt);
  for (const v of tv){ g += `<line x1="${L}" x2="${W-R}" y1="${Y(v)}" y2="${Y(v)}" stroke="#252c36"/><text x="${L-4}" y="${Y(v)+3}" fill="#8a94a3" font-size="9" text-anchor="end">${opt.fmt?opt.fmt(v):Math.round(v)}</text>`; }
  for (let h=0;h<=24;h+=6){ const m = x0 - (x0%1440) + h*60; if (m<x0||m>x1+1) continue; g += `<text x="${X(m)}" y="${H-5}" fill="#8a94a3" font-size="9" text-anchor="middle">${h===0?'12a':h===12?'12p':h<12?h+'a':(h-12)+'p'}</text>`; }
  if (opt.bars){ const bw = Math.max(1,(W-L-R)/pts.length-1); pts.forEach(p=>{ if(p[key]>0) g += `<rect x="${X(p.m)-bw/2}" y="${Y(p[key])}" width="${bw}" height="${Y(lo)-Y(p[key])}" fill="${opt.color}"/>`; }); }
  else {
    const d = pts.map((p,i)=>(i?'L':'M')+X(p.m).toFixed(1)+' '+Y(p[key]).toFixed(1)).join('');
    if (opt.bands){ g += `<path d="${d}L${X(x1)} ${Y(lo)}L${X(x0)} ${Y(lo)}Z" fill="#e6e9ee" opacity=".05"/>`;
      for (let i=1;i<pts.length;i++){ const a = pts[i-1], b = pts[i]; g += `<line x1="${X(a.m).toFixed(1)}" y1="${Y(a[key]).toFixed(1)}" x2="${X(b.m).toFixed(1)}" y2="${Y(b[key]).toFixed(1)}" stroke="${color((a[key]+b[key])/2)}" stroke-width="2.6" stroke-linecap="round"/>`; }
      if (opt.win){ const [a,b,v] = opt.win, xa = X(a), xb = X(b), yv = Y(v); g += `<rect x="${xa}" y="${Tp}" width="${Math.max(2,xb-xa)}" height="${H-Tp-B}" fill="none" stroke="#e6e9ee" stroke-dasharray="2 2" opacity=".6"/><line x1="${xa}" x2="${xb}" y1="${yv}" y2="${yv}" stroke="#e6e9ee" stroke-width="1.5"/>`;
        const tx = clamp((xa+xb)/2, L+28, W-R-28), ty = yv-6 < Tp+8 ? yv+12 : yv-6; g += `<text x="${tx}" y="${ty}" fill="#e6e9ee" font-size="9" font-weight="700" text-anchor="middle" paint-order="stroke" stroke="#0d1014" stroke-width="3">Best ${fmtT(a)}–${fmtT(b)} · ${Math.round(v)}</text>`; } }
    else g += `<path d="${d}" fill="none" stroke="${opt.color}" stroke-width="2" stroke-linejoin="round"/>`;
    if (opt.key2) g += `<path d="${pts.map((p,i)=>(i?'L':'M')+X(p.m).toFixed(1)+' '+Y(p[opt.key2]).toFixed(1)).join('')}" fill="none" stroke="${opt.color}" stroke-width="1" stroke-dasharray="3 3" opacity=".7"/>`;
  }
  if (opt.dirs){ const per = pts.length > 30 ? Math.round(pts.length/8) : 3; for (let i=Math.floor(per/2);i<pts.length;i+=per){ const p = pts[i]; g += `<text x="${clamp(X(p.m),L+8,W-R-8)}" y="${Tp-6}" fill="#e6e9ee" font-size="9" font-weight="600" text-anchor="middle" opacity=".85">${compass16(p.wd)}</text>`; } }
  g += `<line class="cur" x1="0" x2="0" y1="${Tp}" y2="${H-B}" stroke="#ff9a52" stroke-width="1" opacity="0"/>`;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" overflow="hidden" data-x0="${x0}" data-x1="${x1}" data-l="${L}" data-r="${R}" data-w="${W}">${g}</svg>`;
}
function bindCharts(pts, tipEl){
  const svgs = [...view.querySelectorAll('svg.chart')];
  const show = (ev, svg) => {
    const r = svg.getBoundingClientRect(), W = +svg.dataset.w, L = +svg.dataset.l, R = +svg.dataset.r, x0 = +svg.dataset.x0, x1 = +svg.dataset.x1;
    const cx = ((ev.touches ? ev.touches[0].clientX : ev.clientX) - r.left) / r.width * W;
    const m = x0 + clamp((cx-L)/(W-L-R),0,1)*(x1-x0); let best = pts[0];
    for (const p of pts) if (Math.abs(p.m-m) < Math.abs(best.m-m)) best = p;
    const px = L + (best.m-x0)/(x1-x0||1)*(W-L-R);
    svgs.forEach(s => { const c = s.querySelector('.cur'); c.setAttribute('x1',px); c.setAttribute('x2',px); c.setAttribute('opacity','1'); });
    tipEl.innerHTML = `<b>${fmtT(best.m)}</b> · score <b style="color:${color(best.s)}">${best.s}</b> · ${Math.round(best.t)}°F · ${compass16(best.wd)} ${Math.round(best.w)} mph, gusts ${Math.round(best.g)} · ${Math.round(best.cc)}% cloud · ${best.pr.toFixed(2)}"/hr · ${Math.round(best.pp||0)}% chance · ${Math.round(best.p)} hPa`;
  };
  svgs.forEach(s => { s.addEventListener('pointermove', e => show(e,s)); s.addEventListener('pointerdown', e => show(e,s)); s.addEventListener('touchmove', e => show(e,s), {passive:true}); });
}

/* ---------- views ---------- */
const state = {data:{}, models:{}};
function setRut(){ const today = new Date(), ds = today.getFullYear()+'-'+String(today.getMonth()+1).padStart(2,'0')+'-'+String(today.getDate()).padStart(2,'0'), r = rutFor(ds);
  $('#rut').innerHTML = `🦌 <b>Rut phase: ${r.name}</b>${r.bonus?` (+${r.bonus} pts)`:''} <span style="color:var(--mut)">· ${r.blurb} Northern MN/WI calendar estimate.</span>`; }

function home(){
  $('#back').hidden = true; location.hash = '';
  const locs = getLocs();
  view.innerHTML = `<form class="add" id="addF"><input id="q" placeholder="Zip code or address" autocomplete="postal-code" enterkeyhint="go"><button class="btn">Add</button></form>
  <button class="btn ghost" id="geo">📍 Use my location</button><div class="msg" id="msg"></div>
  <div id="cards">${locs.length ? '' : '<div class="card" style="color:var(--mut)">Add a zip code (try 54020) or an address to see the 7-day deer movement outlook.</div>'}</div>
  <div class="note">An estimate from weather and calendar patterns, not a guarantee. Weather: Open-Meteo, NWS. <a href="#" id="homeStudies">Studies cited</a>. Built by Rusty Dingo Arms. <span class="ver">${VERSION}</span></div>`;
  $('#homeStudies').onclick = e => { e.preventDefault(); openSheet('studies'); };
  $('#addF').onsubmit = async e => { e.preventDefault(); const q = $('#q').value; if (!q.trim()) return; $('#msg').textContent = 'Finding…';
    const g = await geocode(q); if (!g) { $('#msg').textContent = 'Could not find that location. Try a 5-digit zip or "City, ST".'; return; }
    setLocs([...getLocs(), g]); home(); };
  $('#geo').onclick = () => { if (!navigator.geolocation) { $('#msg').textContent = 'Location not available.'; return; } $('#msg').textContent = 'Getting location…';
    navigator.geolocation.getCurrentPosition(async p => { const lat = +p.coords.latitude.toFixed(4), lon = +p.coords.longitude.toFixed(4); let name = 'My location', stName = '';
      try { const r = await (await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&zoom=10&lat=${lat}&lon=${lon}`)).json(); const a = r.address||{}; stName = a.state||''; name = '📍 '+(a.city||a.town||a.village||a.county||'My location')+(a.state?', '+a.state:''); } catch {}
      setLocs([...getLocs(), {name, lat, lon, st:stName}]); home(); }, () => { $('#msg').textContent = 'Location permission denied.'; }, {timeout:15000}); };
  locs.forEach((l,idx) => renderCard(l, idx, locs.length));
}
async function renderCard(l, idx, n, el){
  if (!el) { el = document.createElement('div'); el.className = 'card'; $('#cards').appendChild(el); }
  const head = `<div class="ch"><h3>${esc(l.name)}</h3><button class="iconbtn sm" data-a="up" ${idx?'':'disabled'} aria-label="Move up">↑</button><button class="iconbtn sm" data-a="dn" ${idx<n-1?'':'disabled'} aria-label="Move down">↓</button><button class="iconbtn sm" data-a="rm" aria-label="Remove">✕</button></div>`;
  el.innerHTML = head + '<div class="msg">Loading forecast…</div>';
  const act = a => { const L = getLocs(); if (a==='rm'){ if(!confirm('Remove '+l.name+'?')) return; L.splice(idx,1); } else { const j = a==='up'?idx-1:idx+1; [L[idx],L[j]] = [L[j],L[idx]]; } setLocs(L); home(); };
  const bind = () => el.querySelectorAll('[data-a]').forEach(b => b.onclick = () => act(b.dataset.a));
  bind();
  try {
    const [c, nc] = await Promise.all([weather(l), nowcast(l).catch(()=>null), ensureState(l, idx)]), nr = nc ? nowRead(nc) : null, rep = getRain(l), mdl = model(c.d, nr, rep); state.data[idx] = c.d; state.models[idx] = mdl;
    const lh = mdl.hours.find(h=>h.live);
    const strip = nr ? `<div class="now"><div class="nowt"><b>Right now</b>${lh?` <span class="sc sm" style="background:${color(lh.s)}">${lh.s}</span>`:''}</div><div class="nowv">${nr.t!=null?Math.round(nr.t)+'°F':''} · ${nr.w!=null?Math.round(nr.w)+' mph '+(nr.wd!=null?compass16(nr.wd):''):''} · ${esc(nr.sky)} · <b style="color:${rep&&rep.lvl==='dry'?'#3ecf8e':nr.wet||rep?'#5aa9ff':'inherit'}">${rep?(rep.lvl==='dry'?'Dry (you)':'Rain (you)'):nr.wet?'Wet '+nr.rate.toFixed(2)+'"/hr':'Dry'}</b>${lh&&lh.f.precip<-0.5?` (${Math.round(lh.f.precip)} pts)`:''}</div><small>Next hour: <b>${nr.firstWet?(nr.firstWet.in<=0?'raining now':'rain in ~'+nr.firstWet.in+' min')+' ('+nr.firstWet.rate.toFixed(2)+'"/hr, Open-Meteo 15-min)':'no rain in Open-Meteo 15-min nowcast'}</b> · next 2 hr max ${nr.next2>0.004?nr.next2.toFixed(2)+'"/hr':'dry'}${nr.h0?' · NWS '+nr.pp2+'% · '+esc(nr.h0.txt):''}<br>📍 ${esc(l.name)} · ${nr.ob?`NWS ${nr.ob.id}${nr.ob.mi!=null?' ('+Math.round(nr.ob.mi)+' mi away)':''} obs ${fmtClock(nr.ob.ts)}`:'No nearby NWS obs'}${nr.omTime?` · Open-Meteo ${fmtT(tm(nr.omTime))}`:''}${nc.stale?' · offline':''}</small>${rainUI(rep)}</div>` : rainUI(rep);
    el.innerHTML = head + `<div class="todayLegal">Today · ${legalLine(l, mdl.days[0], 1)}</div>` + stPicker(l) + strip + (c.stale?'<div class="msg">Offline: showing last saved forecast.</div>':'') + '<div class="days">' + mdl.days.map((d,k) => { const dt = new Date(Date.UTC(...d.date.split('-').map((v,i)=>i==1?v-1:+v)));
      return `<button class="day" data-k="${k}"><div class="dn"><b>${k===0?'Today':DOW[dt.getUTCDay()]}</b><small>${dt.getUTCMonth()+1}/${dt.getUTCDate()}</small></div><div class="sc" style="background:${color(d.score)}">${d.score}</div><div class="why"><b>${label(d.score)}</b> · ${d.rut.name}<br>${esc(d.reason)}${legalLine(l,d)}</div></button>`; }).join('') + '</div>';
    bind(); el.querySelectorAll('[data-rain]').forEach(b => b.onclick = () => { setRain(l, b.dataset.rain); delete state.data[idx]; renderCard(l, idx, n, el); });
    el.querySelectorAll('[data-st]').forEach(b => b.onclick = () => { const L = getLocs(); if (L[idx]) { L[idx].st = b.dataset.st; setLocs(L); } l.st = b.dataset.st; renderCard(l, idx, n, el); });
    el.querySelectorAll('.day').forEach(b => b.onclick = () => detail(idx, +b.dataset.k));
  } catch (e) { el.innerHTML = head + `<div class="msg">Forecast unavailable (${esc(e.message)}). Check your connection.</div>`; bind(); }
}
function rainUI(rep){
  const cur = rep ? rep.lvl : '', opts = [['','Auto'],['dry','☀ Dry'],['light','Light'],['steady','Steady'],['heavy','Heavy']];
  const msg = rep ? `<b>You set: ${rep.lvl==='dry'?'not raining':CFG.RAIN_REPORT[rep.lvl][1].toLowerCase()+' rain'}</b> at ${fmtClock(rep.at)} <small>(overrides forecast/station until ${fmtClock(rep.exp)})</small>` : `<span>Raining where you are? Tap to override the forecast for ~2 hr.</span>`;
  return `<div class="rain ${rep?'on':''}">${msg}<div class="seg" role="radiogroup">${opts.map(([k,v])=>`<button class="sg ${k===cur?'on':''} ${k==='dry'?'dry':''}" role="radio" aria-checked="${k===cur}" data-rain="${k}">${v}</button>`).join('')}</div></div>`;
}

function detail(idx, k){
  const l = getLocs()[idx], d = state.data[idx], mdl = state.models[idx], day = mdl.days[k]; if (!day) return home();
  location.hash = 'd'; $('#back').hidden = false; window.scrollTo(0,0);
  const f15 = fine(d, mdl, day), lg = legalFor(l, day), lgTxt = `${fmtT(lg.a)} – ${fmtT(lg.b)}`; let res = f15 ? '15' : '60';
  const draw = () => {
    const pts = res==='15' && f15 ? f15 : day.hs, dt = new Date(Date.UTC(...day.date.split('-').map((v,i)=>i==1?v-1:+v)));
    const best = [...day.hs].filter(h=>h.m>=day.sr-60&&h.m<=day.ss+30).sort((a,b)=>b.s-a.s)[0] || day.hs[0];
    const win = bestWindow(pts, day), pa = (a) => { const v = pts.filter(p=>p.m>=a[0]&&p.m<=a[1]); return v.length ? Math.round(v.reduce((x,p)=>x+p.s,0)/v.length) : null; };
    const dawnA = pa([day.sr+CFG.PRIME_DAWN[0], day.sr+CFG.PRIME_DAWN[1]]), duskA = pa([day.ss+CFG.PRIME_DUSK[0], day.ss+CFG.PRIME_DUSK[1]]);
    const sv = pts.map(p=>p.s), slo = Math.max(0, Math.min(...sv)-8), shi = Math.min(100, Math.max(...sv)+8), sp = Math.max(30, shi-slo), smid = (slo+shi)/2;
    const smin = Math.max(0, Math.min(100-sp, smid-sp/2)), smax = smin+sp;
    const chip = (n,v) => v==null?'':`<span>${n} <b style="color:${color(v)}">${v}</b></span>`;
    const fsRow = Object.entries(day.fs).map(([kk,v])=>`<div class="fact"><small>${{temp:'Temperature',change:'Change vs yesterday',wind:'Wind',cloud:'Sky (cloud × temp)',precip:'Rain / snow / fog',press:'Pressure / fronts',rut:'Rut phase'}[kk]}</small><b style="color:${v>0.5?'#3ecf8e':v<-0.5?'#ff5d5d':'#e6e9ee'}">${v>0?'+':''}${v.toFixed(1)} pts</b></div>`).join('');
    view.innerHTML = `<div class="card"><div class="ch"><h3>${esc(l.name)} · ${DOW[dt.getUTCDay()]} ${dt.getUTCMonth()+1}/${dt.getUTCDate()}</h3><div class="sc" style="background:${color(day.score)}">${day.score}</div></div>
      <div class="why"><b>${label(day.score)}</b> · ${esc(day.reason)}</div>${legalLine(l, day, 1)}
      <div class="facts" style="margin-top:10px"><div class="fact"><small>Sunrise / Sunset</small><b>${fmtT(day.sr)} / ${fmtT(day.ss)}</b></div><div class="fact"><small>Best hour (daylight)</small><b>${fmtT(best.m)} · ${best.s}</b></div><div class="fact"><small>Legal shooting hours (${lg.st}${lg.guess?'?':''})</small><b style="color:#3ecf8e">${lgTxt}</b></div><div class="fact"><small>Rut phase</small><b>${day.rut.name}${day.rut.bonus?' +'+day.rut.bonus:''}</b></div><div class="fact"><small>Prevailing wind (daylight)</small><b>${prevail(day.hs.filter(h=>h.m>=day.sr&&h.m<=day.ss))} · ${Math.round(Math.max(...day.hs.map(h=>h.w)))} mph max</b></div><div class="fact"><small>Temp range</small><b>${Math.round(Math.min(...day.hs.map(h=>h.t)))}–${Math.round(Math.max(...day.hs.map(h=>h.t)))}°F</b></div></div></div>
      <div class="card"><div class="tabs">${f15?`<button class="tab ${res==='15'?'on':''}" data-r="15">15-min</button>`:''}<button class="tab ${res==='60'?'on':''}" data-r="60">Hourly</button></div>
      <div class="tip" id="tip">Tap or drag a chart. Orange bands are the dawn/dusk prime windows; dark is night; green dashed lines + bar mark legal shooting hours.</div>
      <div class="ct"><span>Favorability</span><span class="chips">${chip('Dawn',dawnA)}${chip('Dusk',duskA)}</span></div>${chart(pts,'s',{day,legal:lg,min:Math.floor(smin/5)*5,max:Math.ceil(smax/5)*5,bands:1,win,ticks:3,h:140})}
      <div class="small mut" style="margin-top:2px">Best 2-hr daylight window: <b style="color:${color(win[2])}">${fmtT(win[0])}–${fmtT(win[1])} · ${Math.round(win[2])} ${label(win[2])}</b>. Scale zooms to the day; bands show the rating.</div>
      <div class="ct"><span>Temperature °F</span><span>${Math.round(pts[0].t)}° to ${Math.round(pts[pts.length-1].t)}°</span></div>${chart(pts,'t',{day,legal:lg,color:'#ff9a52',span:6})}
      <div class="ct"><span>Wind mph · dashed = gusts · letters = wind FROM</span></div>${chart(pts,'w',{day,legal:lg,color:'#5aa9ff',key2:'g',min:0,dirs:1,span:10,pad:0.12,nice:5,h:125})}
      <div class="ct"><span>Cloud cover %</span></div>${chart(pts,'cc',{day,legal:lg,color:'#8a94a3',min:0,max:100,h:110})}
      <div class="ct"><span>Precipitation in/${res==='15'?'15 min':'hr'}</span><span>max chance ${Math.max(...day.hs.map(h=>h.pp||0))}%</span></div>${chart(pts,'pr',{day,legal:lg,color:'#5aa9ff',min:0,bars:1,span:0.05,fmt:v=>v.toFixed(2)})}
      <div class="ct"><span>Rain chance %</span><span>Open-Meteo hourly</span></div>${chart(pts,'pp',{day,legal:lg,color:'#5aa9ff',min:0,max:100})}
      <div class="ct"><span>Pressure hPa (trend)</span><span>${(day.hs[day.hs.length-1].p-day.hs[0].p>0?'▲ ':'▼ ')+Math.abs(day.hs[day.hs.length-1].p-day.hs[0].p).toFixed(1)} today</span></div>${chart(pts,'p',{day,legal:lg,color:'#3ecf8e',span:4})}</div>
      <div class="card"><b>Factor breakdown (prime windows)</b><div class="facts" style="margin-top:8px">${fsRow}</div>${day.rp?`<div class="msg" style="color:#5aa9ff">Precipitation includes your report (${getRain(l).lvl==='dry'?'not raining':CFG.RAIN_REPORT[getRain(l).lvl][1].toLowerCase()+' rain'}, ${fmtClock(getRain(l).at)}) for the current and next 2 hours.</div>`:''}</div>
      <div class="note">${lg?`Legal hours${lg.guess?' (state unknown, MN rule shown)':''}: ${lg.r.rule} (<a href="${lg.r.src}" target="_blank" rel="noopener">${lg.r.srcName}</a>). ${lg.r.note||''} `:'Legal hours shown only for MN and WI locations. '}Always confirm current regulations before you shoot. Estimate only.</div>`;
    view.querySelectorAll('.tab').forEach(b => b.onclick = () => { res = b.dataset.r; draw(); });
    bindCharts(pts, $('#tip'));
  };
  draw();
}

/* ---------- how sheet + studies ---------- */
// Evidence: S = strong/replicated, M = moderate/some studies, W = weak/conflicting, N = no effect found. "read" = how we read it.
const STUDIES = [
 {t:'Do Cold Fronts Really Get Deer On Their Feet? (summary of Webb, Gee, Strickland, Demarais & DeYoung 2010, Int. J. Ecology)', a:'P. Annear, North American Whitetail, quoting MSU Deer Lab', y:2023, u:'https://www.northamericanwhitetail.com/editorial/fair-weather-bucks/467588', f:'temp, pressure, precip, fronts, moon, rut',
  x:'32 GPS-collared deer (15 bucks), Oklahoma: "minimal evidence that weather was having an influence"; temperature the only weather factor with a slight effect; pressure, precipitation and moon no notable effect; buck movement 20% greater in rut than post-rut. (Original paper not opened; summary article read.)', r:'full article (secondary source)'},
 {t:'Effects of Abiotic Factors on White-tailed Deer Activity in South Carolina (MS thesis)', a:'Goethlich, Auburn University', y:2020, u:'https://etd.auburn.edu/handle/10415/7077', f:'temp, wind, pressure, cloud/weather condition, moon',
  x:'GPS-collared adult deer. Weather condition, temperature, wind, pressure and moon affected activity in some seasons/times, but effects were smaller than the daily dawn/dusk cycle and showed up mostly outside peak (dawn/dusk) times.', r:'abstract'},
 {t:'Deer and Rain: Take 2', a:'Penn State Deer-Forest Study (K. Williams)', y:2015, u:'https://www.deer.psu.edu/deer-and-rain-take-2/', f:'precip, temp',
  x:'October 2014 replication: bucks moved ~0.5 mi/day when raining vs ~0.8 mi/day dry (roughly 35–40% less); does unaffected; same pattern as the 2013 season.', r:'full page'},
 {t:'Blown Away (wind and rain)', a:'Penn State Deer-Forest Study (J. Hepner)', y:2018, u:'https://www.deer.psu.edu/blown-away/', f:'wind, precip',
  x:'Oct 2015–16. Bucks moved more with gentle (1–15 mph) and strong (16–27 mph) wind in daytime; less on windy nights. Rain cut buck movement only with little/no wind; strong wind offset it. Does mostly unaffected.', r:'full page'},
 {t:'Wandering in the Moonlight', a:'Penn State Deer-Forest Study (J. Hepner)', y:2017, u:'https://www.deer.psu.edu/wandering-in-the-moonlight/', f:'moon',
  x:'Collared does, Oct 2015–16: moon phase effect not significant (≈4–6 m/hr difference vs movements of 0–2,748 m/hr). Movement peaks within 2 hr of sunrise/sunset (120–140 m/hr vs <50 m/hr midday).', r:'full page'},
 {t:'Lunar Legends: Does the Moon Influence Buck Activity? (P4068)', a:'Mississippi State Univ. Extension / MSU Deer Lab', y:'n.d.', u:'https://extension.msstate.edu/publications/lunar-legends-does-the-moon-influence-buck-activity', f:'moon, rut',
  x:'48 GPS-collared bucks, 2 yrs, 15-min fixes. Moon phase and position: no effect. Rut: bucks travel 100+ yd/hr more with ~10% less daylight bedding (1.25+ hr).', r:'full PDF'},
 {t:'Effects of Weather on Buck Movements (Deer University #407)', a:'MSU Deer Lab: Neary, Resop, Demarais, Strickland', y:2025, u:'https://nrupodcast.extension.msstate.edu/node/3979', f:'temp, wind, pressure, fronts',
  x:'Newer MSU analysis controlling for time of day and rut. Podcast only; we did not have the numbers, so not used for weights.', r:'episode page only'},
 {t:'Does Weather Impact Deer Movement? Here\u2019s What We Know', a:'National Deer Association (B. Grossman)', y:2024, u:'https://deerassociation.com/does-weather-impact-deer-movement/', f:'temp, wind, precip, fronts',
  x:'Review: PSU saw no change in movement through a big October cold front or a warm snap; Auburn saw drizzle slightly raise buck movement; weather matters least at dawn/dusk and less near the rut.', r:'full page'},
 {t:'Living in an Oven: Deer Movements during Summer in South Texas', a:'Wiemers, Caesar Kleberg Wildlife Research Inst.', y:2022, u:'https://www.ckwri.tamuk.edu/sites/default/files/publication/pdfs/2022/living_in_an_oven.pdf', f:'temp, wind',
  x:'8 GPS bucks, summer: activity fell when operative temp >82°F and nearly stopped >104°F; wind had no effect in summer.', r:'full PDF'},
 {t:'The Breeding Season and Movement Ecology of Male White-Tailed Deer in Southwest Wisconsin', a:'Hunsaker, Gilbertson, Storm (WI DNR), Turner (Ecology & Evolution)', y:2025, u:'https://europepmc.org/article/PMC/PMC12240682', f:'rut timing',
  x:'188 GPS-collared bucks, 2017–2020: peak breeding season (movement changepoint) Oct 23–Nov 12; firearm opener had no significant effect on movement.', r:'abstract'},
 {t:'Productivity of White-Tailed Deer in Central Wisconsin (thesis)', a:'Clark, UW–Stevens Point', y:1981, u:'http://digital.library.wisc.edu/1793/79636', f:'rut timing',
  x:'90 does, fetal aging: 67% bred Nov 8–Dec 5; adult peak Nov 15–21, yearlings Nov 22–28, doe fawns ~1 month later.', r:'abstract'},
 {t:'Hunting deer with a rifle, shotgun or muzzleloader', a:'Minnesota DNR', y:2026, u:'https://www.dnr.state.mn.us/gohunting/firearms-deer-hunting.html', f:'rut timing',
  x:'Minnesota whitetails mate from November to early December.', r:'full page'}];
const EVID = [ // factor, range in app, evidence, why
 ['Rain / drizzle / storm','× 0.35–0.70, capped 10–40','Moderate (bucks)','PSU collars, replicated 2 yrs: bucks ~35–40% less travel in rain; does unaffected. Auburn saw no drop in drizzle. Wind offsets it.'],
 ['Rut phase','+3 to +10','Strong','MSU (48 bucks), Webb (+20%), WI 188 bucks: rut timing beats any weather factor.'],
 ['Temperature (heat)','−20 to +8','Moderate','Most often significant weather factor (Webb); heat cuts activity (TX). Cool-is-better is consistent but small.'],
 ['Wind','−10 to +4','Weak / conflicting','PSU: bucks moved more with wind. Auburn: less post-rut. Only extremes penalized.'],
 ['Sky (cloud × temp)','−6 to +5','Weak','No collar study isolates cloud cover. Treated as heat load: clear + cold good, sunny + warm bad, overcast ≈ neutral.'],
 ['Fog','× 0.85, cap 55','Weak','Not studied directly; mild penalty for visibility, not deer behavior.'],
 ['Snow','light ×0.95 · heavy ×0.55','Weak','No collar data found; light snow left near neutral, heavy snow treated like steady rain.'],
 ['Pressure / fronts','0 to +3','Weak / not supported','Webb (via NAW), MSU, NDA/PSU front data: no consistent effect. Kept tiny.'],
 ['Temp change vs yesterday','−6 to +8','Weak','PSU found no change through a cold front or warm snap. Kept small.'],
 ['Moon','not used','No effect','Webb, MSU (48 bucks), PSU: moon phase/position had no measurable effect.']];
const howHTML = () => `<h2>How the score works</h2>
<p><b>Short version:</b> research says the calendar (rut) and dawn/dusk drive deer movement much more than weather. Of the weather factors, <b>rain</b> has the clearest effect on <b>bucks</b> (roughly 35–40% less travel in Penn State's collar data), then heat. Wind, clouds, pressure and fronts show weak or conflicting effects. So rain now pulls the score down hard, and the others nudge it.</p>
<ol><li><b>Dry score</b> = 50 + temperature + change vs yesterday + wind/gusts + sky + pressure + rut. Non-rain weather terms are damped 25% in the dawn/dusk windows, because Auburn found weather matters least then.</li>
<li><b>Wet weather multiplies, then caps.</b> If rain, drizzle, storms, fog or snow is likely, the hour becomes a blend: (1 − chance) × dry + chance × wet, where wet = min(dry × multiplier, cap). When it's actually raining (station, weather code, nowcast, or your <b>Raining here</b> tap), chance = 100%. The rut bonus is added <i>before</i> the cap, so it can't rescue a rainy hour.</li>
<li><b>Day score</b> = 75% dawn/dusk prime windows + 25% midday. High rain chance in the prime windows drags the day down, and the reason line says so.</li></ol>
<table class="wt"><tr><th>Wet type</th><th>×</th><th>Cap</th></tr>${Object.values(CFG.WET).map(([m,c,l])=>`<tr><td>${l}</td><td>${m}</td><td>${c}</td></tr>`).join('')}</table>
<p class="small">Light rain or drizzle with wind ≥ ${CFG.WINDY_RAIN_MPH} mph gets +${CFG.WINDY_RAIN_RELIEF[0]} on the multiplier and +${CFG.WINDY_RAIN_RELIEF[1]} on the cap (Penn State: wind offset the rain effect). The caps are stricter than the studies alone would set, by design, because rain also makes hunting and visibility worse.</p>
<h3>Weight vs. evidence</h3>
<table class="wt"><tr><th>Factor</th><th>Range</th><th>Evidence</th></tr>${EVID.map(e=>`<tr><td><b>${e[0]}</b><br><small>${e[3]}</small></td><td>${e[1]}</td><td>${e[2]}</td></tr>`).join('')}</table>
<p><b>Overcast, honestly:</b> no study we found measured cloud cover by itself. Overcast with no rain is not treated as bad; it's near neutral when cool. A dark, rainy day scores low because of the rain, not the clouds.</p>
<p><b>Right now:</b> nearest NWS station observation, Open-Meteo current and its 15-minute nowcast (used for "rain in ~X min"), and the NWS hourly forecast. Refreshed every ${CFG.NOW_CACHE_MIN} min. Use the <b>Auto / Dry / Light / Steady / Heavy</b> switch if the data is wrong where you are: it overrides this hour + 2 and expires after 2 hr; Dry forces a dry reading even if the forecast or station says wet.</p>
<p><b>Rut calendar</b> (northern MN/WI): ${CFG.RUT.filter(r=>r[5]).map(r=>`${r[4]} ${r[0]}/${r[1]}–${r[2]}/${r[3]} +${r[5]}`).join(' · ')}. Based on WI collar data (peak movement Oct 23–Nov 12), WI fetal data (adult conception Nov 15–21) and MN DNR (mating Nov–early Dec).</p>
<p>Open any day for its <b>factor breakdown</b> (points each factor added or removed in the prime windows).</p>
<p><button class="btn ghost" id="toStudies">📚 Studies cited (${STUDIES.length})</button></p>
<h3>Legal shooting hours (deer)</h3>
<p><b>Minnesota:</b> ${LEGAL.MN.rule} (<a href="${LEGAL.MN.src}" target="_blank" rel="noopener">${LEGAL.MN.srcName}</a>). <b>Wisconsin:</b> ${LEGAL.WI.rule}, same for gun, archery and muzzleloader deer (<a href="${LEGAL.WI.src}" target="_blank" rel="noopener">${LEGAL.WI.srcName}</a>). ${LEGAL.WI.note} Other states: sunrise/sunset only. Uses Open-Meteo sunrise/sunset for each location. <b>Always confirm current regulations.</b></p>
<h3>What the numbers mean</h3>
<p>The model's raw points rarely leave about 10–85, so the shown score is <b>calibrated</b>: a fixed, one-way stretch (raw 10 → 6, 35 → 30, 50 → 50, 65 → 72, 80 → 92) so the realistic worst lands near 5 and the realistic best near 95. It never changes which hour or day ranks higher. Charts zoom to the day's range; the faint bands show the rating.</p>
<table class="wt"><tr><th>Score</th><th>Rating</th><th>Typical conditions</th></tr>
<tr><td style="color:${CFG.BANDS[4][3]}">80+</td><td>Prime</td><td>Rut, cold clear or cooling dawn/dusk, light–moderate wind, dry</td></tr>
<tr><td style="color:${CFG.BANDS[3][3]}">65–79</td><td>Great</td><td>Rut or cool dry weather, overcast fine</td></tr>
<tr><td style="color:${CFG.BANDS[2][3]}">50–64</td><td>Good</td><td>Average fall day, mild temps, or rut with a downside</td></tr>
<tr><td style="color:${CFG.BANDS[1][3]}">35–49</td><td>Fair</td><td>Warm, rain likely, or light rain with wind</td></tr>
<tr><td style="color:${CFG.BANDS[0][3]}">under 35</td><td>Poor</td><td>Raining, storms, heat, or very high wind</td></tr></table>
<p class="small">Rain caps above are in raw points; shown as calibrated they're about: ${Object.values(CFG.WET).map(([m,c,l])=>`${l} ${Math.round(cal(c))}`).join(' · ')}. Factor breakdown is in raw model points. This is an estimate, not a validated model.</p><p class="ver">Version ${VERSION}</p>`;
const studiesHTML = () => `<h2>Studies cited</h2><p>Sources behind the weights. "Read" says how much of each we actually read. Weak or conflicting evidence is flagged in <a href="#" id="toHow">How the score works</a>.</p>
${STUDIES.map(s=>`<div class="study"><b><a href="${s.u}" target="_blank" rel="noopener">${esc(s.t)}</a></b><br><small>${esc(s.a)} · ${s.y} · informs: <b>${s.f}</b></small><div>${esc(s.x)}</div><small class="mut">Read: ${s.r}</small></div>`).join('')}
<p class="small">Not used: solunar / moon tables, "deer movement index" apps (no published validation found).</p><p class="ver">Version ${VERSION}</p>`;
function openSheet(which){ $('#howBody').innerHTML = which==='studies' ? studiesHTML() : howHTML(); $('#sheet').hidden = false; $('#sheet .sheetin').scrollTop = 0;
  const a = $('#toStudies'), b = $('#toHow'); if (a) a.onclick = () => openSheet('studies'); if (b) b.onclick = e => { e.preventDefault(); openSheet('how'); }; }
$('#howBtn').onclick = () => openSheet('how');
$('#studiesBtn').onclick = () => openSheet('studies');
$('#closeHow').onclick = $('#sheet').onclick = e => { if (e.target.id==='sheet'||e.currentTarget.id==='closeHow') $('#sheet').hidden = true; };
$('#back').onclick = () => home();
window.addEventListener('hashchange', () => { if (!location.hash && !$('#back').hidden) home(); });
if ('serviceWorker' in navigator) {
  const had = !!navigator.serviceWorker.controller; let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (had && !reloaded) { reloaded = true; location.reload(); } });
  navigator.serviceWorker.register('sw.js', {updateViaCache:'none'}).then(r => { r.update(); document.addEventListener('visibilitychange', () => { if (!document.hidden) r.update(); }); }).catch(()=>{});
}
setRut(); home();
