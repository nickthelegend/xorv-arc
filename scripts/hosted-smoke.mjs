// Exercise the hosted, explicitly labelled Echo test capability (0.001 USDC).
import { writeFileSync, mkdirSync } from 'node:fs';
const broker='https://broker-production-d2c4.up.railway.app',app='https://app-production-909f.up.railway.app';
const req=async(url,body)=>{const r=await fetch(url,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{});const data=await r.json();if(!r.ok)throw new Error(`HTTP ${r.status}: ${JSON.stringify(data)}`);return data;};
const q=await req(broker+'/api/quotes',{prompt:'Hosted Arc testnet smoke: Echo test, not an AI model.',adapter:'echo',maxPriceUsdMicros:1000});
if(q.network!=='eip155:5042002'||BigInt(q.usdcAmount)>1000n)throw new Error('Testnet/price guard');
const paid=await req(app+'/api/pay',{quoteId:q.quoteId,payTo:q.provider.address,usdcAmount:q.usdcAmount,network:q.network,escrow:q.escrow?.address});
let job;
for(let i=0;i<90;i++){const r=await req(broker+'/api/jobs/'+paid.jobId);job=r.job??r;if(job.status==='completed'&&job.payment?.escrow?.state==='released')break;await new Promise(r=>setTimeout(r,1000));}
const evidence={checkedAt:new Date().toISOString(),quote:q,paid,job};mkdirSync('docs/screens/hosted',{recursive:true});writeFileSync('docs/screens/hosted/action.json',JSON.stringify(evidence,null,2));
console.log(JSON.stringify({jobId:paid.jobId,status:job.status,payment:job.payment}));if(job.status!=='completed'||job.payment?.escrow?.state!=='released')process.exitCode=1;
