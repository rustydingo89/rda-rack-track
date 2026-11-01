// node test/harness.js  — loads app.js scoring in a VM with stubbed DOM
const fs=require('fs'),vm=require('vm');
function load(file){
  const el=new Proxy(function(){},{get:(t,k)=>k==='style'||k==='dataset'||k==='classList'?new Proxy({},{get:()=>()=>{}}):k==='querySelectorAll'?()=>[]:el,set:()=>true,apply:()=>el});
  const ctx={console:{log(){},warn(){},error(){}},localStorage:{getItem:()=>null,setItem(){},removeItem(){}},document:{querySelector:()=>el,querySelectorAll:()=>[],getElementById:()=>el,addEventListener(){},createElement:()=>el,body:el},
    window:{addEventListener(){},matchMedia:()=>({matches:false})},navigator:{},location:{hash:'',search:''},fetch:()=>new Promise(()=>{}),setTimeout:()=>0,setInterval:()=>0,addEventListener(){},history:{replaceState(){}},Date,Math,JSON,Intl,URL,URLSearchParams,Promise};
  ctx.self=ctx.window; vm.createContext(ctx);
  try{vm.runInContext(fs.readFileSync(file,'utf8')+';globalThis.__=({model,CFG,scoreHour:typeof scoreHour!=="undefined"?scoreHour:null});',ctx)}catch(e){console.error(file,e.message)}
  return ctx.__;
}
module.exports={load};
if(require.main===module){
  const A=load(__dirname+'/../app.js'), B=require('fs').existsSync(__dirname+'/app-v8.js')?load(__dirname+'/app-v8.js'):null;
  const base={t24:null,d3:0,d12:0,p:1015,time:'2026-11-05T07:00',prime:true};
  const S=[['Ideal rut dawn (cold, cooling, clear, 10 mph, falling baro)',{t:28,t24:40,w:10,g:16,cc:5,pr:0,pp:0,code:0,d3:-2}],['Clear cold calm dawn',{t:22,t24:30,w:3,g:6,cc:5,pr:0,pp:0,code:0}],
   ['Light rain',{t:42,w:6,g:12,cc:100,pr:0.03,pp:90,code:61,sure:true}],
   ['Steady rain',{t:42,w:8,g:15,cc:100,pr:0.1,pp:100,code:63,sure:true}],
   ['Thunderstorm',{t:65,w:12,g:35,cc:100,pr:0.3,pp:100,code:95,sure:true}],
   ['100% overcast, dry',{t:38,w:6,g:12,cc:100,pr:0,pp:5,code:3}],
   ['Mild cloudy, early season',{t:55,w:8,g:14,cc:70,pr:0,pp:10,code:2,time:'2026-10-05T07:00'}],
   ['Hot, sunny, windy',{t:78,w:24,g:40,cc:5,pr:0,pp:0,code:0,prime:false,time:'2026-11-05T13:00'}]];
  console.log('| Scenario | v8 shown (raw) | v9 shown (raw) |\n|---|---|---|');
  for(const [n,x] of S){const r=A.scoreHour({...base,...x}),o=B?(q=>q.s+" ("+q.raw+")")(B.scoreHour({...base,...x})):'-';console.log(`| ${n} | ${o} | **${r.s}** (${r.raw}) |`)}
  console.log('');
  console.log('| Scenario | Score | temp | wind | sky | rut | rain adj |\n|---|---|---|---|---|---|---|');
  for(const [n,x] of S){const r=A.scoreHour({...base,...x});console.log(`| ${n} | **${r.s}** | ${r.f.temp.toFixed(1)} | ${r.f.wind.toFixed(1)} | ${r.f.cloud.toFixed(1)} | ${r.f.rut} | ${r.f.precip.toFixed(1)} |`)}
}
