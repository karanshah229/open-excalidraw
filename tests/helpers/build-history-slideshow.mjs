/** Screenshot evidence slideshow; embeds real captures for a portable HTML artifact. */
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
const directory = resolve(process.argv[2] || '.system_generated/history-divergence-live')
const report = JSON.parse(await readFile(`${directory}/divergence-report.json`, 'utf8'))
const shots = JSON.parse(await readFile(`${directory}/screenshots.json`, 'utf8'))
const slides = await Promise.all(shots.map(async s => ({ ...s, image: `data:image/png;base64,${(await readFile(`${directory}/${s.file}`)).toString('base64')}` })))
const passed = report.stages.some(s => s.label.startsWith('Fresh browser and owner reload')) && !report.errors.length && !report.faultErrors.length
const convergence = report.convergenceDiagnostics && {
  phase: report.convergenceDiagnostics.phase,
  expectedIds: report.convergenceDiagnostics.expectedIds,
  cloudIds: report.convergenceDiagnostics.cloudIds,
  cloudFingerprint: report.convergenceDiagnostics.cloudFingerprint,
  rendered: report.convergenceDiagnostics.rendered.map((entry, i) => ({
    peer: report.convergenceDiagnostics.rendered.length === 2 ? ['guest-a', 'guest-b'][i] : `peer-${i + 1}`,
    actualIds: entry.actualIds,
    differences: entry.differences,
  })),
}
const mismatches = (convergence?.rendered ?? []).flatMap(peer => peer.differences.map(diff => ({ peer: peer.peer, ...diff })))
const failureSummary = report.convergenceDiagnostics
  ? `Strict canonical convergence failed in ${report.convergenceDiagnostics.phase}; ${mismatches.length} peer element mismatch(es) were recorded.`
  : passed ? 'All recorded stages passed.' : 'The run ended before the full divergence scenario completed.'
const responseStatuses = report.responses.reduce((counts, response) => {
  counts[response.status] = (counts[response.status] ?? 0) + 1
  return counts
}, {})
const data = JSON.stringify({ slides, passed, failureSummary, convergence, project: report.firebaseProject, frontend: report.frontend, stages: report.stages, inspection: report.inspection, calls: report.calls.length, responses: report.responses.length, responseStatuses, head: report.head, dropped: report.droppedReceipt }).replace(/</g, '\\u003c')
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Live Firebase · offline collaboration test</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#111216;color:#f5f5f7;font:16px system-ui,-apple-system,sans-serif}button{font:inherit;color:inherit;cursor:pointer}header{padding:22px 30px;display:flex;gap:24px;justify-content:space-between;align-items:center}h1{font-size:24px;letter-spacing:-.7px;margin:6px 0}small,.muted{color:#a5a6b2}.badge{display:inline-block;background:#1a382d;color:#8be0b7;border-radius:20px;padding:6px 12px;font-size:12px;font-weight:700}.badge.failed{background:#492626;color:#ffb5b5}main{display:grid;grid-template-columns:minmax(0,1fr) 310px;gap:26px;margin:0 30px}figure{margin:0;background:#191b22;border:1px solid #30313c;border-radius:14px;overflow:hidden;position:relative;min-height:300px;display:grid;place-items:center}figure img{width:100%;height:auto;display:block;cursor:zoom-in;max-height:calc(100vh - 240px);object-fit:contain}aside{background:#191b22;border-radius:14px;padding:24px}aside h2{font-size:21px;line-height:1.3;margin:0 0 12px}aside ul{padding-left:20px;line-height:1.5;font-size:14px}aside li{margin:14px 0}footer{display:flex;justify-content:space-between;align-items:center;margin:20px 30px;gap:18px}.nav{display:flex;align-items:center;gap:15px}button.ctrl{border:1px solid #464755;background:#232531;border-radius:9px;padding:9px 15px}button:disabled{opacity:.35;cursor:default}details{margin:20px 30px;background:#191b22;padding:16px;border-radius:12px}summary{cursor:pointer}pre{white-space:pre-wrap;font-size:12px;color:#c6c7d0;max-height:320px;overflow:auto}.thumbs{display:flex;gap:12px;overflow:auto;margin:0 30px 25px;padding-bottom:8px}.thumb{flex:0 0 170px;text-align:left;background:#1b1d25;border:2px solid transparent;border-radius:10px;padding:7px;font-size:11px}.thumb[aria-current=true]{border-color:#9c8aff}.thumb img{width:100%;border-radius:5px}.thumb span{display:block;margin:5px}.note{font-size:12px;color:#a5a6b2;margin:20px 30px;max-width:1000px;line-height:1.5}dialog{border:0;padding:10px;background:#111216;color:white;max-width:98vw;max-height:98vh}dialog::backdrop{background:#000d}dialog img{display:block;max-width:94vw;max-height:87vh}dialog button{float:right;background:#292b36;border:0;padding:7px 12px;margin-bottom:7px;border-radius:8px}@media(max-width:900px){main{grid-template-columns:1fr}header{align-items:flex-start}aside{padding:18px}aside ul{display:flex;flex-wrap:wrap;gap:20px}figure img{max-height:none}footer{flex-wrap:wrap}.muted{font-size:12px}}
</style>
<header><div><small>REAL DEVELOPMENT FIREBASE · SCREENSHOT EVIDENCE</small><h1>Offline edits meet a changing shared board</h1><small id="environment"></small></div><span id="result" class="badge"></span></header>
<p class="note" id="runSummary"></p>
<main><figure><img id="capture" alt=""></figure><aside><small id="phase"></small><h2 id="title"></h2><div class="badge" id="peer"></div><ul id="assertions"></ul><small id="timestamp"></small></aside></main>
<footer><div class="nav"><button class="ctrl" id="prev">← Previous</button><span id="count"></span><button class="ctrl" id="next">Next →</button></div><small>Arrow keys navigate · click a screenshot to enlarge</small></footer>
<div class="thumbs" id="thumbs" aria-label="Choose screenshot"></div>
<details><summary>Assertions and run evidence</summary><pre id="evidence"></pre></details>
<p class="note">Screenshots show the actual app. Captions describe assertions evaluated against native history, browser network traffic, independently read Firestore chunks and Realtime Database. The frontend runs locally; Firebase Auth, functions, Firestore and RTDB are deployed dev services. This run is finite and does not verify every chaos permutation, thirty-day cleanup or large-scale performance.</p>
<dialog id="zoom"><button id="closeZoom">Close ×</button><img id="large" alt="Enlarged screenshot"></dialog>
<script>const DATA=${data};let current=0;const $=id=>document.getElementById(id);$('environment').textContent=DATA.project+' · '+DATA.frontend;$('result').textContent=DATA.passed?'TEST PASSED':'RUN INCOMPLETE / FAILED';$('result').classList.toggle('failed',!DATA.passed);$('runSummary').textContent=DATA.failureSummary;$('evidence').textContent=JSON.stringify({...DATA,slides:DATA.slides.map(({image,...s})=>s)},null,2);DATA.slides.forEach((s,i)=>{const b=document.createElement('button');b.className='thumb';b.setAttribute('aria-label','Screenshot '+(i+1)+': '+s.title+' — '+s.peer);const img=document.createElement('img');img.src=s.image;img.alt='';b.appendChild(img);const label=document.createElement('span');label.textContent=(i+1)+'. '+s.peer+' · '+s.title;b.appendChild(label);b.onclick=()=>show(i);$('thumbs').appendChild(b)});function show(i){current=Math.max(0,Math.min(DATA.slides.length-1,i));const s=DATA.slides[current];$('capture').src=s.image;$('capture').alt=s.title+' — '+s.peer;$('title').textContent=s.title;$('phase').textContent=s.phase.toUpperCase();$('peer').textContent=s.peer;$('timestamp').textContent='Captured '+new Date(s.at).toLocaleString();$('count').textContent=(current+1)+' / '+DATA.slides.length;$('assertions').replaceChildren(...s.assertions.map(a=>{const li=document.createElement('li');li.textContent=a;return li}));$('prev').disabled=current===0;$('next').disabled=current===DATA.slides.length-1;[...$('thumbs').children].forEach((b,j)=>b.setAttribute('aria-current',String(j===current)))}$('prev').onclick=()=>show(current-1);$('next').onclick=()=>show(current+1);document.addEventListener('keydown',e=>{if($('zoom').open)return;if(e.key==='ArrowRight')show(current+1);if(e.key==='ArrowLeft')show(current-1);if(e.key==='Home')show(0);if(e.key==='End')show(DATA.slides.length-1)});$('capture').onclick=()=>{$('large').src=DATA.slides[current].image;$('zoom').showModal()};$('closeZoom').onclick=()=>$('zoom').close();show(0);</script></html>`
await writeFile(`${directory}/slideshow.html`, html)
console.log(JSON.stringify({ slideshow: `${directory}/slideshow.html`, captures: slides.length, passed }))
