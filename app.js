'use strict';
const VERSION = 'rt-v4';
/* RDA Rack Track: whitetail movement favorability estimate. All tunables up here. */
const CFG = {
  BASE: 50,
  TEMP_ABS: [[-40,4],[25,6],[40,10],[50,3],[60,-6],[70,-12],[200,-18]], // [upper bound °F, points]
  TEMP_DROP_PER_F: 1.0, TEMP_DROP_MAX: 14, TEMP_RISE_MAX: -10,          // vs same hour previous day
  WIND: [[3,-2],[5,3],[15,8],[20,0],[25,-8],[999,-15]],                 // [upper mph, points]
  GUST_PENALTY_OVER: 35, GUST_PENALTY: -5,
  CLOUD: [[30,6],[70,3],[85,0],[101,-2]],                                // [upper %, points]
  PRECIP: [[0.004,0],[0.03,-3],[0.1,-7],[0.25,-11],[999,-15]],           // [upper in/hr effective, points]
  NOW_CACHE_MIN: 5, OBS_MAX_AGE_MIN: 90,
  PRESS_FALL_3H: -1.5, PRESS_FALL_PTS: 7,                                // hPa / 3h falling ahead of front
  POST_FRONT_FALL_12H: -3, POST_FRONT_RISE_3H: 1, POST_FRONT_PTS: 10,     // rising right after a front
  PRESS_HIGH: 1022, PRESS_HIGH_PTS: 2,
  RUT: [ // northern MN/WI calendar approximation [startMonth, startDay, endMonth, endDay, name, bonus, blurb]
    [1,1,10,19,'Early season',0,'Bed-to-feed patterns rule. Hunt food sources at last light.'],
    [10,20,10,31,'Pre-rut',5,'Scrapes and rubs are opening up and bucks are cruising more in daylight.'],
    [11,1,11,7,'Seeking',10,'Bucks are on their feet checking does. All-day sits pay off.'],
    [11,8,11,18,'Peak breeding',8,'Bucks are locked down with does but still move a lot. Cover funnels and doe bedding.'],
    [11,19,11,30,'Post-rut',3,'Tired bucks go back to food. Late lockdown tail.'],
    [12,1,12,4,'Late season',0,'Food is king. Cold snaps push daylight feeding.'],
    [12,5,12,20,'Second rut',4,'Unbred does and fawns come into heat. A small secondary bump.'],
    [12,21,12,31,'Late season',0,'Food is king. Cold snaps push daylight feeding.']],
  PRIME_DAWN: [-60, 120], PRIME_DUSK: [-150, 30],                        // minutes around sunrise / sunset
  DAY_WEIGHTS: {prime: 0.75, midday: 0.25},
  RAIN_REPORT: {light:[0.05,'Light'], steady:[0.15,'Steady'], heavy:[0.3,'Heavy']}, RAIN_REPORT_MIN: 120,
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
const color = s => s>=75?'#3ecf8e':s>=60?'#a6d94a':s>=45?'#f2b84b':s>=30?'#e8792b':'#ff5d5d';
const label = s => s>=75?'Excellent':s>=60?'Good':s>=45?'Fair':s>=30?'Poor':'Tough';
// local-time strings ("2026-10-31T14:00") -> minutes on a fake UTC clock; avoids timezone bugs
const tm = s => { const [d,t='00:00'] = s.split('T'), [y,m,dd] = d.split('-').map(Number), [h,mi] = t.split(':').map(Number); return Date.UTC(y,m-1,dd,h,mi)/6e4; };
const fmtClock = iso => new Date(iso).toLocaleTimeString([], {hour:'numeric', minute:'2-digit'});
const fmtT = m => { const d = new Date(m*6e4); let h = d.getUTCHours(), mi = d.getUTCMinutes(); const ap = h<12?'a':'p'; h = h%12||12; return h+(mi?':'+String(mi).padStart(2,'0'):'')+ap; };

function rutFor(dateStr){ const [,m,d] = dateStr.split('-').map(Number), k = m*100+d;
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
    const g = r.results && r.results[0]; return g && {name:(isZip?q+' · ':'')+g.name+(g.admin1?', '+g.admin1:''), lat:g.latitude, lon:g.longitude}; };
  const nm = async () => { const r = await (await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&addressdetails=1&q='+encodeURIComponent(q))).json();
    const g = r[0]; if (!g) return null; const a = g.address||{};
    return {name:(isZip?q+' · ':'')+(a.city||a.town||a.village||a.hamlet||a.county||g.display_name.split(',')[0])+(a.state?', '+a.state:''), lat:+g.lat, lon:+g.lon}; };
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
  return {t, w, wd, rate, wet: rate>0.004, sky, cc:om.cloud_cover, next2, pp2, omTime:om.time, ob, h0,
    src: (ob?`NWS ${ob.id} obs `:'')+(om.time?'Open-Meteo now':'')};
}

/* ---------- model ---------- */
function model(d, nr, rep){
  const H = d.hourly, n = H.time.length, T = H.time.map(tm), hours = [];
  const curH = nr && nr.omTime ? nr.omTime.slice(0,13)+':00' : null;
  const nowM = Math.floor((Date.now()/6e4 + (d.utc_offset_seconds||0)/60)/60)*60;
  const repEnd = rep ? Math.floor(((rep.exp)/6e4 + (d.utc_offset_seconds||0)/60)/60)*60 : 0, repStart = rep ? Math.floor((rep.at/6e4 + (d.utc_offset_seconds||0)/60)/60)*60 : 0;
  for (let i=0;i<n;i++){
    const p = H.pressure_msl, f = {}, live = curH && H.time[i]===curH;
    let t = H.temperature_2m[i], w = H.wind_speed_10m[i], wd = H.wind_direction_10m[i], pr = effPr(H.precipitation[i], H.weather_code&&H.weather_code[i], H.precipitation_probability[i]), pp = H.precipitation_probability[i];
    if (live) { if (nr.t!=null) t = nr.t; if (nr.w!=null) w = nr.w; if (nr.wd!=null) wd = nr.wd; pr = Math.max(pr, nr.rate); pp = Math.max(pp||0, nr.pp2||0, nr.wet?100:0); }
    const rp = rep && T[i] >= Math.min(repStart,nowM) && T[i] <= repEnd; if (rp) { pr = Math.max(pr, CFG.RAIN_REPORT[rep.lvl][0]); pp = 100; }
    const t24 = i>=24 ? H.temperature_2m[i-24] : null;
    f.temp = band(t, CFG.TEMP_ABS);
    f.change = t24==null ? 0 : clamp(-(t-t24)*CFG.TEMP_DROP_PER_F, CFG.TEMP_RISE_MAX, CFG.TEMP_DROP_MAX);
    f.wind = band(w, CFG.WIND) + (H.wind_gusts_10m[i] > CFG.GUST_PENALTY_OVER ? CFG.GUST_PENALTY : 0);
    f.cloud = band(H.cloud_cover[i], CFG.CLOUD);
    f.precip = band(pr, CFG.PRECIP);
    const d3 = i>=3 ? p[i]-p[i-3] : 0, d12 = i>=15 ? p[i-3]-p[i-15] : 0;
    f.press = d3 <= CFG.PRESS_FALL_3H ? CFG.PRESS_FALL_PTS
            : (d3 >= CFG.POST_FRONT_RISE_3H && d12 <= CFG.POST_FRONT_FALL_12H) ? CFG.POST_FRONT_PTS
            : p[i] >= CFG.PRESS_HIGH ? CFG.PRESS_HIGH_PTS : 0;
    f.rut = rutFor(H.time[i]).bonus;
    const s = clamp(Math.round(CFG.BASE + Object.values(f).reduce((a,b)=>a+b,0)), 0, 100);
    hours.push({i, m:T[i], time:H.time[i], s, f, t, w, g:H.wind_gusts_10m[i], wd, cc:H.cloud_cover[i], pr, pp:pp||0, p:p[i], dp:d3, live, rp});
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
    for (const key of ['temp','change','wind','cloud','precip','press']) fs[key] = src.reduce((a,h)=>a+h.f[key],0)/(src.length||1);
    return {date, k, sr, ss, hs, rp: hs.some(h=>h.rp), score, fs, reason: reason(fs, hs, src), rut: rutFor(date)};
  });
  return {hours, days: days.slice(1)}; // drop the past day (only used for day-over-day change)
}
function reason(fs, hs, src){
  const tx = [];
  const tAvg = src.reduce((a,h)=>a+h.t,0)/(src.length||1), wAvg = src.reduce((a,h)=>a+h.w,0)/(src.length||1);
  const dir = compass(src.reduce((a,h)=>a+h.wd,0)/(src.length||1));
  const ranked = Object.entries(fs).sort((a,b)=>Math.abs(b[1])-Math.abs(a[1]));
  const say = {temp:v=> v>0?`cool ${Math.round(tAvg)}°F`:`warm ${Math.round(tAvg)}°F`,
    change:v=> v>0?'temps dropping vs yesterday':'warmer than yesterday',
    wind:v=> v>0?`${wAvg<5?"light":"good"} ${Math.round(wAvg)} mph ${dir} wind`:`${Math.round(wAvg)} mph ${dir} wind`,
    cloud:v=> v>0?'mostly clear':'overcast', precip:v=>'rain/snow in the windows', press:v=>'front moving through (pressure shift)'};
  for (const [k,v] of ranked){ if (Math.abs(v) < 2.5) continue; tx.push((v>0?'+ ':'− ')+say[k](v)); if (tx.length===2) break; }
  return tx.length ? tx.join(' · ') : 'Average conditions';
}
// 15-minute series when Open-Meteo has minutely_15 (US); cloud/pressure interpolated from hourly
function fine(d, mdl, day){
  const M = d.minutely_15; if (!M || !M.time) return null;
  const out = [], hs = mdl.hours;
  for (let j=0;j<M.time.length;j++){
    if (!M.time[j].startsWith(day.date) || M.temperature_2m[j]==null) continue;
    const m = tm(M.time[j]), hi = hs.findIndex(h => h.m > m) - 1; if (hi < 0) continue;
    const h = hs[hi], f = {...h.f};
    f.temp = band(M.temperature_2m[j], CFG.TEMP_ABS);
    f.wind = band(M.wind_speed_10m[j], CFG.WIND) + (M.wind_gusts_10m[j] > CFG.GUST_PENALTY_OVER ? CFG.GUST_PENALTY : 0);
    const pr15 = Math.max(effPr((M.precipitation[j]||0)*4, M.weather_code&&M.weather_code[j], h.pp), (h.live||h.rp)?h.pr:0);
    f.precip = band(pr15, CFG.PRECIP);
    out.push({m, s: clamp(Math.round(CFG.BASE + Object.values(f).reduce((a,b)=>a+b,0)),0,100), t:M.temperature_2m[j], w:M.wind_speed_10m[j], g:M.wind_gusts_10m[j], wd:M.wind_direction_10m[j], pr:pr15, cc:h.cc, p:h.p, dp:h.dp, pp:h.pp});
  }
  return out.length > 40 ? out : null;
}

/* ---------- SVG charts ---------- */
function chart(pts, key, opt){
  const W = 360, H = opt.h||110, L = 30, R = 6, Tp = 8, B = 18, x0 = pts[0].m, x1 = pts[pts.length-1].m;
  const vals = pts.map(p=>p[key]); let lo = opt.min ?? Math.min(...vals), hi = opt.max ?? Math.max(...vals);
  if (hi-lo < (opt.span||1)) { const c=(hi+lo)/2; lo=c-(opt.span||1)/2; hi=c+(opt.span||1)/2; }
  const X = m => L + (m-x0)/(x1-x0||1)*(W-L-R), Y = v => Tp + (1-(v-lo)/(hi-lo||1))*(H-Tp-B);
  let g = '';
  const {sr, ss} = opt.day;
  g += `<rect x="${L}" y="${Tp}" width="${Math.max(0,X(sr)-L)}" height="${H-Tp-B}" fill="#000" opacity=".35"/><rect x="${X(ss)}" y="${Tp}" width="${Math.max(0,W-R-X(ss))}" height="${H-Tp-B}" fill="#000" opacity=".35"/>`;
  for (const [a,b] of [[sr+CFG.PRIME_DAWN[0], sr+CFG.PRIME_DAWN[1]], [ss+CFG.PRIME_DUSK[0], ss+CFG.PRIME_DUSK[1]]])
    g += `<rect x="${X(a)}" y="${Tp}" width="${X(b)-X(a)}" height="${H-Tp-B}" fill="#e8792b" opacity=".13"/>`;
  for (let k=0;k<=2;k++){ const v = lo+(hi-lo)*k/2; g += `<line x1="${L}" x2="${W-R}" y1="${Y(v)}" y2="${Y(v)}" stroke="#252c36"/><text x="${L-4}" y="${Y(v)+3}" fill="#8a94a3" font-size="9" text-anchor="end">${opt.fmt?opt.fmt(v):Math.round(v)}</text>`; }
  for (let h=0;h<=24;h+=6){ const m = x0 - (x0%1440) + h*60; if (m<x0||m>x1+1) continue; g += `<text x="${X(m)}" y="${H-5}" fill="#8a94a3" font-size="9" text-anchor="middle">${h===0?'12a':h===12?'12p':h<12?h+'a':(h-12)+'p'}</text>`; }
  if (opt.bars){ const bw = Math.max(1,(W-L-R)/pts.length-1); pts.forEach(p=>{ if(p[key]>0) g += `<rect x="${X(p.m)-bw/2}" y="${Y(p[key])}" width="${bw}" height="${Y(lo)-Y(p[key])}" fill="${opt.color}"/>`; }); }
  else {
    const d = pts.map((p,i)=>(i?'L':'M')+X(p.m).toFixed(1)+' '+Y(p[key]).toFixed(1)).join('');
    if (opt.grad){ g += `<defs><linearGradient id="sg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3ecf8e"/><stop offset=".5" stop-color="#f2b84b"/><stop offset="1" stop-color="#ff5d5d"/></linearGradient></defs>`;
      g += `<path d="${d}L${X(x1)} ${Y(lo)}L${X(x0)} ${Y(lo)}Z" fill="url(#sg)" opacity=".18"/><path d="${d}" fill="none" stroke="url(#sg)" stroke-width="2.4" stroke-linejoin="round"/>`; }
    else g += `<path d="${d}" fill="none" stroke="${opt.color}" stroke-width="2" stroke-linejoin="round"/>`;
    if (opt.key2) g += `<path d="${pts.map((p,i)=>(i?'L':'M')+X(p.m).toFixed(1)+' '+Y(p[opt.key2]).toFixed(1)).join('')}" fill="none" stroke="${opt.color}" stroke-width="1" stroke-dasharray="3 3" opacity=".7"/>`;
  }
  if (opt.dirs){ const per = pts.length > 30 ? Math.round(pts.length/8) : 3; for (let i=Math.floor(per/2);i<pts.length;i+=per){ const p = pts[i]; g += `<text x="${X(p.m)}" y="${Tp+9}" fill="#e6e9ee" font-size="9" font-weight="600" text-anchor="middle" opacity=".85">${compass16(p.wd)}</text>`; } }
  g += `<line class="cur" x1="0" x2="0" y1="${Tp}" y2="${H-B}" stroke="#ff9a52" stroke-width="1" opacity="0"/>`;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" data-x0="${x0}" data-x1="${x1}" data-l="${L}" data-r="${R}" data-w="${W}">${g}</svg>`;
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
  <div class="note">An estimate from weather and calendar patterns, not a guarantee. Weather: Open-Meteo, NWS. Built by Rusty Dingo Arms. <span class="ver">${VERSION}</span></div>`;
  $('#addF').onsubmit = async e => { e.preventDefault(); const q = $('#q').value; if (!q.trim()) return; $('#msg').textContent = 'Finding…';
    const g = await geocode(q); if (!g) { $('#msg').textContent = 'Could not find that location. Try a 5-digit zip or "City, ST".'; return; }
    setLocs([...getLocs(), g]); home(); };
  $('#geo').onclick = () => { if (!navigator.geolocation) { $('#msg').textContent = 'Location not available.'; return; } $('#msg').textContent = 'Getting location…';
    navigator.geolocation.getCurrentPosition(async p => { const lat = +p.coords.latitude.toFixed(4), lon = +p.coords.longitude.toFixed(4); let name = 'My location';
      try { const r = await (await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&zoom=10&lat=${lat}&lon=${lon}`)).json(); const a = r.address||{}; name = '📍 '+(a.city||a.town||a.village||a.county||'My location')+(a.state?', '+a.state:''); } catch {}
      setLocs([...getLocs(), {name, lat, lon}]); home(); }, () => { $('#msg').textContent = 'Location permission denied.'; }, {timeout:15000}); };
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
    const [c, nc] = await Promise.all([weather(l), nowcast(l).catch(()=>null)]), nr = nc ? nowRead(nc) : null, rep = getRain(l), mdl = model(c.d, nr, rep); state.data[idx] = c.d; state.models[idx] = mdl;
    const lh = mdl.hours.find(h=>h.live);
    const strip = nr ? `<div class="now"><div class="nowt"><b>Right now</b>${lh?` <span class="sc sm" style="background:${color(lh.s)}">${lh.s}</span>`:''}</div><div class="nowv">${nr.t!=null?Math.round(nr.t)+'°F':''} · ${nr.w!=null?Math.round(nr.w)+' mph '+(nr.wd!=null?compass16(nr.wd):''):''} · ${esc(nr.sky)} · <b style="color:${nr.wet||rep?'#5aa9ff':'inherit'}">${rep?'Rain (you)':nr.wet?'Wet '+nr.rate.toFixed(2)+'"/hr':'Dry'}</b>${lh?` (${lh.f.precip} pts)`:''}</div><small>Next 2 hr: ${nr.next2>0.004?'rain '+nr.next2.toFixed(2)+'"/hr':'no rain modeled'}${nr.h0?' · NWS '+nr.pp2+'% · '+esc(nr.h0.txt):''}<br>📍 ${esc(l.name)} · ${nr.ob?`NWS ${nr.ob.id}${nr.ob.mi!=null?' ('+Math.round(nr.ob.mi)+' mi away)':''} obs ${fmtClock(nr.ob.ts)}`:'No nearby NWS obs'}${nr.omTime?` · Open-Meteo ${fmtT(tm(nr.omTime))}`:''}${nc.stale?' · offline':''}</small>${rainUI(rep)}</div>` : rainUI(rep);
    el.innerHTML = head + strip + (c.stale?'<div class="msg">Offline: showing last saved forecast.</div>':'') + '<div class="days">' + mdl.days.map((d,k) => { const dt = new Date(Date.UTC(...d.date.split('-').map((v,i)=>i==1?v-1:+v)));
      return `<button class="day" data-k="${k}"><div class="dn"><b>${k===0?'Today':DOW[dt.getUTCDay()]}</b><small>${dt.getUTCMonth()+1}/${dt.getUTCDate()}</small></div><div class="sc" style="background:${color(d.score)}">${d.score}</div><div class="why"><b>${label(d.score)}</b> · ${d.rut.name}<br>${esc(d.reason)}</div></button>`; }).join('') + '</div>';
    bind(); el.querySelectorAll('[data-rain]').forEach(b => b.onclick = () => { setRain(l, b.dataset.rain); delete state.data[idx]; renderCard(l, idx, n, el); });
    el.querySelectorAll('.day').forEach(b => b.onclick = () => detail(idx, +b.dataset.k));
  } catch (e) { el.innerHTML = head + `<div class="msg">Forecast unavailable (${esc(e.message)}). Check your connection.</div>`; bind(); }
}
function rainUI(rep){
  const lv = Object.entries(CFG.RAIN_REPORT);
  if (rep) return `<div class="rain on">🌧 <b>You reported ${CFG.RAIN_REPORT[rep.lvl][1].toLowerCase()} rain at ${fmtClock(rep.at)}</b> <small>(applies through ${fmtClock(rep.exp)})</small><div class="rbtns">${lv.map(([k,v])=>`<button class="rb ${k===rep.lvl?'on':''}" data-rain="${k}">${v[1]}</button>`).join('')}<button class="rb clr" data-rain="">☀ Not raining</button></div></div>`;
  return `<div class="rain"><span>Raining where you are?</span><div class="rbtns"><button class="rb main" data-rain="light">🌧 Raining here</button>${lv.slice(1).map(([k,v])=>`<button class="rb" data-rain="${k}">${v[1]}</button>`).join('')}</div></div>`;
}
function detail(idx, k){
  const l = getLocs()[idx], d = state.data[idx], mdl = state.models[idx], day = mdl.days[k]; if (!day) return home();
  location.hash = 'd'; $('#back').hidden = false; window.scrollTo(0,0);
  const f15 = fine(d, mdl, day); let res = f15 ? '15' : '60';
  const draw = () => {
    const pts = res==='15' && f15 ? f15 : day.hs, dt = new Date(Date.UTC(...day.date.split('-').map((v,i)=>i==1?v-1:+v)));
    const best = [...day.hs].filter(h=>h.m>=day.sr-60&&h.m<=day.ss+30).sort((a,b)=>b.s-a.s)[0] || day.hs[0];
    const fsRow = Object.entries(day.fs).map(([kk,v])=>`<div class="fact"><small>${{temp:'Temperature',change:'Change vs yesterday',wind:'Wind',cloud:'Cloud cover',precip:'Precipitation',press:'Pressure / fronts'}[kk]}</small><b style="color:${v>0.5?'#3ecf8e':v<-0.5?'#ff5d5d':'#e6e9ee'}">${v>0?'+':''}${v.toFixed(1)} pts</b></div>`).join('');
    view.innerHTML = `<div class="card"><div class="ch"><h3>${esc(l.name)} · ${DOW[dt.getUTCDay()]} ${dt.getUTCMonth()+1}/${dt.getUTCDate()}</h3><div class="sc" style="background:${color(day.score)}">${day.score}</div></div>
      <div class="why"><b>${label(day.score)}</b> · ${esc(day.reason)}</div>
      <div class="facts" style="margin-top:10px"><div class="fact"><small>Sunrise / Sunset</small><b>${fmtT(day.sr)} / ${fmtT(day.ss)}</b></div><div class="fact"><small>Best hour (daylight)</small><b>${fmtT(best.m)} · ${best.s}</b></div><div class="fact"><small>Rut phase</small><b>${day.rut.name}${day.rut.bonus?' +'+day.rut.bonus:''}</b></div><div class="fact"><small>Prevailing wind (daylight)</small><b>${prevail(day.hs.filter(h=>h.m>=day.sr&&h.m<=day.ss))} · ${Math.round(Math.max(...day.hs.map(h=>h.w)))} mph max</b></div><div class="fact"><small>Temp range</small><b>${Math.round(Math.min(...day.hs.map(h=>h.t)))}–${Math.round(Math.max(...day.hs.map(h=>h.t)))}°F</b></div></div></div>
      <div class="card"><div class="tabs">${f15?`<button class="tab ${res==='15'?'on':''}" data-r="15">15-min</button>`:''}<button class="tab ${res==='60'?'on':''}" data-r="60">Hourly</button></div>
      <div class="tip" id="tip">Tap or drag a chart. Orange bands are the dawn/dusk prime windows; dark is night.</div>
      <div class="ct"><span>Favorability</span><span>0–100</span></div>${chart(pts,'s',{day,min:0,max:100,grad:1,h:130})}
      <div class="ct"><span>Temperature °F</span><span>${Math.round(pts[0].t)}° to ${Math.round(pts[pts.length-1].t)}°</span></div>${chart(pts,'t',{day,color:'#ff9a52',span:6})}
      <div class="ct"><span>Wind mph (dashed = gusts), letters = direction wind is FROM</span></div>${chart(pts,'w',{day,color:'#5aa9ff',key2:'g',min:0,dirs:1,span:10})}
      <div class="ct"><span>Cloud cover %</span></div>${chart(pts,'cc',{day,color:'#8a94a3',min:0,max:100})}
      <div class="ct"><span>Precipitation in/${res==='15'?'15 min':'hr'}</span><span>max chance ${Math.max(...day.hs.map(h=>h.pp||0))}%</span></div>${chart(pts,'pr',{day,color:'#5aa9ff',min:0,bars:1,span:0.05,fmt:v=>v.toFixed(2)})}
      <div class="ct"><span>Rain chance %</span><span>Open-Meteo hourly</span></div>${chart(pts,'pp',{day,color:'#5aa9ff',min:0,max:100})}
      <div class="ct"><span>Pressure hPa (trend)</span><span>${(day.hs[day.hs.length-1].p-day.hs[0].p>0?'▲ ':'▼ ')+Math.abs(day.hs[day.hs.length-1].p-day.hs[0].p).toFixed(1)} today</span></div>${chart(pts,'p',{day,color:'#3ecf8e',span:4})}</div>
      <div class="card"><b>Factor breakdown (prime windows)</b><div class="facts" style="margin-top:8px">${fsRow}</div>${day.rp?`<div class="msg" style="color:#5aa9ff">Precipitation includes your "raining here" report (${CFG.RAIN_REPORT[getRain(l).lvl][1].toLowerCase()} rain, ${fmtClock(getRain(l).at)}) for the current and next 2 hours.</div>`:''}</div>
      <div class="note">Estimate only. Check regulations for legal shooting hours.</div>`;
    view.querySelectorAll('.tab').forEach(b => b.onclick = () => { res = b.dataset.r; draw(); });
    bindCharts(pts, $('#tip'));
  };
  draw();
}

/* ---------- how sheet ---------- */
$('#howBody').innerHTML = `<h2>How the score works</h2><p>Each hour starts at <b>50</b> and gains or loses points from weather and the calendar. The daily score blends the <b>dawn and dusk prime windows (75%)</b> with midday (25%). It is an <b>estimate</b> drawn from published whitetail movement patterns. Deer don't read forecasts, so treat it as a guide to pick your best sits.</p>
<ul><li><b>Temperature:</b> cooler is better for daylight movement (best about 25–40°F). Warm days above 60°F hurt.</li>
<li><b>Change vs yesterday:</b> a drop from the same hour yesterday adds up to +${CFG.TEMP_DROP_MAX}. A warm-up subtracts.</li>
<li><b>Wind:</b> 5–15 mph is best (+8). 20+ mph is poor, and gusts over ${CFG.GUST_PENALTY_OVER} mph cost more. Letters on the wind chart show where the wind is coming from, for setting your stand.</li>
<li><b>Clouds:</b> clear to partly cloudy is best for daylight movement. Heavy overcast is slightly negative.</li>
<li><b>Precipitation:</b> light drizzle costs a little, steady rain more, and heavy rain or snow is bad, especially for mature bucks. The app uses the larger of the forecast amount, what the weather code implies (drizzle, rain, showers, snow, storms) and a high rain chance, so a rainy hour never scores as dry.</li>
<li><b>Right now:</b> each card blends the nearest NWS station observation (US), Open-Meteo's current reading and 15-minute nowcast, and the NWS hourly forecast. The current hour's score uses observed temperature, wind and rain. Refreshed every ${CFG.NOW_CACHE_MIN} minutes.</li>
<li><b>Raining here:</b> if it's raining on you but the data says dry, tap <b>Raining here</b> on the card (Light, Steady or Heavy). It counts as rain for this hour and the next 2 hours, then expires. Tap <b>Not raining</b> to clear.</li>
<li><b>Pressure and fronts:</b> falling pressure ahead of a front (+${CFG.PRESS_FALL_PTS}) and rising pressure right after one passes (+${CFG.POST_FRONT_PTS}) trigger feeding. Steady high pressure is about average.</li>
<li><b>Rut phase</b> (northern MN/WI calendar): pre-rut Oct 20–31 +5, seeking Nov 1–7 +10, peak breeding Nov 8–18 +8, post-rut Nov 19–30 +3, second rut about Dec 5–20 +4.</li></ul>
<p>Colors: <span style="color:#3ecf8e">75+ excellent</span> · <span style="color:#a6d94a">60 good</span> · <span style="color:#f2b84b">45 fair</span> · <span style="color:#e8792b">30 poor</span> · <span style="color:#ff5d5d">under 30 tough</span>. 15-minute charts use Open-Meteo's 15-minute data where it's available (most of the US). Cloud cover and pressure come from the hourly data. Forecasts are cached for ${CFG.CACHE_MIN} minutes and stay available offline.</p><p class="ver">Version ${VERSION}</p>`;
$('#howBtn').onclick = () => $('#sheet').hidden = false;
$('#closeHow').onclick = $('#sheet').onclick = e => { if (e.target.id==='sheet'||e.currentTarget.id==='closeHow') $('#sheet').hidden = true; };
$('#back').onclick = () => home();
window.addEventListener('hashchange', () => { if (!location.hash && !$('#back').hidden) home(); });
if ('serviceWorker' in navigator) {
  const had = !!navigator.serviceWorker.controller; let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (had && !reloaded) { reloaded = true; location.reload(); } });
  navigator.serviceWorker.register('sw.js', {updateViaCache:'none'}).then(r => { r.update(); document.addEventListener('visibilitychange', () => { if (!document.hidden) r.update(); }); }).catch(()=>{});
}
setRut(); home();
