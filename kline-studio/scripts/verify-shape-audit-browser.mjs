import { chromium } from 'file:///C:/Users/zbx00/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import fs from 'node:fs';
const out='D:/codex/V6/research/shape-all-audit-20260909';
const audit=JSON.parse(fs.readFileSync(new URL('../src/data/shape-annotation-reviews.json',import.meta.url),'utf8'));
const browser=await chromium.launch({headless:true,executablePath:'C:/Users/zbx00/AppData/Local/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-win64/chrome-headless-shell.exe'});
const requested=new Set(process.argv.slice(2));
const previous=requested.size&&fs.existsSync(out+'/browser-validation.json')?JSON.parse(fs.readFileSync(out+'/browser-validation.json','utf8')).results:[];
const results=previous.filter(r=>!requested.has(r.id));
try {
 const gallery=await browser.newPage({viewport:{width:1680,height:1150}});
 await gallery.goto('http://127.0.0.1:4173/shape-all-audit.html');
 if(await gallery.locator('#case option').count()!==39) throw Error('audit inventory mismatch');
 for(const r of audit.reviews){await gallery.selectOption('#case',r.id);if(!(await gallery.locator('#note').innerText()).includes(r.note))throw Error('wrong review '+r.id);}
 await gallery.selectOption('#case',audit.reviews.find(r=>r.id.endsWith('-628-bear')).id);
 await gallery.screenshot({path:out+'/audit-gallery.png',fullPage:true});
 await gallery.close();
 for(const r of audit.reviews.filter(r=>r.verdict==='match'&&(!requested.size||requested.has(r.id)))){
  const context=await browser.newContext({viewport:{width:1800,height:1100}});
  const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:4173/',{waitUntil:'domcontentloaded'});
  await page.getByTitle('随机交易决策回放',{exact:true}).waitFor();
  await page.evaluate(async id=>{const a=await import('/src/lib/shapeDecisionPractice.ts');localStorage.setItem(a.SHAPE_EXCLUSIONS_KEY,JSON.stringify(a.shapeDecisionCandidates.filter(c=>c.shapePracticeId!==id).map(c=>c.key)));},r.id);
  await page.reload({waitUntil:'domcontentloaded'});
  await page.getByTitle('随机交易决策回放',{exact:true}).click();
  await page.getByRole('button',{name:/按K线形态/}).click();
  await page.getByRole('button',{name:'随机抽取并开始',exact:true}).click();
  await page.getByTestId('shape-ai-analysis').waitFor();
  if(!(await page.getByTestId('shape-ai-analysis').innerText()).includes(r.note))throw Error('wrong app question '+r.id);
  await page.keyboard.press('Backquote');
  // Move only the disposable test browser's floating PnL panel off the candles.
  // The real user's saved panel placement and practice storage are never touched.
  const pnl=await page.locator('.decision-chart-status > header').boundingBox();
  if(pnl){await page.mouse.move(pnl.x+20,pnl.y+8);await page.mouse.down();await page.mouse.move(pnl.x+20,810,{steps:8});await page.mouse.up();}
  for(const p of r.phases){const node=page.getByTestId('shape-phase-segment-'+p.kind);await node.waitFor({state:'attached'});if(!await node.locator('xpath=..').isVisible())throw Error('phase overlay hidden');if(Number(await node.getAttribute('data-start-index'))!==p.startIndex||Number(await node.getAttribute('data-end-index'))!==p.endIndex)throw Error('wrong interval bounds');if(await node.locator('text, rect').count())throw Error('phase labels should be hidden');const x=Number(await node.locator('line').first().getAttribute('x1'));if(x<0)throw Error('clipped phase start '+r.id);}
  const file=out+'/practice-'+(r.id.startsWith('M')?r.id:'K628')+'.png';
  await page.screenshot({path:file});
  await page.keyboard.press('Backquote');
  await page.getByTestId('shape-phase-segment-narrow').waitFor({state:'hidden'});
  if(errors.length)throw Error(errors.join(';'));
  results.push({id:r.id,threeIntervalsVisible:true,tradeSignalToggleHidesIntervals:true,screenshot:file});
  fs.writeFileSync(out+'/browser-validation.json',JSON.stringify({status:results.length===13?'PASS':'running',checked:results.length,total:13,results},null,2));
  console.log('PASS '+r.id);
  await context.close();
 }
}catch(error){fs.writeFileSync(out+'/browser-validation.json',JSON.stringify({status:'FAIL',error:String(error),checked:results.length,total:13,results},null,2));throw error;}finally{await browser.close();}
