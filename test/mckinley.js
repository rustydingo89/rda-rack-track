const {load}=require('./harness');const fs=require('fs');
(async()=>{
 const src=fs.readFileSync(__dirname+'/../app.js','utf8');const HV=src.match(/const HV\s*=\s*'([^']+)'/)[1],MV=src.match(/const MV\s*=\s*'([^']+)'/)[1];
 const u=`https://api.open-meteo.com/v1/forecast?latitude=47.51&longitude=-92.41&hourly=${HV}&minutely_15=${MV}&daily=sunrise,sunset&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&timezone=auto&past_days=1&forecast_days=7`;
 const d=await (await fetch(u)).json();
 const v4=load('/tmp/app_v4.js').model(d,null,null),v5=load(__dirname+'/../app.js').model(d,null,null);
 const cur=new Date().toLocaleString('sv',{timeZone:'America/Chicago'}).slice(0,13).replace(' ','T')+':00';
 const h4=v4.hours.find(h=>h.time===cur),h5=v5.hours.find(h=>h.time===cur);
 console.log(`Now ${cur}: ${h5.t.toFixed(0)}°F wind ${h5.w.toFixed(0)} cc ${h5.cc}% pp ${h5.pp}% pr ${h5.pr} code ${h5.code} | v4 ${h4.s} -> v5 ${h5.s}`);
 console.log('| Day | v4 | v5 | prime rain chance | v5 reason |\n|---|---|---|---|---|');
 v5.days.forEach((x,i)=>console.log(`| ${x.date} | ${v4.days[i].score} | **${x.score}** | ${Math.max(0,...x.hs.filter(h=>h.prime).map(h=>h.pp))}% | ${x.reason.replace(/<[^>]+>/g,'')} |`));
})();
