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
const output = process.env.WARUN_HISTORY_TEST_OUTPUT || await mkdtemp(join(tmpdir(), 'warun-history-scope-ui-'));
await mkdir(output, { recursive: true });
const fixture = String.raw`import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {CustomerScreen,defaultState} from '__APP_PATH__';
import '__STYLE_PATH__';
window.fixtureCase=Number(new URL(location.href).searchParams.get('case'));
window.AudioContext=undefined;window.webkitAudioContext=undefined;
window.fetch=async url=>{if(String(url).endsWith('/v1/business-hours'))return new Response(JSON.stringify({}),{status:200,headers:{'Content-Type':'application/json'}});throw Error('Rejected non-fixture fetch: '+url)};
const initial={deviceId:'fictional-history-device',role:'customer',tableId:1,visitContextId:'v1_'+'a'.repeat(64)};
function acknowledge(c){if(c.visitContextId&&c.tableId)localStorage.setItem('warun:customer-order-start-notice:v1:'+encodeURIComponent(c.deviceId)+':'+c.tableId+':'+encodeURIComponent(c.visitContextId),'confirmed')}
acknowledge(initial);window.fixtureConfig=initial;window.historyCalls=[];window.outboxMutations=0;
const invalidations=new Set(),outboxSubscribers=new Set();
window.emitOutbox=(clientOrderId,state)=>{for(const callback of outboxSubscribers)callback({clientOrderId,state})};
const client={mode:'api',getThemeConfig:async()=>({theme:'standard'}),getOrderStartNotice:async()=>({heading:'架空の隔離確認',body:'履歴取得の検証用'}),getMenu:async()=>({categories:[],items:[]}),getDeviceConfig:async()=>structuredClone(window.fixtureConfig),getCheckout:async()=>null,
subscribe:callback=>{outboxSubscribers.add(callback);return()=>outboxSubscribers.delete(callback)},
subscribeInvalidations:callback=>{invalidations.add(callback);return()=>invalidations.delete(callback)},
getHistory:()=>new Promise((resolve,reject)=>window.historyCalls.push({scope:structuredClone(window.fixtureConfig),resolve,reject})),
enqueue:()=>{window.outboxMutations++;throw Error('No order submission is permitted in this fixture')}};
window.emitOrders=()=>{for(const callback of invalidations)callback({payload:{resource:'orders'}})};
window.emitConfig=patch=>{window.fixtureConfig={...window.fixtureConfig,...patch};acknowledge(window.fixtureConfig);for(const callback of invalidations)callback({payload:{resource:'deviceConfig'}})};
window.resolveHistory=(i,label)=>window.historyCalls[i].resolve([{orderId:'fictional-order-'+label,clientOrderId:'fictional-client-'+label,tableNumberSnapshot:window.historyCalls[i].scope.tableId||1,acceptedAtMs:1700000000000+i,status:'new',items:[{orderItemId:'fictional-item-'+label,menuItemId:'beer',formalNameSnapshot:'架空履歴商品 '+label,quantity:1,isServed:false,servedAtMs:null}]}]);
window.rejectHistory=i=>window.historyCalls[i].reject(Error('Fictional history failure'));
window.snapshot=()=>structuredClone(window.__historyProbe);
window.clickText=text=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===text);if(!b||b.disabled)throw Error('Unavailable button '+text);b.click()};
window.closeHistory=()=>{const b=document.querySelector('[role=dialog] button[aria-label="閉じる"]');if(!b)throw Error('History close control unavailable');b.click()};
function Fixture(){const[state,setState]=useState({...structuredClone(defaultState),orders:[]});const[c,setConfig]=useState(initial);
window.changeScope=patch=>{const next={...window.fixtureConfig,...patch};window.fixtureConfig=next;acknowledge(next);setConfig(next)};
return <CustomerScreen state={state} updateState={setState} deviceId="customer-03" orderClient={client} customerDeviceConfig={c} onCustomerDeviceConfigChange={setConfig}/>}
createRoot(document.getElementById('root')).render(<Fixture/>);window.__fixtureReady=true;
`
  .replace("'__APP_PATH__'", JSON.stringify(join(prototype, "src/App.jsx").replaceAll("\\", "/")))
  .replace("'__STYLE_PATH__'", JSON.stringify(join(prototype, "src/styles.css").replaceAll("\\", "/")));

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
  await build({root:output,configFile:false,envFile:false,publicDir:false,logLevel:'error',resolve:{dedupe:['react','react-dom'],alias:{react:dirname(require.resolve('react/package.json')),'react-dom':dirname(require.resolve('react-dom/package.json'))}},build:{outDir:join(output,'dist'),emptyOutDir:false,rollupOptions:{input:join(output,'index.html')}},plugins:[{name:'observe-real-customer-checkout',transform(source,id){if(/[\\/]src[\\/]App\.jsx$/.test(id)){const marker="function CustomerScreen({ state, updateState, deviceId, orderClient, customerDeviceConfig, onCustomerDeviceConfigChange, theme = CUSTOMER_TEST_THEME }) {";assert.ok(source.includes(marker));return source.replace(marker,marker+"\n  useLayoutEffect(() => { window.__historyProbe = { orders: customerHistory, loading: apiHistoryState.loading, error: apiHistoryState.error, config: customerDeviceConfig, modal }; });")+"\nexport { CustomerScreen, defaultState };";}}}]});
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

const A='v1_'+'a'.repeat(64), B='v1_'+'b'.repeat(64);
const state=()=>cdp.evaluate('window.snapshot()');
async function settle(){await cdp.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');}
async function change(patch){await cdp.evaluate('window.changeScope('+JSON.stringify(patch)+')');await settle();}
async function calls(n){await cdp.wait('window.historyCalls.length === '+n);}
async function resolveHistory(i,label){await cdp.evaluate('window.resolveHistory('+i+','+JSON.stringify(label)+')');await settle();}
async function rejectHistory(i){await cdp.evaluate('window.rejectHistory('+i+')');await settle();}
const visible=label=>cdp.evaluate('document.body.textContent.includes('+JSON.stringify('架空履歴商品 '+label)+')');
async function capture(name){const r=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile(join(output,name),Buffer.from(r.data,'base64'));}

beforeEach(async()=>{
 const id=++session;await cdp.send('Page.navigate',{url:origin+'/?case='+id});
 await cdp.wait('window.__fixtureReady && window.fixtureCase === '+id);
 await cdp.wait("[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='注文履歴')");
 await cdp.evaluate("window.clickText('注文履歴')");await calls(1);await cdp.wait('window.__historyProbe.loading');
});

test('switching loaded A to B hides A immediately while the new history is pending',async()=>{
 await resolveHistory(0,'OLD-A');assert.equal(await visible('OLD-A'),true);
 await change({visitContextId:B});assert.equal(await visible('OLD-A'),false);
 assert.deepEqual((await state()).orders,[]);await calls(2);
 assert.equal((await state()).loading,true);
 await resolveHistory(1,'CURRENT-B');assert.equal(await visible('CURRENT-B'),true);
 await capture('history-B-1280x800.png');
});
test('a pre-switch success cannot restore A while B is still pending',async()=>{
 await change({visitContextId:B});await resolveHistory(0,'OLD-A');
 assert.deepEqual((await state()).orders,[]);assert.equal(await visible('OLD-A'),false);
 await calls(2);assert.equal((await state()).loading,true);await resolveHistory(1,'CURRENT-B');
});
test('B success survives a later A success',async()=>{
 await change({visitContextId:B});await calls(2);await resolveHistory(1,'CURRENT-B');
 await resolveHistory(0,'OLD-A');const s=await state();
 assert.equal(await visible('CURRENT-B'),true);assert.equal(await visible('OLD-A'),false);
 assert.equal(s.loading,false);assert.equal(s.error,false);
});
test('B success survives a later A failure',async()=>{
 await change({visitContextId:B});await calls(2);await resolveHistory(1,'CURRENT-B');
 await rejectHistory(0);const s=await state();
 assert.equal(await visible('CURRENT-B'),true);assert.equal(s.loading,false);assert.equal(s.error,false);
});
test('a current B failure and its normal reopen retry survive the older A failure',async()=>{
 await change({visitContextId:B});await calls(2);await rejectHistory(1);await rejectHistory(0);
 let s=await state();assert.equal(s.error,true);assert.equal(s.loading,false);
 assert.equal(await cdp.evaluate("document.body.textContent.includes('注文履歴を取得できません。')"),true);
 await cdp.evaluate('window.closeHistory()');await settle();
 await cdp.evaluate("window.clickText('注文履歴')");await calls(3);
 await resolveHistory(2,'RETRIED-B');s=await state();
 assert.equal(await visible('RETRIED-B'),true);assert.equal(s.error,false);assert.equal(s.loading,false);
});
for(const outcome of ['success','failure']){
 test('an old A '+outcome+' cannot finish the current B loading state',async()=>{
  await change({visitContextId:B});await calls(2);
  if(outcome==='success')await resolveHistory(0,'OLD-A');else await rejectHistory(0);
  const pending=await state();assert.equal(pending.loading,true);assert.equal(pending.error,false);assert.deepEqual(pending.orders,[]);
  await resolveHistory(1,'CURRENT-B');assert.equal((await state()).loading,false);
 });
 test('A to no visit clears old rows and rejects its late '+outcome,async()=>{
  await resolveHistory(0,'OLD-A');await cdp.evaluate('window.emitOrders()');await calls(2);
  await change({visitContextId:null});
  assert.deepEqual((await state()).orders,[]);
  if(outcome==='success')await resolveHistory(1,'LATE-A');else await rejectHistory(1);
  const s=await state();assert.deepEqual(s.orders,[]);assert.equal(s.loading,false);assert.equal(s.error,false);
  assert.equal(await cdp.evaluate('window.historyCalls.length'),2);
 });
}
test('A to B to A cannot adopt the first A response',async()=>{
 await change({visitContextId:B});await calls(2);await resolveHistory(1,'CURRENT-B');
 await change({visitContextId:A});await calls(3);await resolveHistory(2,'LATEST-A');
 await resolveHistory(0,'FIRST-A');
 assert.equal(await visible('LATEST-A'),true);assert.equal(await visible('FIRST-A'),false);
 assert.equal((await state()).loading,false);
});
test('A to B to A cannot let the first A failure finish the latest A read',async()=>{
 await change({visitContextId:B});await calls(2);await change({visitContextId:A});await calls(3);
 await rejectHistory(0);assert.equal((await state()).loading,true);assert.equal((await state()).error,false);
 await resolveHistory(2,'LATEST-A');await rejectHistory(1);assert.equal(await visible('LATEST-A'),true);
});
test('a table reassignment with the same visit token invalidates old history',async()=>{
 await resolveHistory(0,'OLD-TABLE');await change({tableId:2});assert.equal(await visible('OLD-TABLE'),false);
 await calls(2);await resolveHistory(1,'NEW-TABLE');assert.equal(await visible('NEW-TABLE'),true);
});
test('a device identity change with the same table and token invalidates old history',async()=>{
 await resolveHistory(0,'OLD-DEVICE');await change({deviceId:'fictional-other-device'});
 assert.equal(await visible('OLD-DEVICE'),false);await calls(2);await resolveHistory(1,'NEW-DEVICE');
 assert.equal(await visible('NEW-DEVICE'),true);
});
test('a deviceConfig event refreshes the actual config before starting the new visit history',async()=>{
 await resolveHistory(0,'OLD-A');
 await cdp.evaluate('window.emitConfig({visitContextId:'+JSON.stringify(B)+'})');
 await cdp.wait('window.__historyProbe.config.visitContextId === '+JSON.stringify(B));
 assert.equal(await visible('OLD-A'),false);await calls(2);await resolveHistory(1,'CURRENT-B');
 assert.equal(await visible('CURRENT-B'),true);
});
test('missing assignment clears history without fetching for the missing scope',async()=>{
 await resolveHistory(0,'OLD-A');await change({tableId:null,visitContextId:null});
 const s=await state();assert.deepEqual(s.orders,[]);assert.equal(s.error,false);assert.equal(s.loading,false);
 assert.equal(await cdp.evaluate('window.historyCalls.length'),1);assert.equal(await cdp.evaluate('window.outboxMutations'),0);
});
test('same-valued config refresh preserves current history without a redundant fetch',async()=>{
 await resolveHistory(0,'CURRENT-A');await change({tableId:1,visitContextId:A});
 assert.equal(await visible('CURRENT-A'),true);assert.equal(await cdp.evaluate('window.historyCalls.length'),1);
});

test('outbox row updates cannot insert a prior-scope order or finish the current read',async()=>{
 await resolveHistory(0,'OLD-A');await change({visitContextId:B});await calls(2);
 await cdp.evaluate("window.emitOutbox('fictional-client-OLD-A','pending')");await settle();
 assert.deepEqual((await state()).orders,[]);assert.equal((await state()).loading,true);
 await resolveHistory(1,'CURRENT-B');
 await cdp.evaluate("window.emitOutbox('fictional-client-OLD-A','rejected')");await settle();
 assert.equal(await visible('OLD-A'),false);assert.equal(await visible('CURRENT-B'),true);
 await cdp.evaluate("window.emitOutbox('fictional-client-CURRENT-B','synced')");await settle();
 const s=await state();assert.equal(s.orders[0].transportState,'synced');assert.equal(s.loading,false);assert.equal(s.error,false);
 assert.equal(await cdp.evaluate('window.outboxMutations'),0);
});

test('session closure uses the refreshed opaque token and empty server history without restoring A',async()=>{
 await resolveHistory(0,'OLD-A');await cdp.evaluate('window.emitOrders()');await calls(2);
 await cdp.evaluate('window.emitConfig({visitContextId:'+JSON.stringify(B)+'})');
 await cdp.wait('window.__historyProbe.config.visitContextId === '+JSON.stringify(B));await calls(3);
 assert.equal(await visible('OLD-A'),false);
 await cdp.evaluate('window.historyCalls[2].resolve([])');await settle();
 await resolveHistory(1,'LATE-CLOSED-A');
 const s=await state();assert.deepEqual(s.orders,[]);assert.equal(s.loading,false);assert.equal(s.error,false);
 assert.equal(await visible('LATE-CLOSED-A'),false);
 assert.equal(await cdp.evaluate("document.body.textContent.includes('注文履歴はまだありません。')"),true);
});
