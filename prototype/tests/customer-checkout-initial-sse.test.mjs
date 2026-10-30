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
const output = process.env.WARUN_INITIAL_SSE_TEST_OUTPUT || await mkdtemp(join(tmpdir(), 'warun-initial-sse-ui-'));
await mkdir(output, { recursive: true });
const fixture = String.raw`import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {CustomerScreen,defaultState} from '__APP_PATH__';
import {createCustomerOrderClient,createMemoryOutbox} from '__OUTBOX_PATH__';
import '__STYLE_PATH__';
window.fixtureCase=Number(new URL(location.href).searchParams.get('case'));
window.AudioContext=undefined;window.webkitAudioContext=undefined;
window.fetch=async url=>{if(String(url).endsWith('/v1/business-hours'))return new Response('{}',{status:200});throw Error('Rejected non-fixture fetch '+url)};
const initial={deviceId:'fictional-initial-sse-device',role:'customer',tableId:1,visitContextId:'v1_'+'a'.repeat(64)};
const acknowledge=c=>{if(c.visitContextId&&c.tableId)localStorage.setItem('warun:customer-order-start-notice:v1:'+encodeURIComponent(c.deviceId)+':'+c.tableId+':'+encodeURIComponent(c.visitContextId),'confirmed')};
acknowledge(initial);window.fixtureConfig=initial;window.gets=[];window.posts=[];window.streams=[];window.retryTimers=[];window.configGets=[];window.unexpected=[];window.configFailures=0;window.configTimers=[];
window.holdConfig=new URL(location.href).searchParams.has('holdConfig');window.configRequests=[];
window.setServerConfig=patch=>{window.fixtureConfig={...window.fixtureConfig,...patch};acknowledge(window.fixtureConfig)};
const realSetTimeout=window.setTimeout.bind(window),realClearTimeout=window.clearTimeout.bind(window);
window.setTimeout=(callback,delay,...args)=>{if(delay===3000||delay===10000){const t={callback:()=>callback(...args),delay,active:true,fixtureConfigTimer:true};window.configTimers.push(t);return t}return realSetTimeout(callback,delay,...args)};
window.clearTimeout=t=>{if(t?.fixtureConfigTimer)t.active=false;else realClearTimeout(t)};
window.retryConfig=()=>{const t=window.configTimers.find(t=>t.active&&t.delay===3000);if(!t)throw Error('No config retry');t.active=false;t.callback()};
const json=body=>new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}});
const env={WARUN_ORDER_MODE:'api',WARUN_API_BASE:'http://fictional.invalid/v1',WARUN_API_TOKEN:'fictional-isolated-sse-token',location:{origin:location.origin},navigator:{onLine:true},
setTimeout(callback,delay){const t={callback,delay,active:true};window.retryTimers.push(t);return t},clearTimeout(t){t.active=false}};
const fixtureFetch=(url,options={})=>{
 if(url.endsWith('/events'))return new Promise((resolve,reject)=>window.streams.push({resolve,reject,signal:options.signal,headers:options.headers}));
 if(url.endsWith('/device/config')){const snapshot=structuredClone(window.fixtureConfig);window.configGets.push(snapshot);if(window.holdConfig)return new Promise(resolve=>window.configRequests.push({snapshot,resolve}));if(window.configFailures-->0)return Promise.resolve(new Response('{}',{status:503}));return Promise.resolve(json(snapshot))}
 if(url.endsWith('/customer/checkout-requests/current'))return new Promise((resolve,reject)=>window.gets.push({resolve,reject,scope:structuredClone(window.fixtureConfig)}));
 if(url.endsWith('/customer/checkout-requests')&&options.method==='POST')return new Promise((resolve,reject)=>window.posts.push({request:JSON.parse(options.body),resolve,reject}));
 window.unexpected.push(url);throw Error('Unexpected isolated request '+url);
};
const client=createCustomerOrderClient({global:env,store:createMemoryOutbox(),autoRetry:false,fetchImpl:fixtureFetch});
Object.assign(client,{getThemeConfig:async()=>({theme:'standard'}),getOrderStartNotice:async()=>({heading:'架空の隔離確認',body:'初回SSE同期の検証用'}),getMenu:async()=>({categories:[],items:[]}),getHistory:async()=>[]});
window.openStream=i=>{const request=window.streams[i];const stream=new ReadableStream({start(controller){request.controller=controller;request.signal?.addEventListener('abort',()=>{try{controller.close()}catch{}},{once:true})}});request.resolve(new Response(stream,{status:200,headers:{'Content-Type':'text/event-stream','X-Event-Epoch':'00000000-0000-4000-8000-000000000001'}}))};
window.endStream=i=>window.streams[i].controller.close();
window.failStream=i=>window.streams[i].reject(Error('Fictional connection failure'));
window.denyStream=i=>window.streams[i].resolve(new Response('{}',{status:401}));
window.runRetry=()=>{const t=window.retryTimers.find(t=>t.active);if(!t)throw Error('No scheduled retry');t.active=false;t.callback()};
window.emitCheckout=(i,id=1)=>{const event={eventId:id,eventEpoch:'00000000-0000-4000-8000-000000000001',type:'checkout.ready',payload:{resource:'checkout',refreshRequired:true}};window.streams[i].controller.enqueue(new TextEncoder().encode('id: '+id+'\ndata: '+JSON.stringify(event)+'\n\n'))};
window.resolveGet=(i,checkout)=>window.gets[i].resolve(json({checkout}));
window.failGet=i=>window.gets[i].resolve(new Response(JSON.stringify({error:{code:'FICTIONAL_GET_ERROR'}}),{status:503}));
window.resolveConfig=(i,status=200)=>window.configRequests[i].resolve(status===200?json(window.configRequests[i].snapshot):new Response('{}',{status}));
window.resolvePost=i=>window.posts[i].resolve(new Response(JSON.stringify({checkoutRequestId:window.posts[i].request.checkoutRequestId,status:'requested',version:1,receiptRequested:false}),{status:201,headers:{'Idempotency-Result':'created'}}));
window.failPost=i=>window.posts[i].reject(Error('Fictional POST network failure'));
window.snapshot=()=>structuredClone(window.__checkoutProbe);
window.clickText=text=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===text);if(!b||b.disabled)throw Error('Unavailable button '+text);b.click()};
function Fixture(){const[state,setState]=useState({...structuredClone(defaultState),orders:[]});const[config,setConfig]=useState(initial);window.changeVisit=patch=>{const next={...window.fixtureConfig,...patch};window.fixtureConfig=next;acknowledge(next);setConfig(next)};return <CustomerScreen state={state} updateState={setState} deviceId='customer-03' orderClient={client} customerDeviceConfig={config} onCustomerDeviceConfigChange={setConfig}/>}
createRoot(document.getElementById('root')).render(<Fixture/>);window.__fixtureReady=true;
`
  .replace("'__APP_PATH__'",JSON.stringify(join(prototype,"src/App.jsx").replaceAll("\\","/"))).replace("'__OUTBOX_PATH__'",JSON.stringify(join(prototype,"src/order-outbox.js").replaceAll("\\","/"))).replace("'__STYLE_PATH__'",JSON.stringify(join(prototype,"src/styles.css").replaceAll("\\","/")));

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
  await build({root:output,configFile:false,envFile:false,publicDir:false,logLevel:'error',resolve:{dedupe:['react','react-dom'],alias:{react:dirname(require.resolve('react/package.json')),'react-dom':dirname(require.resolve('react-dom/package.json'))}},build:{outDir:join(output,'dist'),emptyOutDir:false,rollupOptions:{input:join(output,'index.html')}},plugins:[{name:'observe-real-customer-checkout',transform(source,id){if(/[\\/]src[\\/]App\.jsx$/.test(id)){const marker='function CustomerCheckoutModal({ checkoutState, checkoutRequestError, receiptRequested, onReceiptChange, onRequest, onRetry, onResetCancelled, onClose, submitting }) {';assert.ok(source.includes(marker));const screenMarker="function CustomerScreen({ state, updateState, deviceId, orderClient, customerDeviceConfig, onCustomerDeviceConfigChange, theme = CUSTOMER_TEST_THEME }) {";assert.ok(source.includes(screenMarker));source=source.replace(screenMarker,screenMarker+"\n  useLayoutEffect(() => { window.__screenProbe = { checkoutState, config: customerDeviceConfig, modal }; });");return source.replace(marker,marker+'\nwindow.__checkoutProbe = {checkoutState, checkoutRequestError, submitting, receiptRequested};')+'\nexport { CustomerScreen, defaultState };';}}}]});
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


const checkout=(status='requested',version=1,id='fictional-checkout-A')=>({checkoutRequestId:id,status,version,receiptRequested:false,...(status==='ready'?{grandTotalYen:1234}: {})});
const state=()=>cdp.evaluate('window.snapshot()');
async function settle(){await cdp.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');}
async function getCount(n){await cdp.wait('window.gets.length === '+n);}
async function resolveGet(i,c){await cdp.evaluate('window.resolveGet('+i+','+JSON.stringify(c)+')');await settle();}
async function open(i=0){await cdp.evaluate('window.openStream('+i+')');await settle();}
async function event(id=1){await cdp.evaluate('window.emitCheckout(0,'+id+')');await settle();}
async function beginPost(){await cdp.evaluate("window.clickText('お会計を依頼する')");await cdp.wait('window.posts.length === 1 && window.__checkoutProbe.submitting');}

beforeEach(async(t)=>{
 const id=++session;await cdp.send('Page.navigate',{url:origin+'/?case='+id+(t.name.startsWith('fresh P2')?'&holdConfig=1':'' )});await cdp.wait('window.__fixtureReady && window.fixtureCase === '+id);
 await cdp.wait("[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='お会計') && window.streams.length === 1");
 await cdp.evaluate("window.clickText('お会計')");await getCount(1);
});

test('first successful SSE open closes the requested-to-ready gap without a POST',async()=>{
 await resolveGet(0,checkout());await open();await settle();
 assert.equal(await cdp.evaluate('window.gets.length'),2,'initial successful connection must re-read checkout state');
 await resolveGet(1,checkout('ready',2));const s=await state();assert.equal(s.checkoutState.checkout.status,'ready');assert.equal(s.checkoutState.checkout.version,2);
 assert.equal(await cdp.evaluate("document.body.textContent.includes('1,234')"),true);assert.equal(await cdp.evaluate('window.posts.length'),0);
 const png=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile(join(output,'first-open-ready-1280x800.png'),Buffer.from(png.data,'base64'));
});

test('a new event during initial synchronization defeats the older success',async()=>{
 await resolveGet(0,checkout());await open();await getCount(2);await event();await getCount(3);
 await resolveGet(2,checkout('ready',3));await resolveGet(1,checkout('requested',1));const s=await state();assert.equal(s.checkoutState.checkout.version,3);assert.equal(s.checkoutState.error,false);
});

test('an old synchronization failure cannot clear the newer event result',async()=>{
 await resolveGet(0,checkout());await open();await getCount(2);await event();await getCount(3);await resolveGet(2,checkout('ready',3));
 await cdp.evaluate('window.failGet(1)');await settle();const s=await state();assert.equal(s.checkoutState.checkout.version,3);assert.equal(s.checkoutState.error,false);
});

test('reconnect keeps one resynchronization and the durable SSE cursor',async()=>{
 await resolveGet(0,checkout());await open();await getCount(2);await resolveGet(1,checkout('ready',2));
 await cdp.evaluate('window.emitCheckout(0,7)');await getCount(3);await resolveGet(2,checkout('ready',3));await cdp.evaluate('window.endStream(0)');await settle();
 assert.deepEqual(await cdp.evaluate('window.retryTimers.filter(t=>t.active).map(t=>t.delay)'),[3000]);
 await cdp.evaluate('window.runRetry()');await cdp.wait('window.streams.length === 2');await open(1);await getCount(4);await resolveGet(3,checkout('cancelled',4));
 assert.equal((await state()).checkoutState.checkout.status,'cancelled');assert.equal(await cdp.evaluate('window.streams[1].headers["Last-Event-ID"]'),'7');assert.equal(await cdp.evaluate('window.posts.length'),0);
});

test('synchronization failure exposes existing diagnostics and explicit retry without a request storm',async()=>{
 await resolveGet(0,checkout());await open();await getCount(2);await cdp.evaluate('window.failGet(1)');await settle();
 let s=await state();assert.equal(s.checkoutState.error,true);assert.equal(s.checkoutState.loading,false);assert.equal(s.checkoutState.errorDetails.code,'FICTIONAL_GET_ERROR');assert.equal(await cdp.evaluate('window.gets.length'),2);
 await cdp.evaluate("window.clickText('再試行')");await getCount(3);await resolveGet(2,checkout('ready',2));s=await state();assert.equal(s.checkoutState.error,false);assert.equal(s.checkoutState.checkout.status,'ready');assert.equal(await cdp.evaluate('window.retryTimers.filter(t=>t.active).length'),0);
});

test('a late synchronization response from visit A cannot populate visit B',async()=>{
 await resolveGet(0,checkout());await open();await getCount(2);
 await cdp.evaluate("window.changeVisit({visitContextId:'v1_'+'b'.repeat(64)})");await settle();const beforeOpen=await cdp.evaluate('window.gets.length');await cdp.evaluate("window.clickText('お会計')");await getCount(beforeOpen+1);
 await resolveGet(beforeOpen,checkout('requested',1,'fictional-checkout-B'));await resolveGet(1,checkout('ready',2));assert.equal((await state()).checkoutState.checkout.checkoutRequestId,'fictional-checkout-B');
});

test('initial SSE failure leaves the independent first GET usable and its eventual first success recovers',async()=>{
 await resolveGet(0,checkout());await cdp.evaluate('window.failStream(0)');await settle();assert.equal((await state()).checkoutState.checkout.status,'requested');
 await cdp.evaluate('window.runRetry()');await cdp.wait('window.streams.length === 2');await open(1);await getCount(2);await resolveGet(1,checkout('ready',2));assert.equal((await state()).checkoutState.checkout.status,'ready');
});

test('a synchronization GET started before a valid POST cannot erase its confirmed success',async()=>{
 await resolveGet(0,null);await open();await getCount(2);await beginPost();await cdp.evaluate('window.resolvePost(0)');await settle();
 await resolveGet(1,null);const s=await state();assert.equal(s.checkoutState.checkout?.checkoutRequestId,await cdp.evaluate('window.posts[0].request.checkoutRequestId'));assert.equal(s.submitting,false);
});

test('a synchronization null read does not hide a valid POST failure and same-ID retry',async()=>{
 await resolveGet(0,null);await open();await getCount(2);await beginPost();await resolveGet(1,null);await cdp.evaluate('window.failPost(0)');await settle();
 const s=await state();assert.equal(s.checkoutRequestError,true);assert.equal(s.submitting,false);assert.equal(s.checkoutState.loading,false);
 await cdp.evaluate("window.clickText('お会計を依頼する')");await cdp.wait('window.posts.length === 2');assert.equal(await cdp.evaluate('window.posts[0].request.checkoutRequestId === window.posts[1].request.checkoutRequestId'),true);
});

test('a late synchronization error cannot replace the confirmed POST with diagnostics',async()=>{
 await resolveGet(0,null);await open();await getCount(2);await beginPost();await cdp.evaluate('window.resolvePost(0)');await settle();await cdp.evaluate('window.failGet(1)');await settle();
 const s=await state();assert.equal(s.checkoutState.checkout.status,'requested');assert.equal(s.checkoutState.error,false);assert.equal(s.submitting,false);
});

test('a higher version for the confirmed POST still applies from an overlapping read',async()=>{
 await resolveGet(0,null);await open();await getCount(2);await beginPost();await cdp.evaluate('window.resolvePost(0)');await settle();const id=await cdp.evaluate('window.posts[0].request.checkoutRequestId');
 await resolveGet(1,checkout('ready',2,id));assert.equal((await state()).checkoutState.checkout.status,'ready');assert.equal((await state()).checkoutState.checkout.version,2);
});

test('a pending initial connection synchronizes the new assignment instead of restoring old visit data',async()=>{
 await resolveGet(0,checkout());await cdp.evaluate("window.changeVisit({tableId:2,visitContextId:'v1_'+'b'.repeat(64)})");await settle();await open();await settle();
 const latest=await cdp.evaluate('window.gets.length-1');assert.ok(latest>=1);await resolveGet(latest,checkout('ready',2,'fictional-checkout-B'));
 await cdp.evaluate("window.clickText('お会計')");await settle();const current=await cdp.evaluate('window.gets.length-1');await resolveGet(current,checkout('ready',2,'fictional-checkout-B'));
 assert.equal((await state()).checkoutState.checkout.checkoutRequestId,'fictional-checkout-B');assert.equal((await state()).checkoutState.visitContextId,'v1_'+'b'.repeat(64));
});

test('a transient config failure at initial open retries once and completes the pending checkout sync',async()=>{
 await resolveGet(0,checkout());await cdp.evaluate('window.configFailures=1');await open();
 assert.equal(await cdp.evaluate('window.gets.length'),1);assert.deepEqual(await cdp.evaluate('window.configTimers.filter(t=>t.active).map(t=>t.delay)'),[3000]);
 await cdp.evaluate('window.retryConfig()');await settle();assert.equal(await cdp.evaluate('window.gets.length'),2,'successful config retry must finish the pending synchronization');
 await resolveGet(1,checkout('ready',2));assert.equal((await state()).checkoutState.checkout.status,'ready');assert.equal(await cdp.evaluate('window.configTimers.filter(t=>t.active).length'),0);
});

async function serverVisit(letter,tableId){await cdp.evaluate('window.setServerConfig('+JSON.stringify({tableId,visitContextId:'v1_'+letter.repeat(64)})+')');}
async function resolveConfig(i,status=200){await cdp.evaluate('window.resolveConfig('+i+','+status+')');await settle();}
async function finishFreshVisit(index,letter,tableId){
 await cdp.evaluate('window.holdConfig=false');await resolveConfig(index);
 await cdp.wait('window.gets.length >= 2');const latest=await cdp.evaluate('window.gets.length-1');
 assert.equal(await cdp.evaluate('window.gets['+latest+'].scope.tableId'),tableId);
 await resolveGet(latest,checkout('ready',2,'fictional-checkout-'+letter.toUpperCase()));
 assert.equal(await cdp.evaluate('window.__screenProbe.config.tableId'),tableId);
 assert.equal(await cdp.evaluate('window.__screenProbe.checkoutState.visitContextId'),'v1_'+letter.repeat(64));
 assert.equal(await cdp.evaluate('window.__screenProbe.checkoutState.checkout?.checkoutRequestId'),'fictional-checkout-'+letter.toUpperCase());
 await cdp.evaluate("window.clickText('お会計')");await settle();const opened=await cdp.evaluate('window.gets.length-1');
 await resolveGet(opened,checkout('ready',2,'fictional-checkout-'+letter.toUpperCase()));
 assert.equal((await state()).checkoutState.visitContextId,'v1_'+letter.repeat(64));assert.equal((await state()).checkoutState.checkout.checkoutRequestId,'fictional-checkout-'+letter.toUpperCase());
 assert.equal(await cdp.evaluate("document.body.textContent.replace(/\\s/g,'').includes('テーブル"+tableId+"')"),true);
 assert.equal(await cdp.evaluate('window.posts.length'),0);
 const png=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile(join(output,'fresh-'+letter+'-'+session+'-1280x800.png'),Buffer.from(png.data,'base64'));
}

test('fresh P2 initial open does not consume pre-open config A and reads B exactly once after A',async()=>{
 await resolveGet(0,checkout());assert.equal(await cdp.evaluate('window.configGets.length'),1);
 await serverVisit('b',2);await open();assert.equal(await cdp.evaluate('window.configGets.length'),1);
 await resolveConfig(0);assert.equal(await cdp.evaluate('window.configGets.length'),2,'one post-open config request is required');
 assert.equal(await cdp.evaluate('window.gets.length'),1,'old config A must not release checkout sync');
 await finishFreshVisit(1,'b',2);const count=await cdp.evaluate('window.configGets.length');await settle();assert.equal(await cdp.evaluate('window.configGets.length'),count);
});

test('fresh P2 reconnect during config B queues one newer config C without parallel requests',async()=>{
 await resolveGet(0,checkout());await serverVisit('b',2);await open();await resolveConfig(0);assert.equal(await cdp.evaluate('window.configGets.length'),2);
 await serverVisit('c',3);await cdp.evaluate('window.endStream(0)');await settle();await cdp.evaluate('window.runRetry()');await cdp.wait('window.streams.length === 2');await open(1);
 assert.equal(await cdp.evaluate('window.configGets.length'),2);await resolveConfig(1);assert.equal(await cdp.evaluate('window.configGets.length'),3);
 assert.equal(await cdp.evaluate('window.gets.length'),1);await finishFreshVisit(2,'c',3);
});

test('fresh P2 failed post-open config keeps sync pending until the existing retry succeeds',async()=>{
 await resolveGet(0,checkout());await serverVisit('b',2);await open();await resolveConfig(0);assert.equal(await cdp.evaluate('window.configGets.length'),2);
 await resolveConfig(1,503);assert.equal(await cdp.evaluate('window.gets.length'),1);assert.deepEqual(await cdp.evaluate('window.configTimers.filter(t=>t.active).map(t=>t.delay)'),[3000]);
 await cdp.evaluate('window.retryConfig()');await settle();assert.equal(await cdp.evaluate('window.configGets.length'),3);await finishFreshVisit(2,'b',2);
});

test('fresh P2 checkout event while config is stale waits for the post-open identity',async()=>{
 await resolveGet(0,checkout());await serverVisit('b',2);await open();await event();assert.equal(await cdp.evaluate('window.gets.length'),1);
 await resolveConfig(0);assert.equal(await cdp.evaluate('window.configGets.length'),2);await finishFreshVisit(1,'b',2);
});

test('fresh P2 a manual read while config is pending cannot show B checkout under A identity',async()=>{
 await resolveGet(0,checkout());await serverVisit('b',2);await open();
 await cdp.evaluate("document.querySelector('[role=dialog] button[aria-label=\"閉じる\"]').click()");await settle();await cdp.evaluate("window.clickText('お会計')");await getCount(2);
 await resolveGet(1,checkout('ready',2,'fictional-checkout-B'));
 assert.notEqual((await state()).checkoutState.checkout?.checkoutRequestId,'fictional-checkout-B');
 await resolveConfig(0);assert.equal(await cdp.evaluate('window.configGets.length'),2);await finishFreshVisit(1,'b',2);
});

test('fresh P2 authorization failure does not leave the pending sync guard hiding manual diagnostics',async()=>{
 await resolveGet(0,checkout());await open();await cdp.evaluate('window.endStream(0)');await settle();await cdp.evaluate('window.runRetry()');await cdp.wait('window.streams.length === 2');
 await cdp.evaluate('window.denyStream(1)');await settle();
 await cdp.evaluate("document.querySelector('[role=dialog] button[aria-label=\"閉じる\"]').click()");await settle();await cdp.evaluate("window.clickText('お会計')");await getCount(2);await cdp.evaluate('window.failGet(1)');await settle();
 assert.equal((await state()).checkoutState.error,true);assert.equal((await state()).checkoutState.errorDetails.code,'FICTIONAL_GET_ERROR');assert.equal(await cdp.evaluate('window.posts.length'),0);
});
