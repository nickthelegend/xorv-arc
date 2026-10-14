import { NextRequest, NextResponse } from 'next/server';
import testnet from '../../../../../deployments/arc-testnet.json';
import mainnet from '../../../../../deployments/arc-mainnet.json';
const isMainnet = process.env.NEXT_PUBLIC_XORV_NETWORK === 'eip155:5042';
const deployment = isMainnet ? mainnet : testnet;
export const dynamic = 'force-dynamic';
const offline = 'Start the local broker and a provider to run live jobs. Hosted execution is disabled.';
const explorer = isMainnet ? 'https://explorer.arc.io' : 'https://explorer.testnet.arc.io';
export async function GET(request: NextRequest) {
 if (process.env.NEXT_PUBLIC_XORV_READ_ONLY !== '1') return NextResponse.json({error:'No local broker route'}, {status:404});
 const route = request.nextUrl.pathname;
 const contracts = deployment.contracts;
 const common = {mode:'read-only', available:false, reason:offline};
 if(route === '/api/network') return NextResponse.json({...common,
  network:`eip155:${deployment.chainId}`, chainId:deployment.chainId,label:isMainnet ? 'mainnet' : 'testnet',explorerUrl:explorer,
  usdc:{address:deployment.external.usdc,symbol:'USDC',decimals:6},
  facilitator:{mode:'self',description:offline,address:null,available:false},
  ledger:{address:contracts.XorvLedger,url:explorer+'/address/'+contracts.XorvLedger},
  escrow:{address:contracts.XorvEscrow,url:explorer+'/address/'+contracts.XorvEscrow,deadlineSeconds:300},
  erc8004:{identity:deployment.external.erc8004IdentityRegistry,reputation:deployment.external.erc8004ReputationRegistry},
  indexer:null,ai:{router:null,screener:null,verifier:null},
  stats:{providersLive:0,providersConnected:0,capacity:0},
 });
 if(route === '/api/providers') return NextResponse.json({...common,providers:[]});
 if(route === '/api/jobs') return NextResponse.json({...common,jobs:[]});
 if(route === '/api/leaderboard') return NextResponse.json({...common,source:'unavailable',providers:[]});
 if(route === '/api/ledger') return NextResponse.json({...common,source:'unavailable',events:[]});
 return NextResponse.json({...common,error:offline},{status:503});
}
export async function POST() { return NextResponse.json({error:offline},{status:503}); }
