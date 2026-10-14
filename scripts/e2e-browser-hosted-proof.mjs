/** Public historical data visibility only; no signatures or chain writes. */
import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {mkdirSync,writeFileSync} from 'node:fs';import path from 'node:path';
const name=path.basename(process.cwd()).replace('-arc',''),base=`https://${name}-arc.vercel.app`;
const get=async p=>{const r=await fetch(base+p,{signal:AbortSignal.timeout(60000)});assert(r.ok);return r.json()};
const result={at:new Date().toISOString(),base,readOnly:true};
if(name==='xorv'){
 const j=await get('/api/jobs');assert.equal(j.mode,'read-only');assert.equal(j.available,false);assert.equal(j.jobs.length,1);assert.equal(j.jobs[0].payment.network,'eip155:5042');const detail=await get('/api/jobs/'+j.jobs[0].id);assert.equal(detail.job.resultHash,j.jobs[0].resultHash);result.jobs=1;result.route='/jobs/'+j.jobs[0].id;result.text='Fund the escrow';
}else{
 const c=await get('/api/config');assert.equal(c.readOnly,true);assert.equal(c.chainId,5042);const j=await get('/api/rounds');assert.equal(j.rounds.length,4);assert.equal(j.rounds.filter(r=>r.trade?.hash).length,1);result.rounds=4;result.route='/runs';result.text='Approved 4';
}
const {chromium}=createRequire(path.resolve('../thenar-arc/package.json'))('playwright');const out='docs/screens/mainnet/proof';mkdirSync(out,{recursive:true});process.env.TMPDIR=path.resolve('.vercel/browser-mainnet-tmp');mkdirSync(process.env.TMPDIR,{recursive:true});const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
try{const p=await browser.newPage();await p.goto(base+result.route,{waitUntil:'domcontentloaded'});await p.getByText(result.text,{exact:false}).first().waitFor({timeout:45000});await p.screenshot({path:out+'/history.jpg'});result.ok=true;console.log('PASS',name,JSON.stringify(result));}finally{await browser.close();writeFileSync(out+'/results.json',JSON.stringify(result,null,2)+'\n');}
