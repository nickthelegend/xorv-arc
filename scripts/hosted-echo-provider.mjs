// A clearly labelled deterministic test provider, never advertised as an AI model.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
const home=process.env.XORV_HOME || '/data';fs.mkdirSync(home,{recursive:true});
const file=home+'/config.json';
if(!fs.existsSync(file)) fs.writeFileSync(file,JSON.stringify({nodeId:'arc-hosted-echo',label:'Echo (test; no AI model)',network:'eip155:5042002',brokerUrl:process.env.XORV_BROKER_URL,address:process.env.XORV_PROVIDER_ADDRESS,privateKey:'',agentId:null,capabilities:[{id:'echo',adapter:'echo',displayName:'Echo (test)',model:null,priceUsdMicros:1000,maxConcurrency:2}],region:null,tunnel:{enabled:false,hostname:null},sandboxDir:home+'/jobs',providerId:null,token:null}),{mode:0o600});
let child,stopping=false;
const start=()=>{child=spawn(process.execPath,['packages/cli/dist/index.js','start'],{stdio:'inherit',env:process.env});child.on('exit',code=>{if(stopping)process.exit(code??0);setTimeout(start,5000);});};
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{stopping=true;child?.kill(signal);});
start();
