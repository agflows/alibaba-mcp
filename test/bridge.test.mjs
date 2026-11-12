import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import {
  BridgeConfigError,
  ExtensionBridge,
  authProof,
  createPairingToken,
  isLoopbackAddress,
  proofsMatch,
  readBridgeConfigFromEnv,
} from "../.test-build/app.mjs";

const extensionId = "b".repeat(32);
function options(token, extra = {}) { return { port: 0, token, extensionIds: [extensionId], requestTimeoutMs: 250, heartbeatMs: 60_000, staleAfterMs: 60_000, ...extra }; }
function socketFor(bridge, origin = `chrome-extension://${extensionId}`, path = "/") {
  const socket = new WebSocket(`ws://127.0.0.1:${bridge.port}${path}`, origin ? { origin } : {}); socket.on("error", () => {}); return socket;
}
function next(socket) { return new Promise((resolve, reject) => { const timer=setTimeout(()=>reject(new Error("message timeout")),2000); socket.once("message",d=>{clearTimeout(timer);resolve(JSON.parse(String(d)))}); }); }
function opened(socket) { return new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(new Error("open timeout")),2000);socket.once("open",()=>{clearTimeout(t);resolve()});socket.once("close",()=>{clearTimeout(t);reject(new Error("closed"))})}); }
function closed(socket) { return new Promise(resolve=>socket.readyState===WebSocket.CLOSED?resolve():socket.once("close",resolve)); }
async function authenticate(socket, token) { const challengePending=next(socket); await opened(socket); const challenge=await challengePending; assert.equal(challenge.type,"auth-challenge"); socket.send(JSON.stringify({type:"auth-proof",proof:authProof(token,challenge.challenge)})); assert.equal((await next(socket)).type,"auth-ok"); }

 test("config defaults to the pinned extension and no user token", () => {
  const config=readBridgeConfigFromEnv({}); assert.equal(config.port,17873); assert.equal(config.extensionIds.length>=1,true);
  assert.throws(()=>readBridgeConfigFromEnv({ALIBABA_MCP_PORT:"80"}),BridgeConfigError);
  assert.equal(authProof("a".repeat(32),"b".repeat(32)).length>20,true);
  assert.equal(proofsMatch("same","same"),true); assert.equal(proofsMatch("same","nope"),false);
  assert.equal(isLoopbackAddress("127.0.0.1"),true); assert.equal(isLoopbackAddress("10.0.0.1"),false);
 });

test("bridge pairs automatically then authenticates without a token URL", async()=>{
 const token=createPairingToken(); const bridge=new ExtensionBridge(options(token));
 try { await bridge.ready;
  for(const bad of [socketFor(bridge,"https://evil.example"),socketFor(bridge,`chrome-extension://${"e".repeat(32)}`),socketFor(bridge,null),socketFor(bridge,`chrome-extension://${extensionId}`,"/?token=secret")]) await closed(bad);
  const pairing=socketFor(bridge); const pairingChallenge=next(pairing); await opened(pairing); assert.equal((await pairingChallenge).type,"auth-challenge"); pairing.send(JSON.stringify({type:"pair-request"})); const paired=await next(pairing); assert.equal(paired.type,"pair-token"); assert.equal(paired.token,token); await closed(pairing); assert.equal(bridge.connected,false);
  const repeated=socketFor(bridge); const repeatedChallenge=next(repeated); await opened(repeated); await repeatedChallenge; repeated.send(JSON.stringify({type:"pair-request"})); assert.equal((await next(repeated)).type,"pairing-unavailable"); await closed(repeated);
  const socket=socketFor(bridge); await authenticate(socket,token); assert.equal(bridge.connected,true);
  const pending=bridge.call("get_status"); const request=await next(socket); socket.send(JSON.stringify({id:request.id,ok:true,result:{accessMode:"write"}})); assert.deepEqual(await pending,{accessMode:"write"}); socket.close(); await closed(socket);
 } finally { await bridge.close(); }
});

test("wrong and replayed proofs are rejected",async()=>{
 const token=createPairingToken(); const bridge=new ExtensionBridge(options(token));
 try {await bridge.ready; const first=socketFor(bridge); const c1Pending=next(first); await opened(first); const c1=await c1Pending; first.send(JSON.stringify({type:"auth-proof",proof:authProof("x".repeat(32),c1.challenge)})); assert.equal((await next(first)).type,"pairing-required"); await closed(first);
 const second=socketFor(bridge); const c2Pending=next(second); await opened(second); await c2Pending; second.send(JSON.stringify({type:"auth-proof",proof:authProof(token,c1.challenge)})); assert.equal((await next(second)).type,"pairing-required"); await closed(second); assert.equal(bridge.connected,false);
 } finally {await bridge.close();}
});

test("pending calls fail on timeout and replacement",async()=>{
 const token=createPairingToken(); const bridge=new ExtensionBridge(options(token,{requestTimeoutMs:80}));
 try {await bridge.ready; await assert.rejects(bridge.call("get_status"),/not connected/i); const first=socketFor(bridge); await authenticate(first,token); const timed=bridge.call("get_status"); await next(first); await assert.rejects(timed,/Timed out/);
 const pending=bridge.call("get_status"); const rejected=assert.rejects(pending,/reconnected/i); await next(first); const second=socketFor(bridge); await authenticate(second,token); await rejected; await closed(first); second.close();
 } finally {await bridge.close();}
});
