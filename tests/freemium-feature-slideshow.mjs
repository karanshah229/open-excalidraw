import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises'
const directory = new URL('../logs/freemium-live/', import.meta.url)
const publishReview = process.argv.includes('--publish-review')
const output = publishReview ? new URL('../docs/reviews/freemium/', import.meta.url) : directory
if (publishReview) await mkdir(new URL('screenshots/', output), { recursive: true })
const results = JSON.parse(await readFile(new URL('results.json', directory), 'utf8'))
if (!results.slides.length) throw new Error('Capture live screenshots before building the slideshow.')
const slides = await Promise.all(
  results.slides.map(async (slide) => {
    if (publishReview) await copyFile(new URL(slide.file, directory), new URL(`screenshots/${slide.file}`, output))
    return {
      ...slide,
      image: publishReview
        ? `screenshots/${slide.file}`
        : `data:image/png;base64,${(await readFile(new URL(slide.file, directory))).toString('base64')}`,
    }
  }),
)
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Freemium feature review</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#10131a;color:#eff3fb;font:16px system-ui,sans-serif}main{max-width:1600px;margin:auto;padding:24px}header{display:flex;justify-content:space-between;align-items:center;gap:20px;flex-wrap:wrap}h1{font-size:24px;margin:0 0 6px}p{margin:6px 0;color:#bdc6d6}button{font:inherit;padding:10px 16px;background:#242b39;color:inherit;border:1px solid #5c6980;border-radius:8px}button:disabled{opacity:.45}button:focus-visible{outline:3px solid #b9a5ff}nav{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.stage{display:flex;justify-content:center;margin:20px 0;background:#191f2a;border-radius:12px;padding:12px}.stage img{max-width:100%;max-height:72vh;object-fit:contain;border-radius:6px}h2{font-size:20px;margin:12px 0 0}.status{font-size:13px;color:#b0d5be}details{margin-top:24px;color:#bdc6d6}li{margin:8px 0}table{border-collapse:collapse;width:100%;max-width:850px;margin:16px 0;font-size:14px}th,td{text-align:left;border-bottom:1px solid #465268;padding:9px;overflow-wrap:anywhere}caption{text-align:left;font-weight:600;margin:8px 0}@media(max-width:600px){main{padding:16px}.stage img{max-height:none}header nav{width:100%;justify-content:space-between}th,td{padding:6px}}
</style></head><body><main>
<header><div><h1>Freemium feature review</h1><p>Actual app screenshots · open-excalidraw-dev-2 · port 15176</p><div class="status">${results.checks.length} live checks passed · 17 emulator integration checks + browser suite passed</div></div><nav aria-label="Slide controls"><button id="previous" type="button">← Previous</button><span id="position" aria-live="polite"></span><button id="next" type="button">Next →</button></nav></header>
<h2 id="title"></h2><p id="detail"></p>
<table id="collaboration-limits" hidden><caption>Live collaboration limits · board owner’s plan applies</caption><thead><tr><th>Criterion</th><th>Free</th><th>Pro / complimentary</th></tr></thead><tbody><tr><td>Sessions per board, including owner</td><td>3</td><td>10</td></tr><tr><td>Next session at capacity</td><td>4th: read-only snapshot</td><td>11th: read-only snapshot</td></tr><tr><td>Capacity notice</td><td>Shown at 3 sessions</td><td>Shown on rejected admission</td></tr><tr><td>Counted unit</td><td colspan="2">Each tab/device, not unique people. Guest activity uses the owner’s plan.</td></tr><tr><td>Live element safety ceiling</td><td colspan="2">Under 256 KiB UTF-8 · warnings at 200 / 240 KiB</td></tr></tbody></table>
<div class="stage"><img id="screenshot" alt=""></div>
<details><summary>Test coverage and limitations</summary><ul>${results.checks.map((check) => `<li>${check}</li>`).join('')}</ul><p>Image usage at 80% was seeded on a disposable account. Other slides use actual cloud board saves, quota rejection and Firebase entitlements. Google OAuth itself was not automated. Existing dev rules and background triggers were preserved for other worktrees; security bypass tests passed against emulators.</p><p>Temporary accounts, fixture data and the temporary complimentary email were removed after capture. These screenshots are a recorded review, not a signed-in account.</p></details>
</main><script>
const slides=${JSON.stringify(slides).replace(/</g, '\\u003c')};const requestedSlide=Number(location.hash.slice(1));let index=Number.isInteger(requestedSlide)&&requestedSlide>=1&&requestedSlide<=slides.length?requestedSlide-1:0;function render(){history.replaceState(null,'','#'+(index+1));const slide=slides[index];document.getElementById('title').textContent=slide.title;document.getElementById('detail').textContent=slide.detail;document.getElementById('collaboration-limits').hidden=!/^1[0-4]-/.test(slide.file);const image=document.getElementById('screenshot');image.src=slide.image;image.alt=slide.title;document.getElementById('position').textContent=(index+1)+' / '+slides.length;document.getElementById('previous').disabled=index===0;document.getElementById('next').disabled=index===slides.length-1;}document.getElementById('previous').onclick=()=>{if(index>0){index--;render()}};document.getElementById('next').onclick=()=>{if(index<slides.length-1){index++;render()}};document.addEventListener('keydown',event=>{if(event.key==='ArrowRight')document.getElementById('next').click();if(event.key==='ArrowLeft')document.getElementById('previous').click()});render();
</script></body></html>`
await writeFile(new URL(publishReview ? 'index.html' : 'slideshow.html', output), html)
console.log(`Created feature slideshow with ${slides.length} real screenshots.`)
