/** Archive the existing public video job after verifying its mainnet settlement. */
import assert from 'node:assert/strict';import fs from 'node:fs';import {createRequire} from 'node:module';
const {createPublicClient,http,parseAbi,parseEventLogs,keccak256,toHex}=createRequire(new URL('../apps/app/package.json',import.meta.url))('viem');
const client=createPublicClient({transport:http('https://rpc.mainnet.arc.io')});assert.equal(await client.getChainId(),5042);
const source=JSON.parse(fs.readFileSync('../video/raw/xorv-A-jobs-final.json','utf8'));const d=JSON.parse(fs.readFileSync('deployments/arc-mainnet.json','utf8'));
const jobs=[];
for(const job of source.jobs){
 assert.equal(job.private,false);assert.equal(job.payment.network,'eip155:5042');assert.equal(job.payment.escrow.address.toLowerCase(),d.contracts.XorvEscrow.toLowerCase());assert.equal(keccak256(toHex(job.result)),job.resultHash);
 for(const hash of [job.payment.txHash,job.payment.escrow.releaseTx,job.receiptTxHash,job.rating.txHash])assert.equal((await client.getTransactionReceipt({hash})).status,'success');
 const release=await client.getTransactionReceipt({hash:job.payment.escrow.releaseTx});
 const event=parseEventLogs({abi:parseAbi(['event JobReleased(bytes32 indexed jobId,address indexed provider,uint256 providerAmount,uint256 fee,bytes32 resultHash,address releasedBy)']),logs:release.logs,eventName:'JobReleased'}).find(e=>e.address.toLowerCase()===d.contracts.XorvEscrow.toLowerCase()&&e.args.jobId===job.payment.escrow.jobId);
 assert(event);assert.equal(event.args.resultHash,job.resultHash);assert.equal(event.args.provider.toLowerCase(),job.providerAddress.toLowerCase());
 // Strip local timing labels and links; retain the original public content.
 delete job.payment.timing;delete job.payment.escrow.settleTiming;delete job.rating.feedbackURI;
 jobs.push(job);
}
fs.writeFileSync('deployments/hosted-jobs-mainnet.json',JSON.stringify({chainId:5042,verifiedAt:new Date().toISOString(),source:'Original public video recording; payment, release, ledger and rating receipts verified. Execution remains offline.',jobs},null,2)+'\n');console.log('Verified public mainnet video jobs:',jobs.length);
