import * as c from './dryrun-common.mjs';
await c.run('xorv', async () => {
const n='xorv',d=c.load(n).contracts,a=(await import('../packages/protocol/src/escrow.ts')).XORV_ESCROW_ABI,la=(await import('../packages/protocol/src/ledger.ts')).XORV_LEDGER_ABI;
c.roleKey('broker','xorv','XORV_OPERATOR_KEY',c.load(n).broker);
for(const role of ['provider','broker','buyer'])await c.fund(n,role,'0.2');
const id=await c.register(n,'provider');
await c.write(n,'bind provider identity','provider',d.XorvReputation,c.abi(n,'XorvReputation'),'bind',[id]);
const jobId=c.keccak256(c.toHex('xorv:dryrun:'+c.roles.buyer));
await c.write(n,'provider goes online','broker',d.XorvLedger,la,'registerProvider',[c.keccak256(c.toHex('provider')),c.roles.provider,id,'Fork provider','model:10000']);
const deadline=(await c.pub.getBlock()).timestamp+3600n,nonce=await c.read(d.XorvEscrow,a,'fundingNonce',[jobId,deadline]);
const u=await c.auth('buyer',d.XorvEscrow,10000n,nonce,'ReceiveWithAuthorization');
await c.memoWrite(n,'x402 fund job escrow 0.01','broker',d.XorvEscrow,a,'fund',[{jobId,buyer:c.roles.buyer,provider:c.roles.provider,token:c.USDC,amount:10000n,deadline,validAfter:u.validAfter,validBefore:u.validBefore,signature:u.signature}]);
const result='Arc uses USDC for gas, so a buyer can pay for an AI job and its transaction fees with the same token.';
c.note('modelScope',{result,source:'Output authored by the rehearsal assistant; provider transport and external model API not exercised. On-chain payment path measured.'});
const resultHash=c.keccak256(c.toHex(result));
const settled=await c.memoWrite(n,'release escrow provider paid reputation','broker',d.XorvEscrow,a,'release',[jobId,resultHash]);
await c.write(n,'record delivered job receipt','broker',d.XorvLedger,la,'recordJobs',[[{jobId,agentId:id,buyer:c.roles.buyer,payTo:c.roles.provider,amount:10000n,paymentTx:settled.transactionHash,requestHash:c.keccak256(c.toHex('Explain Arc USDC gas')),resultHash,durationMs:1000,ok:true}]]);
const rated=await c.write(n,'buyer rates ERC-8004','buyer',d.XorvLedger,la,'rateJob',[{jobId,value:100n,tag2:'fork-rehearsal',endpoint:'',feedbackURI:'',feedbackHash:c.keccak256(c.toHex('rating')),deadline},'0x']);
c.note('state',{job:await c.read(d.XorvEscrow,a,'getJob',[jobId]),stats:await c.read(d.XorvReputation,c.abi(n,'XorvReputation'),'stats',[c.roles.provider])});

const rep='0x8004BAa17C55a88189AE136b182e5fdA19dE9b63';
if(!settled.logs.some(l=>l.address.toLowerCase()===rep.toLowerCase()))throw Error('Release emitted no ERC-8004 feedback');
if(!rated.logs.some(l=>l.address.toLowerCase()===rep.toLowerCase()))throw Error('Rating emitted no ERC-8004 feedback');
c.note('erc8004Feedback',{registry:rep,emittedOnRelease:true,emittedOnBuyerRating:true});
});
