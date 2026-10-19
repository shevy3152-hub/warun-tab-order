import test from 'node:test';
import assert from 'node:assert/strict';
import { CUSTOMER_THEME_DEFINITIONS as definitions } from '../../shared/customer-theme-definitions.mjs';
import { A90_THEME_CONDITION, A90_THEME_REGIONS, customerThemeConditionModel as model, customerThemePlacementFrames as frames } from '../src/customer-theme-display-condition.js';
import { buildCustomerThemeGenerationPrompt as prompt } from '../src/customer-theme-generation-prompt.js';
const image = { width:803, height:2018 };
const variant = Object.freeze({ theme:'japanese-halloween',zoom:1.0315,positionX:.515,positionY:.1816,prompt:'独自の絵柄と書体',notes:'手入力メモを保持' });
const build = (v=variant, i=image, condition=A90_THEME_CONDITION) => model({image:i,variant:v,condition});
test('A90 CSS geometry reproduces stored measurements without applying DPR',()=>{
 const a=build(),b=build(variant,image,{...A90_THEME_CONDITION,dpr:3});
 assert.equal(a.layout.metrics.frameWidth,220);assert.equal(a.measurement.viewportWidth,1313);assert.equal(a.measurement.viewportHeight,820);
 assert.ok(Math.abs(a.layout.metrics.renderWidth-336.9821)<.001);assert.ok(Math.abs(a.layout.metrics.renderHeight-846.859)<.01);
 assert.deepEqual(a.layout,b.layout);assert.deepEqual(a.measurement.regions,b.measurement.regions);
 assert.match(a.measurement.limitations,/未再現/);assert.match(a.measurement.limitations,/未実測|推定/);
});
test('condition, zoom and positions drive the same layout, coordinates and generated copy',()=>{
 const pc={id:'management',label:'現在の管理画面条件',viewportWidth:1280,viewportHeight:800,dpr:1,frameWidth:328,frameHeight:800};
 const cases=[build(),build({...variant,zoom:.83}),build({...variant,positionX:.9,positionY:.8}),build(variant,image,pc)];
 const copies=cases.map(m=>prompt({definition:{...definitions['japanese-halloween'],image},variant,measurement:m.measurement}));
 assert.equal(new Set(copies).size,cases.length);
 assert.notDeepEqual(cases[0].layout,cases[3].layout);assert.notDeepEqual(cases[0].measurement.visibleImage,cases[2].measurement.visibleImage);
 assert.match(copies[0],/A90キオスク実測条件 viewport 1313×820/);assert.match(copies[3],/現在の管理画面条件 viewport 1280×800/);
 assert.match(copies[2],/X90.0%・Y80.0%/);assert.match(copies[0],/80〜85%/);
 assert.deepEqual(variant,{theme:'japanese-halloween',zoom:1.0315,positionX:.515,positionY:.1816,prompt:'独自の絵柄と書体',notes:'手入力メモを保持'});
});
test('A90 UI uses measured individual button rectangles instead of PC placement',()=>{
 assert.equal(A90_THEME_REGIONS.find(r=>r.key==='category-1').rect.top,216.987183);
 assert.equal(A90_THEME_REGIONS.find(r=>r.key==='categories').backgroundOnly,true);
 const m=build({...variant,positionY:.5});const f=frames(m.measurement,image);assert.ok(f.title);assert.ok(f.subject);
 for(const box of [f.title,f.subject]) {
  assert.ok(box.left>m.measurement.visibleImage.left);assert.ok(box.right<m.measurement.visibleImage.right);
  for(const r of m.measurement.regions.filter(r=>r.status==='overlap'&&!r.backgroundOnly)) assert.ok(box.bottom<=r.top||box.top>=r.bottom||box.right<=r.left||box.left>=r.right);
 }
});
test('blocked, pending or too small space never invents placement frames',()=>{
 const m=build();assert.equal(frames({...m.measurement,imageHidden:true},image).title,null);
 assert.equal(frames({...m.measurement,regions:[{status:'pending'}]},image).subject,null);
 const full={status:'overlap',...m.measurement.visibleImage};assert.equal(frames({...m.measurement,regions:[full]},image).title,null);
});
test('each theme uses real supplied dimensions and preserves custom instructions',()=>{
 for(const key of ['camellia','autumn-leaves','moon-susuki']) {
  const d=definitions[key],v={...variant,theme:key,prompt:'手入力の季節指示'},m=build(v,d.image);
  const copy=prompt({definition:d,variant:v,measurement:m.measurement});
  assert.match(copy,new RegExp('横'+d.image.width+'×縦'+d.image.height));assert.match(copy,/手入力の季節指示/);assert.doesNotMatch(copy,/Halloween|かぼちゃ|猫|803×縦2018/);
 }
 const d={...definitions.camellia,image:{width:500,height:1700}};assert.match(prompt({definition:d,variant,measurement:build(variant,d.image).measurement}),/横500×縦1700/);
 assert.equal(model({image:null,variant}),null);
});
test('base is separate from season direction and does not carry washi styling',()=>{
 const d=definitions['japanese-halloween'];const copy=prompt({definition:d,variant:{...variant,prompt:d.prompt},measurement:build().measurement});
 const [base,season]=copy.split('【季節固有のイメージ指示】');assert.doesNotMatch(base,/生成り|和紙|猫|かぼちゃ/);assert.match(season,/Happy/);assert.match(season,/Halloween/);
 assert.match(base,/四辺/);assert.match(base,/水平中央揃え/);assert.match(base,/80〜85%/);assert.match(base,/参考画像/);assert.match(base,/画像外の上下余白/);
});
