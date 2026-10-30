import assert from 'node:assert/strict';
import { before, after, beforeEach, test } from 'node:test';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import http from 'node:http';
import { spawn } from 'node:child_process';

const prototype = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(prototype, 'package.json'));
const output = process.env.WARUN_REDRAFT_TEST_OUTPUT || await mkdtemp(join(tmpdir(), 'warun-checkout-redraft-ui-'));
await mkdir(output, { recursive: true });
const fixture = `import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {CustomerScreen,defaultState} from ${JSON.stringify(join(prototype, 'src/App.jsx').replaceAll('\\', '/'))};
import ${JSON.stringify(join(prototype, 'src/styles.css').replaceAll('\\', '/'))};
window.fixtureCase=Number(new URL(location.href).searchParams.get('case'));
window.AudioContext=undefined;window.webkitAudioContext=undefined;
window.fetch=async url=>{if(String(url).endsWith('/v1/business-hours'))return new Response(JSON.stringify({}),{status:200,headers:{'Content-Type':'application/json'}});throw Error('Fixture rejected fetch: '+url)};
const config={deviceId:'fictional-checkout-device',role:'customer',tableId:1,visitContextId:'v1_'+'a'.repeat(64)};
const acknowledge=c=>localStorage.setItem('warun:customer-order-start-notice:v1:'+encodeURIComponent(c.deviceId)+':'+c.tableId+':'+encodeURIComponent(c.visitContextId),'confirmed');
acknowledge(config);window.fixtureConfig=config;window.serverCheckout=null;window.posts=[];window.getCalls=0;window.transportCalls=[];window.getRequests=[];window.deferGets=false;window.acceptedIds=new Set();const invalidations=new Set(),reconnects=new Set();
const client={mode:'api',getThemeConfig:async()=>({theme:'standard'}),getOrderStartNotice:async()=>({heading:'Fictional fixture notice',body:'Isolated checkout test'}),getMenu:async()=>({categories:[],items:[]}),getHistory:async()=>[],getDeviceConfig:async()=>window.fixtureConfig,
subscribe:()=>()=>{},subscribeInvalidations:(callback,options={})=>{invalidations.add(callback);if(options.onReconnect)reconnects.add(options.onReconnect);return()=>{invalidations.delete(callback);reconnects.delete(options.onReconnect)}},
getCheckout:()=>{window.getCalls++;const snapshot=structuredClone(window.serverCheckout);window.transportCalls.push({method:'GET',snapshot});if(window.deferGets)return new Promise((resolve,reject)=>window.getRequests.push({snapshot,resolve,reject}));if(window.nextGetError){const e=window.nextGetError;window.nextGetError=null;return Promise.reject(Object.assign(Error('Fictional GET failure'),e))}return Promise.resolve(snapshot)},
requestCheckout:request=>{window.transportCalls.push({method:'POST',request:structuredClone(request)});return new Promise((resolve,reject)=>window.posts.push({request:structuredClone(request),resolve,reject}))}};
window.emitCheckout=checkout=>{window.serverCheckout=checkout;for(const callback of invalidations)callback({type:'checkout.ready',payload:{resource:'checkout'}})};
window.reconnectCheckout=async()=>{for(const callback of reconnects)await callback('reconnected')};
window.failGet=()=>{window.nextGetError={status:503,stage:'http',code:'FICTIONAL_GET_ERROR'};for(const callback of invalidations)callback({type:'checkout.ready',payload:{resource:'checkout'}})};
window.resolvePost=(index,extra={})=>{const result={checkoutRequestId:window.posts[index].request.checkoutRequestId,status:'requested',receiptRequested:window.posts[index].request.receiptRequested,version:1,...extra};window.serverCheckout=result;window.acceptedIds.add(result.checkoutRequestId);window.posts[index].resolve(result)};window.resolveGet=i=>window.getRequests[i].resolve(window.getRequests[i].snapshot);window.rejectGet=i=>window.getRequests[i].reject(Error('Fictional delayed old GET failure'));
window.rejectPost=index=>window.posts[index].reject(Object.assign(Error('Fictional POST failure'),{status:503,code:'FICTIONAL_POST_ERROR'}));
window.rejectPostNetwork=index=>window.posts[index].reject(Object.assign(Error('Fictional transport failure'),{code:'NETWORK_ERROR'}));
window.snapshot=()=>structuredClone({...window.__checkoutProbe,...window.__redraftProbe});
window.clickText=text=>{const button=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===text);if(!button||button.disabled)throw Error('Unavailable button '+text);button.click()};
function Fixture(){const[state,setState]=useState({...structuredClone(defaultState),orders:[]});const[c,setConfig]=useState(config);window.changeScope=patch=>{const next={...window.fixtureConfig,...patch};acknowledge(next);window.fixtureConfig=next;setConfig(next)};window.changeVisit=()=>{window.serverCheckout=null;window.changeScope({visitContextId:'v1_'+'b'.repeat(64)})};return <CustomerScreen state={state} updateState={setState} deviceId='customer-03' orderClient={client} customerDeviceConfig={c} onCustomerDeviceConfigChange={setConfig}/>}
createRoot(document.getElementById('root')).render(<Fixture/>);window.__fixtureReady=true;`;

let server, browser, cdp, origin, session = 0;
const browserErrors = [], sockets = new Set();
const delay = ms => new Promise(r => setTimeout(r, ms));
async function connect(url) {
  const socket = new WebSocket(url); await new Promise((r,j) => { socket.addEventListener('open',r,{once:true}); socket.addEventListener('error',j,{once:true}); });
  let next=0; const pending=new Map();
  socket.addEventListener('message',event => {const message=JSON.parse(event.data);if(message.id){const p=pending.get(message.id);pending.delete(message.id);message.error?p?.reject(Error(message.error.message)):p?.resolve(message.result);}else if(message.method==='Runtime.exceptionThrown')browserErrors.push(message.params.exceptionDetails.exception?.description||message.params.exceptionDetails.text);});
  const send=(method,params={})=>new Promise((r,j)=>{const id=++next;pending.set(id,{resolve:r,reject:j});socket.send(JSON.stringify({id,method,params}));});
  const evaluate=async expression=>{const result=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result.value;};
  const wait=async expression=>{for(let i=0;i<150;i++){if(await evaluate('Boolean('+expression+')'))return;await delay(20);}throw Error('UI timeout: '+expression+'; '+await evaluate('JSON.stringify(window.__checkoutProbe)'));};
  return {send,evaluate,wait,close:()=>socket.close()};
}

before(async () => {
  const {build}=await import(pathToFileURL(require.resolve('vite')).href);
  const entry=join(output,'entry.jsx');await writeFile(entry,fixture);
  await writeFile(join(output,'index.html'),'<meta charset="utf-8"><div id="root"></div><script type="module" src="./entry.jsx"></script>');
  await build({root:output,configFile:false,envFile:false,publicDir:false,logLevel:'error',resolve:{dedupe:['react','react-dom'],alias:{react:dirname(require.resolve('react/package.json')),'react-dom':dirname(require.resolve('react-dom/package.json'))}},build:{outDir:join(output,'dist'),emptyOutDir:false,rollupOptions:{input:join(output,'index.html')}},plugins:[{name:'observe-real-customer-checkout',transform(source,id){if(/[\\/]src[\\/]App\.jsx$/.test(id)){const marker='function CustomerCheckoutModal({ checkoutState, checkoutRequestError, receiptRequested, onReceiptChange, onRequest, onRetry, onResetCancelled, onClose, submitting }) {';assert.ok(source.includes(marker));const screen='function CustomerScreen({ state, updateState, deviceId, orderClient, customerDeviceConfig, onCustomerDeviceConfigChange, theme = CUSTOMER_TEST_THEME }) {';assert.ok(source.includes(screen));source=source.replace(screen,screen+'\n  useLayoutEffect(() => { window.__redraftProbe = {draft: typeof checkoutRedraftRef === "undefined" ? null : checkoutRedraftRef.current, observation: checkoutObservationRef.current, requestId: checkoutRequestIdRef.current, failure: checkoutRequestFailure, visitContextId: checkoutVisitContextId}; });');return source.replace(marker,marker+'\nwindow.__checkoutProbe = {checkoutState, checkoutRequestError, submitting, receiptRequested};')+'\nexport { CustomerScreen, defaultState };';}}}]});
  const root=join(output,'dist');server=http.createServer(async(req,res)=>{try{const relative=decodeURIComponent(new URL(req.url,'http://fixture.invalid').pathname).slice(1)||'index.html';const file=resolve(root,relative);if(!file.startsWith(root+'/')&&!file.startsWith(root+'\\'))throw Error('path');const body=await readFile(file);res.setHeader('Content-Type',({'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.ttf':'font/ttf','.png':'image/png'})[extname(file)]||'application/octet-stream');res.end(body);}catch{res.statusCode=404;res.end();}});
  server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+server.address().port;
  const executable=['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);assert.ok(executable,'A local headless browser is required');
  const profile=join(output,'browser-profile');await mkdir(profile,{recursive:true});
  browser=spawn(executable,['--headless=new','--mute-audio','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-sync','--disable-component-update','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{windowsHide:true,stdio:'ignore'});
  let port;for(let i=0;i<150;i++){try{port=Number((await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]);break;}catch{await delay(20);}}assert.ok(port,'Headless browser did not expose its private debugger');
  const pages=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();cdp=await connect(pages.find(p=>p.type==='page').webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');await cdp.send('Page.enable');await cdp.send('Network.enable');await cdp.send('Network.setBlockedURLs',{urls:['https://*','http://localhost:*','http://192.168.*','http://10.*','http://172.*','http://127.0.0.1:25173/*','http://127.0.0.1:28787/*']});await cdp.send('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:1,mobile:false});await cdp.send('Emulation.setPageScaleFactor',{pageScaleFactor:1});
  await writeFile(join(output,'isolation.json'),JSON.stringify({origin,browserPid:browser.pid,profile,viewport:{width:1280,height:800},productionApiBlocked:true,client:'fictional deferred promises',computerUse:false},null,2));
});

after(async () => {
  if(cdp){try{await Promise.race([cdp.send('Browser.close'),delay(1500)]);}catch{}cdp.close();}
  if(browser&&browser.exitCode===null){await Promise.race([new Promise(r=>browser.once('exit',r)),delay(1500)]);if(browser.exitCode===null)browser.kill();}
  if(server){for(const socket of sockets)socket.destroy();await new Promise(r=>server.close(r));}
  await writeFile(join(output,'browser-errors.json'),JSON.stringify(browserErrors,null,2));
  assert.deepEqual(browserErrors,[],'The real React component must not raise browser exceptions');
});

beforeEach(async () => {
  const id=++session;await cdp.send('Page.navigate',{url:origin+'/?case='+id});await cdp.wait('window.__fixtureReady && window.fixtureCase === '+id);await cdp.wait("[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='お会計')");await cdp.evaluate("window.clickText('お会計')");await cdp.wait('window.__checkoutProbe?.checkoutState.loaded && !window.__checkoutProbe.checkoutState.loading');
});

async function begin(){await cdp.evaluate("window.clickText('お会計を依頼する')");await cdp.wait('window.posts.length === 1 && window.__checkoutProbe.submitting');}
async function readState(status,version=2){await cdp.evaluate(`window.emitCheckout({checkoutRequestId:window.posts[0].request.checkoutRequestId,status:${JSON.stringify(status)},version:${version},receiptRequested:false,grandTotalYen:1234})`);await cdp.wait(`window.__checkoutProbe.checkoutState.checkout?.status === ${JSON.stringify(status)}`);}
async function settle(){await cdp.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');}

// Real CustomerScreen and buttons; all transport calls below stay in this fictional fixture.
const OLD_ID = '00000000-0000-4000-8000-000000000501';
const token = letter => 'v1_' + letter.repeat(64);
const state = () => cdp.evaluate('window.snapshot()');
const input = () => cdp.evaluate("Boolean(document.querySelector('.checkout-customer-request'))");
async function click(text) { await cdp.evaluate('window.clickText(' + JSON.stringify(text) + ')'); await settle(); }
async function showCancelled(id = OLD_ID) {
  await cdp.evaluate('window.emitCheckout(' + JSON.stringify({checkoutRequestId:id,status:'cancelled',version:3,receiptRequested:false,grandTotalYen:null}) + ')');
  await cdp.wait("window.__checkoutProbe.checkoutState.checkout?.status === 'cancelled'"); await settle();
}
async function draft() { await showCancelled(); await click('新しく会計を依頼する'); }
async function receiptOn() { await cdp.evaluate("document.querySelector('.checkout-receipt-toggle').click()"); await settle(); }
async function oldGet() { const n=await cdp.evaluate('window.getCalls'); await cdp.evaluate("window.emitCheckout(window.serverCheckout === null ? null : {...window.serverCheckout})"); await cdp.wait('window.getCalls > '+n); await settle(); }
async function close() { await cdp.evaluate("document.querySelector('[role=dialog] [aria-label=閉じる]').click()"); await settle(); }
async function send() { await click('お会計を依頼する'); await cdp.wait('window.__checkoutProbe.submitting'); }
async function assertInput(receipt=false) {
  assert.equal(await input(), true);
  const s=await state(); assert.equal(s.checkoutState.checkout,null);assert.equal(s.receiptRequested,receipt);
}
test('redraft preserves zero-yen input and receipt through post-reset reconnect GET without POST', async () => {
  await draft(); await assertInput(); await receiptOn();
  const n=await cdp.evaluate('window.getCalls'); await cdp.evaluate('window.reconnectCheckout()');await cdp.wait('window.getCalls > '+n);await settle();
  await assertInput(true); const s=await state();assert.equal(s.observation.checkout.checkoutRequestId,OLD_ID);assert.equal(s.observation.checkout.status,'cancelled');
  assert.equal(s.requestId,null);assert.equal(s.checkoutRequestError,false);assert.equal(s.submitting,false);
  assert.equal(await cdp.evaluate("window.transportCalls.filter(c=>c.method==='POST').length"),0);
  const capture=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile(join(output,'draft-after-old-get-1280x800.png'),Buffer.from(capture.data,'base64'));
});
test('redraft keeps receipt and input through same old cancellation invalidations and null reads', async () => {
  await draft();await receiptOn();await oldGet();await assertInput(true);
  await cdp.evaluate('window.serverCheckout=null');await oldGet();await assertInput(true);
  await showOldAgain();await assertInput(true);assert.equal(await cdp.evaluate('window.posts.length'),0);
});
async function showOldAgain(){await cdp.evaluate('window.emitCheckout('+JSON.stringify({checkoutRequestId:OLD_ID,status:'cancelled',version:3,receiptRequested:false})+')');await settle();}
test('explicit redraft send alone creates a new ID once and old GET cannot unlock its busy input', async () => {
  await draft();await receiptOn();await oldGet();await send();
  const id=await cdp.evaluate('window.posts[0].request.checkoutRequestId');assert.notEqual(id,OLD_ID);assert.equal(await cdp.evaluate('window.posts.length'),1);
  await oldGet();await assertInput(true);assert.equal((await state()).submitting,true);
  assert.equal(await cdp.evaluate("document.querySelector('.checkout-modal__actions .button--primary').disabled"),true);
  await cdp.evaluate('window.resolvePost(0)');await settle();
  const s=await state();assert.equal(s.checkoutState.checkout.checkoutRequestId,id);assert.equal(s.checkoutState.checkout.status,'requested');assert.equal(s.checkoutState.checkout.version,1);
  assert.equal(s.draft,null);assert.equal(s.submitting,false);assert.equal(await cdp.evaluate('window.acceptedIds.size'),1);
});
for(const order of ['failure-before-old-GET','old-GET-before-failure']) {
  test('redraft send failure retains input receipt and same retry ID: '+order, async () => {
    await draft();await receiptOn();await send();const id=await cdp.evaluate('window.posts[0].request.checkoutRequestId');
    if(order==='old-GET-before-failure')await oldGet();
    await cdp.evaluate('window.rejectPostNetwork(0)');await settle();
    if(order==='failure-before-old-GET')await oldGet();
    await assertInput(true);let s=await state();assert.equal(s.checkoutRequestError,true);assert.equal(s.submitting,false);assert.equal(s.requestId,id);
    assert.equal(await cdp.evaluate("document.body.textContent.includes('会計依頼を送信できませんでした')"),true);
    await send();assert.equal(await cdp.evaluate('window.posts[1].request.checkoutRequestId'),id);assert.equal(await cdp.evaluate('window.posts[1].request.receiptRequested'),true);
    await cdp.evaluate('window.resolvePost(1)');await settle();s=await state();assert.equal(s.checkoutState.checkout.checkoutRequestId,id);assert.equal(s.checkoutRequestError,false);assert.equal(s.draft,null);assert.equal(await cdp.evaluate('window.acceptedIds.size'),1);
  });
}
for(const status of ['requested','ready','cancelled']) {
  test('another checkout ID is not hidden by redraft: '+status, async () => {
    await draft();const other='00000000-0000-4000-8000-000000000502';
    await cdp.evaluate('window.emitCheckout('+JSON.stringify({checkoutRequestId:other,status,version:1,receiptRequested:true,grandTotalYen:0})+')');await settle();
    const s=await state();assert.equal(s.checkoutState.checkout.checkoutRequestId,other);assert.equal(s.checkoutState.checkout.status,status);assert.equal(s.draft,null);
    assert.equal(await cdp.evaluate('window.posts.length'),0);
  });
}
for(const response of ['success','failure']) {
  test('pre-reset pending GET is still ignored after reset: '+response, async () => {
    await showCancelled();await cdp.evaluate('window.deferGets=true');await oldGet();await cdp.wait('window.getRequests.length === 1');
    await click('新しく会計を依頼する');await cdp.evaluate('window.deferGets=false;window.'+(response==='success'?'resolveGet':'rejectGet')+'(0)');await settle();
    await assertInput();const s=await state();assert.equal(s.checkoutState.error,false);assert.equal(s.checkoutRequestError,false);assert.equal(await cdp.evaluate('window.posts.length'),0);
  });
}
test('visit A to B to A clears redraft instead of masking the old cancellation in the new generation', async () => {
  await draft();await cdp.evaluate('window.serverCheckout=null;window.changeScope({visitContextId:'+JSON.stringify(token('b'))+'})');await settle();assert.equal((await state()).draft,null);
  await cdp.evaluate('window.serverCheckout='+JSON.stringify({checkoutRequestId:OLD_ID,status:'cancelled',version:3,receiptRequested:false})+';window.changeScope({visitContextId:'+JSON.stringify(token('a'))+'})');await settle();await click('お会計');
  await cdp.wait("window.__checkoutProbe.checkoutState.checkout?.status === 'cancelled'");assert.equal((await state()).draft,null);
});
for(const patch of [{tableId:2},{deviceId:'fictional-other-device'}]) {
  test('same-token assignment identity change clears redraft: '+Object.keys(patch)[0], async () => {
    await draft();await cdp.evaluate('window.changeScope('+JSON.stringify(patch)+')');await settle();
    await cdp.wait("window.__checkoutProbe.checkoutState.checkout?.status === 'cancelled'");
    assert.equal((await state()).draft,null);assert.equal(await cdp.evaluate('window.posts.length'),0);
  });
}
test('closing the modal ends only redraft mode and reopening reads the server cancellation', async () => {
  await draft();await receiptOn();await close();await click('お会計');await cdp.wait("window.__checkoutProbe.checkoutState.checkout?.status === 'cancelled'");
  const s=await state();assert.equal(s.draft,null);assert.equal(s.requestId,null);assert.equal(s.checkoutRequestError,false);assert.equal(await cdp.evaluate('window.posts.length'),0);
});
test('closing after a send failure retains failure and retry ID when reopened GET is null', async () => {
  await draft();await receiptOn();await send();const id=await cdp.evaluate('window.posts[0].request.checkoutRequestId');await cdp.evaluate('window.rejectPostNetwork(0)');await settle();
  await close();await cdp.evaluate('window.serverCheckout=null');await click('お会計');await settle();
  await assertInput(true);const s=await state();assert.equal(s.draft,null);assert.equal(s.requestId,id);assert.equal(s.checkoutRequestError,true);
  await send();assert.equal(await cdp.evaluate('window.posts[1].request.checkoutRequestId'),id);await cdp.evaluate('window.resolvePost(1)');await settle();
});
test('GET diagnostics stay effective and recovery of old cancellation restores draft input without wiping receipt', async () => {
  await draft();await receiptOn();await cdp.evaluate('window.failGet()');await cdp.wait('window.__checkoutProbe.checkoutState.error');
  assert.equal((await state()).checkoutState.errorDetails.code,'FICTIONAL_GET_ERROR');await click('再試行');await assertInput(true);assert.equal((await state()).checkoutState.error,false);
});
test('GET confirmation of failed new request clears redraft and failure before later cancellation', async () => {
  await draft();await send();const id=await cdp.evaluate('window.posts[0].request.checkoutRequestId');await cdp.evaluate('window.rejectPostNetwork(0)');await settle();
  await cdp.evaluate('window.emitCheckout('+JSON.stringify({checkoutRequestId:id,status:'ready',version:2,receiptRequested:false,grandTotalYen:0})+')');await settle();
  let s=await state();assert.equal(s.draft,null);assert.equal(s.checkoutState.checkout.checkoutRequestId,id);assert.equal(s.checkoutRequestError,false);
  await cdp.evaluate('window.emitCheckout('+JSON.stringify({checkoutRequestId:id,status:'cancelled',version:3,receiptRequested:false})+')');await settle();s=await state();assert.equal(s.checkoutState.checkout.status,'cancelled');assert.equal(s.checkoutRequestError,false);
});
