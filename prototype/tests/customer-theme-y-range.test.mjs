import assert from 'node:assert/strict';
import test from 'node:test';
import { customerThemeImageLayout as layout, customerThemePositionAfterDrag as drag } from '../src/customer-theme-layout.js';
import { customerThemeConditionModel, A90_THEME_CONDITION } from '../src/customer-theme-display-condition.js';
import { buildCustomerThemeGenerationPrompt } from '../src/customer-theme-generation-prompt.js';
const image={width:400,height:1000};
const nearly=(a,b)=>assert.ok(Math.abs(a-b)<1e-7,`${a} != ${b}`);
test('Y can move through a frame-height range even when image height exactly fits',()=>{
 const v={zoom:1,positionX:.5,positionY:.5}; const m=layout(image,v,220,800);
 nearly(m.metrics.deltaY,0);assert.equal(m.metrics.canMoveY,true);nearly(m.metrics.rangeY,800);nearly(parseFloat(m.style.top),0);
 nearly(parseFloat(layout(image,{...v,positionY:0},220,800).style.top),400);
 nearly(parseFloat(layout(image,{...v,positionY:1},220,800).style.top),-400);
});
test('small and large images retain visible pixels at both Y endpoints and report real empty space',()=>{
 for(const size of [image,{width:100,height:2000},{width:1500,height:400}]) for(const zoom of [.5,.8,1,1.1,2,3]) for(const y of [0,.2,.5,.8,1]){
  const m=layout(size,{zoom,positionX:.5,positionY:y},220,800),top=parseFloat(m.style.top);
  assert.ok(m.metrics.rangeY>=800);assert.ok(top<800&&top+m.metrics.renderHeight>0);
  const visible=Math.min(800,top+m.metrics.renderHeight)-Math.max(0,top);
  nearly(m.metrics.spaceY,800-visible);nearly(m.metrics.croppedSourceHeight,size.height-visible*size.height/m.metrics.renderHeight);
  if(y===.5)nearly(top,(800-m.metrics.renderHeight)/2);
 }
});
test('zoom across fitted height has continuous Y position rather than changing drag direction',()=>{
 const a=layout(image,{zoom:.999,positionY:.2},220,800),b=layout(image,{zoom:1.001,positionY:.2},220,800);
 assert.ok(Math.abs(parseFloat(a.style.top)-parseFloat(b.style.top))<2);
});
test('Y drag follows pointer at management and A90 preview scales; X calculation stays unchanged',()=>{
 for(const scale of [.62,.5])for(const zoom of [.5,1,3]){
  const v={zoom,positionX:.5,positionY:.5},m=layout(image,v,220,800);
  const y=drag(v.positionY,20,m.metrics.rangeY,scale);const moved=layout(image,{...v,positionY:y},220,800);
  nearly(parseFloat(moved.style.top)-parseFloat(m.style.top),20/scale);
  nearly(parseFloat(m.style.left),-m.metrics.deltaX*v.positionX);
  if(Math.abs(m.metrics.deltaX)>.5){const x=drag(.5,5,m.metrics.deltaX,scale);nearly(parseFloat(layout(image,{...v,positionX:x},220,800).style.left)-parseFloat(m.style.left),5/scale);}
 }
});
test('saved values, hand-written prompt and centered fit remain unchanged',()=>{
 const v=Object.freeze({zoom:.5,positionX:.515,positionY:.1816,prompt:'手入力の指示',notes:'保持'});const before=JSON.stringify(v);layout(image,v,220,800);assert.equal(JSON.stringify(v),before);
 const centered=layout(image,{...v,positionX:.5,positionY:.5},220,800);assert.ok(centered.metrics.renderWidth<=220+1e-7);assert.ok(centered.metrics.renderHeight<=800+1e-7);
});
test('condition model and generated prompt use the shared expanded Y position and clipped image coordinates',()=>{
 const variant={theme:'camellia',zoom:1,positionX:.5,positionY:.2,prompt:'独自の季節指示'};
 for(const condition of [A90_THEME_CONDITION,{...A90_THEME_CONDITION,id:'management',label:'管理',frameWidth:328,frameHeight:800}]){
  const model=customerThemeConditionModel({image,variant,condition}),m=model.layout.metrics;
  assert.deepEqual(model.layout,layout(image,variant,Math.round(condition.frameWidth),Math.round(condition.frameHeight)));
  nearly(m.offsetY,parseFloat(model.layout.style.top));assert.equal(model.measurement.rangeY,m.rangeY);
  const copy=buildCustomerThemeGenerationPrompt({definition:{label:'椿',assetPath:'/fictional-theme.png',image,prompt:'既定'},variant,measurement:model.measurement});
  assert.match(copy,/Y20.0%/);assert.match(copy,/独自の季節指示/);assert.match(copy,/0%で画像を下へ、100%で上へ/);
  nearly(model.measurement.visibleImage.top,Math.max(0,-m.offsetY)*image.height/m.renderHeight);
 }
});
