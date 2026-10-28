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
const output = process.env.WARUN_CHECKOUT_TEST_OUTPUT || await mkdtemp(join(tmpdir(), 'warun-checkout-post-ui-'));
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
acknowledge(config);window.fixtureConfig=config;window.serverCheckout=null;window.posts=[];window.getCalls=0;const invalidations=new Set(),reconnects=new Set();
const client={mode:'api',getThemeConfig:async()=>({theme:'standard'}),getOrderStartNotice:async()=>({heading:'Fictional fixture notice',body:'Isolated checkout test'}),getMenu:async()=>({categories:[],items:[]}),getHistory:async()=>[],getDeviceConfig:async()=>window.fixtureConfig,
subscribe:()=>()=>{},subscribeInvalidations:(callback,options={})=>{invalidations.add(callback);if(options.onReconnect)reconnects.add(options.onReconnect);return()=>{invalidations.delete(callback);reconnects.delete(options.onReconnect)}},
getCheckout:()=>{window.getCalls++;if(window.nextGetError){const e=window.nextGetError;window.nextGetError=null;return Promise.reject(Object.assign(Error('Fictional GET failure'),e))}return Promise.resolve(structuredClone(window.serverCheckout))},
requestCheckout:request=>new Promise((resolve,reject)=>window.posts.push({request:structuredClone(request),resolve,reject}))};
window.emitCheckout=checkout=>{window.serverCheckout=checkout;for(const callback of invalidations)callback({type:'checkout.ready',payload:{resource:'checkout'}})};
window.reconnectCheckout=async()=>{for(const callback of reconnects)await callback('reconnected')};
window.failGet=()=>{window.nextGetError={status:503,stage:'http',code:'FICTIONAL_GET_ERROR'};for(const callback of invalidations)callback({type:'checkout.ready',payload:{resource:'checkout'}})};
window.resolvePost=(index,extra={})=>window.posts[index].resolve({checkoutRequestId:window.posts[index].request.checkoutRequestId,status:'requested',receiptRequested:false,version:1,...extra});
window.rejectPost=index=>window.posts[index].reject(Object.assign(Error('Fictional POST failure'),{status:503,code:'FICTIONAL_POST_ERROR'}));
window.rejectPostNetwork=index=>window.posts[index].reject(Object.assign(Error('Fictional transport failure'),{code:'NETWORK_ERROR'}));
window.snapshot=()=>structuredClone(window.__checkoutProbe);
window.clickText=text=>{const button=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===text);if(!button||button.disabled)throw Error('Unavailable button '+text);button.click()};
function Fixture(){const[state,setState]=useState({...structuredClone(defaultState),orders:[]});const[c,setConfig]=useState(config);window.changeVisit=()=>{const next={...config,visitContextId:'v1_'+'b'.repeat(64)};acknowledge(next);window.fixtureConfig=next;window.serverCheckout=null;setConfig(next)};return <CustomerScreen state={state} updateState={setState} deviceId='customer-03' orderClient={client} customerDeviceConfig={c} onCustomerDeviceConfigChange={setConfig}/>}
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
  await build({root:output,configFile:false,envFile:false,publicDir:false,logLevel:'error',resolve:{dedupe:['react','react-dom'],alias:{react:dirname(require.resolve('react/package.json')),'react-dom':dirname(require.resolve('react-dom/package.json'))}},build:{outDir:join(output,'dist'),emptyOutDir:false,rollupOptions:{input:join(output,'index.html')}},plugins:[{name:'observe-real-customer-checkout',transform(source,id){if(/[\\/]src[\\/]App\.jsx$/.test(id)){const marker='function CustomerCheckoutModal({ checkoutState, checkoutRequestError, receiptRequested, onReceiptChange, onRequest, onRetry, onResetCancelled, onClose, submitting }) {';assert.ok(source.includes(marker));return source.replace(marker,marker+'\nwindow.__checkoutProbe = {checkoutState, checkoutRequestError, submitting, receiptRequested};')+'\nexport { CustomerScreen, defaultState };';}}}]});
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

test('late POST success cannot replace a ready state applied through SSE-triggered GET', async () => {
  await begin(); await readState('ready');
  await cdp.evaluate('window.resolvePost(0)'); await settle();
  const s = await cdp.evaluate('window.snapshot()');
  assert.equal(s.checkoutState.checkout.status, 'ready');
  assert.equal(s.checkoutState.checkout.version, 2);
  assert.equal(s.submitting, false);
  const capture = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(join(output, 'ready-after-late-post-1280x800.png'), Buffer.from(capture.data, 'base64'));
});
test('late POST failure cannot mark an already ready checkout as request failure',async()=>{await begin();await readState('ready');await cdp.evaluate('window.rejectPost(0)');await settle();const s=await cdp.evaluate('window.snapshot()');assert.equal(s.checkoutState.checkout.status,'ready');assert.equal(s.checkoutRequestError,false);assert.equal(s.submitting,false);});
test('current POST failure is retained beneath newer GET diagnostics until a null read reveals it', async () => {
  await begin(); await cdp.evaluate('window.failGet()');
  await cdp.wait('window.__checkoutProbe.checkoutState.error');
  await cdp.evaluate('window.rejectPost(0)'); await settle();
  let s = await cdp.evaluate('window.snapshot()');
  assert.equal(s.checkoutState.error, true);
  assert.equal(s.checkoutState.errorDetails.code, 'FICTIONAL_GET_ERROR');
  assert.equal(s.checkoutRequestError, true);
  assert.equal(s.submitting, false);
  assert.equal(await cdp.evaluate("[...document.querySelectorAll('[role=alert]')].some(e=>e.textContent.includes('会計状態を取得できませんでした'))"), true);
  assert.equal(await cdp.evaluate("document.body.textContent.includes('会計依頼を送信できませんでした')"), false);
  await cdp.evaluate("window.clickText('再試行')");
  await cdp.wait('!window.__checkoutProbe.checkoutState.error && !window.__checkoutProbe.checkoutState.loading');
  s = await cdp.evaluate('window.snapshot()');
  assert.equal(s.checkoutState.checkout, null);
  assert.equal(await cdp.evaluate("[...document.querySelectorAll('[role=alert]')].some(e=>e.textContent.includes('会計依頼を送信できませんでした'))"), true);
});
test('a valid current POST response is applied normally',async()=>{await begin();await cdp.evaluate('window.resolvePost(0)');await settle();const s=await cdp.evaluate('window.snapshot()');assert.equal(s.checkoutState.checkout.status,'requested');assert.equal(s.checkoutState.checkout.version,1);assert.equal(s.checkoutRequestError,false);assert.equal(s.submitting,false);});
test('a current POST failure still reports failure and releases its own operation',async()=>{await begin();await cdp.evaluate('window.rejectPost(0)');await settle();const s=await cdp.evaluate('window.snapshot()');assert.equal(s.checkoutRequestError,true);assert.equal(s.checkoutState.loading,false);assert.equal(s.submitting,false);});
test('newer cancellation remains valid and a fresh request is not blocked by the previous higher version',async()=>{await begin();await readState('ready');await readState('cancelled',3);await cdp.evaluate('window.resolvePost(0)');await settle();assert.equal((await cdp.evaluate('window.snapshot()')).checkoutState.checkout.status,'cancelled');await cdp.evaluate("window.clickText('新しく会計を依頼する')");await settle();await cdp.evaluate("window.clickText('お会計を依頼する')");await cdp.wait('window.posts.length===2');await cdp.evaluate('window.emitCheckout({...window.serverCheckout})');await settle();await cdp.evaluate('window.resolvePost(1)');await settle();const s=await cdp.evaluate('window.snapshot()');assert.equal(s.checkoutState.checkout.status,'requested');assert.equal(s.checkoutState.checkout.version,1);assert.equal(s.checkoutState.checkout.checkoutRequestId,await cdp.evaluate('window.posts[1].request.checkoutRequestId'));});
test('an old finally cannot unlock a newer request after explicit cancellation and re-request',async()=>{await begin();await readState('cancelled',3);await cdp.evaluate("window.clickText('新しく会計を依頼する')");await settle();await cdp.evaluate("window.clickText('お会計を依頼する')");await cdp.wait('window.posts.length===2 && window.__checkoutProbe.submitting');await cdp.evaluate('window.rejectPost(0)');await settle();let s=await cdp.evaluate('window.snapshot()');assert.equal(s.submitting,true);assert.equal(s.checkoutRequestError,false);await cdp.evaluate('window.resolvePost(1)');await settle();s=await cdp.evaluate('window.snapshot()');assert.equal(s.submitting,false);assert.equal(s.checkoutState.checkout.checkoutRequestId,await cdp.evaluate('window.posts[1].request.checkoutRequestId'));});
test('a response from a previous visit cannot populate the new visit',async()=>{await begin();await cdp.evaluate('window.changeVisit()');await settle();await cdp.evaluate('window.resolvePost(0)');await settle();await cdp.evaluate("window.clickText('お会計')");await cdp.wait('window.__checkoutProbe.checkoutState.visitContextId.endsWith("b".repeat(64))');const s=await cdp.evaluate('window.snapshot()');assert.equal(s.checkoutState.checkout,null);assert.equal(s.checkoutRequestError,false);assert.equal(s.submitting,false);});

test('another checkout ID learned by GET cannot be replaced by the older POST', async () => {
  await begin();
  await cdp.evaluate("window.emitCheckout({checkoutRequestId:'fictional-other-checkout',status:'ready',version:2,receiptRequested:false,grandTotalYen:5678})");
  await cdp.wait("window.__checkoutProbe.checkoutState.checkout?.checkoutRequestId === 'fictional-other-checkout'");
  await cdp.evaluate('window.resolvePost(0)'); await settle();
  const s = await cdp.evaluate('window.snapshot()');
  assert.equal(s.checkoutState.checkout.checkoutRequestId, 'fictional-other-checkout');
  assert.equal(s.checkoutState.checkout.grandTotalYen, 5678);
});

test('an equal-version delayed POST cannot clear diagnostics from a newer read', async () => {
  await begin(); await readState('requested', 1);
  await cdp.evaluate('window.failGet()'); await cdp.wait('window.__checkoutProbe.checkoutState.error');
  await cdp.evaluate('window.resolvePost(0)'); await settle();
  const s = await cdp.evaluate('window.snapshot()');
  assert.equal(s.checkoutState.error, true);
  assert.equal(s.checkoutState.errorDetails.code, 'FICTIONAL_GET_ERROR');
  assert.equal(s.submitting, false);
});

test('a newer read error does not erase the known version used to reject an old POST', async () => {
  await begin(); await readState('ready', 2);
  await cdp.evaluate('window.failGet()'); await cdp.wait('window.__checkoutProbe.checkoutState.error');
  await cdp.evaluate('window.resolvePost(0)'); await settle();
  const s = await cdp.evaluate('window.snapshot()');
  assert.equal(s.checkoutState.error, true);
  assert.equal(s.checkoutState.errorDetails.code, 'FICTIONAL_GET_ERROR');
  assert.equal(s.checkoutRequestError, false);
});

test('a null GET during the current POST still exposes failure and permits an idempotent retry', async () => {
  await begin();
  const getCalls = await cdp.evaluate('window.getCalls');
  await cdp.evaluate('window.serverCheckout=null; window.reconnectCheckout()');
  await cdp.wait(`window.getCalls > ${getCalls} && !window.__checkoutProbe.checkoutState.loading && window.__checkoutProbe.checkoutState.checkout === null`);
  await cdp.evaluate('window.rejectPost(0)'); await settle();
  const s = await cdp.evaluate('window.snapshot()');
  assert.equal(s.checkoutRequestError, true);
  assert.equal(s.submitting, false);
  assert.equal(s.checkoutState.error, false);
  assert.equal(s.checkoutState.checkout, null);
  assert.equal(await cdp.evaluate("[...document.querySelectorAll('[role=alert]')].some(e=>e.textContent.includes('会計依頼を送信できませんでした'))"), true);
  assert.equal(await cdp.evaluate("[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='お会計を依頼する' && !b.disabled)"), true);
  const capture = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(join(output, 'post-failure-after-null-1280x800.png'), Buffer.from(capture.data, 'base64'));
  await cdp.evaluate("window.clickText('お会計を依頼する')");
  await cdp.wait('window.posts.length === 2 && window.__checkoutProbe.submitting');
  assert.equal(await cdp.evaluate('window.posts[1].request.checkoutRequestId === window.posts[0].request.checkoutRequestId'), true);
  await cdp.evaluate('window.resolvePost(1)'); await settle();
  const retried = await cdp.evaluate('window.snapshot()');
  assert.equal(retried.checkoutState.checkout.status, 'requested');
  assert.equal(retried.checkoutRequestError, false);
  assert.equal(retried.submitting, false);
});

test('a null reconnect GET does not suppress a valid current POST success', async () => {
  await begin();
  const getCalls = await cdp.evaluate('window.getCalls');
  await cdp.evaluate('window.serverCheckout=null; window.reconnectCheckout()');
  await cdp.wait(`window.getCalls > ${getCalls} && !window.__checkoutProbe.checkoutState.loading`);
  await cdp.evaluate('window.resolvePost(0)'); await settle();
  const s = await cdp.evaluate('window.snapshot()');
  assert.equal(s.checkoutState.checkout.status, 'requested');
  assert.equal(s.checkoutState.checkout.version, 1);
  assert.equal(s.checkoutRequestError, false);
  assert.equal(s.submitting, false);
});

test('a POST failure after ready and a GET error preserves the newer diagnostic without a request-failure notice', async () => {
  await begin(); await readState('ready', 2);
  await cdp.evaluate('window.failGet()'); await cdp.wait('window.__checkoutProbe.checkoutState.error');
  await cdp.evaluate('window.rejectPost(0)'); await settle();
  const s = await cdp.evaluate('window.snapshot()');
  assert.equal(s.checkoutState.error, true);
  assert.equal(s.checkoutState.errorDetails.code, 'FICTIONAL_GET_ERROR');
  assert.equal(s.checkoutRequestError, false);
  assert.equal(s.submitting, false);
});

test('a prior-visit POST failure cannot enter the current visit', async () => {
  await begin(); await cdp.evaluate('window.changeVisit()'); await settle();
  await cdp.evaluate("window.clickText('お会計')");
  await cdp.wait('window.__checkoutProbe.checkoutState.loaded && window.__checkoutProbe.checkoutState.visitContextId.endsWith("b".repeat(64))');
  await cdp.evaluate('window.rejectPost(0)'); await settle();
  const s = await cdp.evaluate('window.snapshot()');
  assert.equal(s.checkoutState.checkout, null);
  assert.equal(s.checkoutRequestError, false);
  assert.equal(s.checkoutState.error, false);
  assert.equal(s.submitting, false);
});

test('after cancellation a null GET cannot hide the new POST failure, or let the old finally unlock it', async () => {
  await begin(); await readState('cancelled', 3);
  await cdp.evaluate("window.clickText('新しく会計を依頼する')"); await settle();
  await cdp.evaluate("window.clickText('お会計を依頼する')");
  await cdp.wait('window.posts.length === 2 && window.__checkoutProbe.submitting');
  const getCalls = await cdp.evaluate('window.getCalls');
  await cdp.evaluate('window.serverCheckout=null; window.reconnectCheckout()');
  await cdp.wait(`window.getCalls > ${getCalls} && !window.__checkoutProbe.checkoutState.loading && window.__checkoutProbe.checkoutState.checkout === null`);
  await cdp.evaluate('window.rejectPost(0)'); await settle();
  let s = await cdp.evaluate('window.snapshot()');
  assert.equal(s.submitting, true);
  assert.equal(s.checkoutRequestError, false);
  await cdp.evaluate('window.rejectPost(1)'); await settle();
  s = await cdp.evaluate('window.snapshot()');
  assert.equal(s.submitting, false);
  assert.equal(s.checkoutRequestError, true);
  assert.equal(s.checkoutState.checkout, null);
  assert.equal(await cdp.evaluate("[...document.querySelectorAll('[role=alert]')].some(e=>e.textContent.includes('会計依頼を送信できませんでした'))"), true);
});

test('a GET of the previous cancelled request keeps its state without hiding the new request failure', async () => {
  await begin(); await readState('cancelled', 3);
  const previousId = await cdp.evaluate('window.posts[0].request.checkoutRequestId');
  await cdp.evaluate("window.clickText('新しく会計を依頼する')"); await settle();
  await cdp.evaluate("window.clickText('お会計を依頼する')");
  await cdp.wait('window.posts.length === 2 && window.__checkoutProbe.submitting');
  const getCalls = await cdp.evaluate('window.getCalls');
  await cdp.evaluate('window.reconnectCheckout()');
  await cdp.wait(`window.getCalls > ${getCalls} && window.__checkoutProbe.checkoutState.checkout?.status === 'cancelled'`);
  await cdp.evaluate('window.rejectPost(1)'); await settle();
  const s = await cdp.evaluate('window.snapshot()');
  assert.equal(s.checkoutState.checkout.checkoutRequestId, previousId);
  assert.equal(s.checkoutState.checkout.status, 'cancelled');
  assert.equal(s.checkoutRequestError, true);
  assert.equal(s.submitting, false);
  assert.equal(await cdp.evaluate("[...document.querySelectorAll('[role=alert]')].some(e=>e.textContent.includes('会計依頼を送信できませんでした'))"), true);
  const capture = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(join(output, 'post-failure-with-previous-cancellation-1280x800.png'), Buffer.from(capture.data, 'base64'));
  await cdp.evaluate('window.resolvePost(0)'); await settle();
  assert.equal((await cdp.evaluate('window.snapshot()')).checkoutRequestError, true);
});

for (const status of ['requested', 'ready']) {
  test(`confirmed ${status} GET clears the same request failure before cancellation`, async () => {
    await begin(); await cdp.evaluate('window.rejectPostNetwork(0)'); await settle();
    assert.equal((await cdp.evaluate('window.snapshot()')).checkoutRequestError, true);
    await readState(status, status === 'ready' ? 2 : 1);
    assert.equal((await cdp.evaluate('window.snapshot()')).checkoutRequestError, false);
    await readState('cancelled', 3);
    const s = await cdp.evaluate('window.snapshot()');
    assert.equal(s.checkoutState.checkout.status, 'cancelled');
    assert.equal(s.checkoutRequestError, false);
    assert.equal(s.submitting, false);
    assert.equal(await cdp.evaluate("document.body.textContent.includes('会計依頼を送信できませんでした')"), false);
    if (status === 'ready') {
      const capture = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      await writeFile(join(output, 'confirmed-then-cancelled-1280x800.png'), Buffer.from(capture.data, 'base64'));
    }
  });

  test(`a ${status} GET before a late POST failure keeps confirmation through cancellation`, async () => {
    await begin(); await readState(status, status === 'ready' ? 2 : 1);
    await cdp.evaluate('window.rejectPostNetwork(0)'); await settle();
    assert.equal((await cdp.evaluate('window.snapshot()')).checkoutRequestError, false);
    await readState('cancelled', 3);
    const s = await cdp.evaluate('window.snapshot()');
    assert.equal(s.checkoutRequestError, false);
    assert.equal(s.submitting, false);
    assert.equal(await cdp.evaluate("document.body.textContent.includes('会計依頼を送信できませんでした')"), false);
  });
}

test('a later GET of cancelled A does not clear the failure already recorded for request B', async () => {
  await begin(); await readState('cancelled', 3);
  const previousId = await cdp.evaluate('window.posts[0].request.checkoutRequestId');
  await cdp.evaluate("window.clickText('新しく会計を依頼する')"); await settle();
  await cdp.evaluate("window.clickText('お会計を依頼する')");
  await cdp.wait('window.posts.length === 2 && window.__checkoutProbe.submitting');
  await cdp.evaluate('window.rejectPost(1)'); await settle();
  assert.equal((await cdp.evaluate('window.snapshot()')).checkoutRequestError, true);
  const getCalls = await cdp.evaluate('window.getCalls');
  await cdp.evaluate('window.reconnectCheckout()');
  await cdp.wait(`window.getCalls > ${getCalls} && window.__checkoutProbe.checkoutState.checkout?.status === 'cancelled'`);
  const s = await cdp.evaluate('window.snapshot()');
  assert.equal(s.checkoutState.checkout.checkoutRequestId, previousId);
  assert.equal(s.checkoutRequestError, true);
  assert.equal(s.submitting, false);
  assert.equal(await cdp.evaluate("document.body.textContent.includes('会計依頼を送信できませんでした')"), true);
});

test('a different new request confirmed by GET cannot inherit the older request failure', async () => {
  await begin(); await cdp.evaluate('window.rejectPost(0)'); await settle();
  assert.equal((await cdp.evaluate('window.snapshot()')).checkoutRequestError, true);
  await cdp.evaluate("window.emitCheckout({checkoutRequestId:'11111111-1111-4111-8111-111111111111',status:'requested',version:1,receiptRequested:false})");
  await cdp.wait("window.__checkoutProbe.checkoutState.checkout?.checkoutRequestId === '11111111-1111-4111-8111-111111111111'");
  assert.equal((await cdp.evaluate('window.snapshot()')).checkoutRequestError, false);
  await cdp.evaluate("window.emitCheckout({...window.serverCheckout,status:'cancelled',version:2})");
  await cdp.wait("window.__checkoutProbe.checkoutState.checkout?.status === 'cancelled'");
  assert.equal(await cdp.evaluate("document.body.textContent.includes('会計依頼を送信できませんでした')"), false);
});

test('a GET confirming the failed request already cancelled resolves its transport failure', async () => {
  await begin(); await cdp.evaluate('window.rejectPost(0)'); await settle();
  assert.equal((await cdp.evaluate('window.snapshot()')).checkoutRequestError, true);
  await readState('cancelled', 2);
  const s = await cdp.evaluate('window.snapshot()');
  assert.equal(s.checkoutRequestError, false);
  assert.equal(s.checkoutState.checkout.status, 'cancelled');
  assert.equal(await cdp.evaluate("document.body.textContent.includes('会計依頼を送信できませんでした')"), false);
});

test('closing and reopening a failed request with a null GET does not erase its unresolved failure', async () => {
  await begin(); await cdp.evaluate('window.rejectPost(0)'); await settle();
  await cdp.evaluate("window.clickText('キャンセル')"); await settle();
  const getCalls = await cdp.evaluate('window.getCalls');
  await cdp.evaluate("window.clickText('お会計')");
  await cdp.wait(`window.getCalls > ${getCalls} && !window.__checkoutProbe.checkoutState.loading`);
  const s = await cdp.evaluate('window.snapshot()');
  assert.equal(s.checkoutState.checkout, null);
  assert.equal(s.checkoutRequestError, true);
  assert.equal(await cdp.evaluate("document.body.textContent.includes('会計依頼を送信できませんでした')"), true);
});

test('a recorded failure cannot leak into a different visit', async () => {
  await begin(); await cdp.evaluate('window.rejectPost(0)'); await settle();
  assert.equal((await cdp.evaluate('window.snapshot()')).checkoutRequestError, true);
  await cdp.evaluate('window.changeVisit()'); await settle();
  await cdp.evaluate("window.clickText('お会計')");
  await cdp.wait('window.__checkoutProbe.checkoutState.loaded && window.__checkoutProbe.checkoutState.visitContextId.endsWith("b".repeat(64))');
  const s = await cdp.evaluate('window.snapshot()');
  assert.equal(s.checkoutRequestError, false);
  assert.equal(s.checkoutState.checkout, null);
  assert.equal(await cdp.evaluate("document.body.textContent.includes('会計依頼を送信できませんでした')"), false);
});
