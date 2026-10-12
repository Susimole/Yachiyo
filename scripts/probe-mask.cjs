/**
 * 穿透掩码的回归探针 —— 2026-10-12。
 *
 * 盯一件事：**窗口一出来，掩码就得是好的**。
 *
 * 原来 app.js 的循环写的是 `updateMask(); rig.render();` —— 取的是上一帧
 * 的画布。平时只差一帧无所谓，但**第一帧**取到的是还没画过的空白，
 * 于是 `hitProbe()` 返回 null（她身上「一个实心像素都没有」），
 * 自检里那句「扫不到她身上的实心像素」就是它，而且时好时坏。
 *
 * 跑法：node scripts/probe-mask.cjs
 */
'use strict';
const { spawn, execSync } = require('node:child_process');
const path=require('node:path'), fs=require('node:fs');
const ROOT=path.join(__dirname,'..'), electronPath=require('electron');
const PORT=9348, HOME=path.join(ROOT,'_dbg-mask-home');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
class CDP{constructor(ws){this.ws=ws;this.seq=0;this.pend=new Map();
 ws.addEventListener('message',ev=>{const m=JSON.parse(ev.data);
  if(m.id&&this.pend.has(m.id)){const{res,rej}=this.pend.get(m.id);this.pend.delete(m.id);
   m.error?rej(new Error(m.error.message)):res(m.result);}});}
 static async attach(){const l=await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const p=l.find(t=>t.type==='page'&&t.webSocketDebuggerUrl&&!/(menu|panel|chat|ask)\.html/.test(t.url||''));
  if(!p)throw new Error('no main');const ws=new WebSocket(p.webSocketDebuggerUrl);
  await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',()=>j(new Error('x')),{once:true});});
  const c=new CDP(ws);await c.send('Runtime.enable');try{await c.send('Page.enable');}catch{}return c;}
 send(m,p={}){const id=++this.seq;return new Promise((res,rej)=>{this.pend.set(id,{res,rej});
  this.ws.send(JSON.stringify({id,method:m,params:p}));
  setTimeout(()=>{if(this.pend.has(id)){this.pend.delete(id);rej(new Error(m+' timeout'));}},15000);});}
 async js(e){const r=await this.send('Runtime.evaluate',{expression:`(async()=>{${e}})()`,awaitPromise:true,returnByValue:true});
  if(r.exceptionDetails)throw new Error((r.exceptionDetails.exception||{}).description||r.exceptionDetails.text);return r.result.value;}}
(async()=>{
 fs.rmSync(HOME,{recursive:true,force:true});fs.mkdirSync(path.join(HOME,'data'),{recursive:true});
 fs.writeFileSync(path.join(HOME,'config.json'),JSON.stringify({petSize:100,moveEnabled:false}),'utf8');
 try{execSync('powershell -NoProfile -Command "Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -like \'*Git\\node_modules*\' } | ForEach-Object { $_.Kill() }"',{stdio:'ignore'});}catch{}
 await sleep(600);
 const child=spawn(electronPath,[`--remote-debugging-port=${PORT}`,ROOT],
  {env:{...process.env,ELECTRON_RUN_AS_NODE:undefined,YACHIYO_MS:'40000',YACHIYO_HOME:HOME},stdio:'ignore'});
 let m=null;for(let i=0;i<40&&!m;i++){await sleep(400);try{m=await CDP.attach();}catch{}}
 if(!m){child.kill();throw new Error('起不来');}
 const s = await m.js(`
   const out = [];
   for (let i = 0; i < 12; i++) {
     const hp = window.__yachiyo.hitProbe();
     const c = document.getElementById('pet');
     const g = c.getContext('2d', { willReadFrequently: true });
     const d = g.getImageData(0,0,c.width,c.height).data;
     let solid = 0;
     for (let k = 3; k < d.length; k += 4*53) if (d[k] > 40) solid++;
     out.push({ hp: hp ? hp.x.toFixed(0)+','+hp.y.toFixed(0) : null,
                mode: window.__yachiyo.rig.mode, set: window.__yachiyo.setName,
                canvasSolid: solid, size: Math.round(window.__yachiyo.size) });
     await new Promise(r => setTimeout(r, 700));
   }
   return out;
 `);
 for (const r of s) console.log(`  mode=${String(r.mode).padEnd(6)} set=${String(r.set).padEnd(6)} size=${r.size} 画布实心=${String(r.canvasSolid).padStart(5)} hitProbe=${r.hp}`);
 const bad = s.filter((r) => !r.hp && r.canvasSolid > 200);
 console.log(`
==== ${bad.length ? 'X ' + bad.length + ' 帧里她画出来了但点不着' : 'OK 每一帧都点得着'} ====`);
 child.kill();await sleep(300);process.exit(bad.length ? 1 : 0);
})().catch(e=>{console.error(e);process.exit(1);});
