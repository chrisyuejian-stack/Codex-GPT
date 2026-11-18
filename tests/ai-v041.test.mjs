import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from "node:fs/promises";
import { school, call, ok, model, ai } from "./fixtures-ai.mjs";
import { httpExamples, ops } from "./fixtures-v041.mjs";
import { aiFailureReason } from "../src/server/ai-policy.js";
import { HttpError } from "../src/server/core.js";
const usage=s=>s.f.db.raw.prepare('SELECT * FROM ai_usage WHERE tenant_id=? ORDER BY created_at,id').all(s.t.id);
const lastFailure=s=>usage(s).at(-1).result;
const record=(route,data,r)=>httpExamples.push({request:{method:'POST',path:'/api/ai/'+route,body:data,headers:{'Idempotency-Key':'<fresh UUID>'}},response:{status:r.status,body:r.body}});

test('V041 G1 通用动作45/90秒，max_tokens按档位且预占覆盖截止',()=>school(async s=>{for(const tier of ['fast','deep']){model(s,request=>{assert.ok(Math.abs(request.deadline_at-Date.now()-(tier==='fast'?45000:90000))<1000);assert.equal(request.max_tokens,tier==='fast'?4096:8192);return {suggestions:[]}});ok(await ai(s,'settings/propose',{tier}));const q=s.f.db.raw.prepare('SELECT deadline_at,hold_id FROM ai_requests WHERE tenant_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(s.t.id);assert.ok((await s.r.aiHold(q.hold_id)).expires_at>=q.deadline_at)}}));

test('V041 G1 超时返回ai_timeout、记录timeout、不计次、不记录输入或模型内容',()=>school(async s=>{
 const original=Date.now;let clock=original();Date.now=()=>clock;
 try{model(s,()=>{clock+=120001;return {content:JSON.stringify({suggestions:[],private_model:'不可记录的模型内容'})}});const data={instruction:"调整设置",instruction:'不可记录的用户输入'};const r=await ai(s,'settings/propose',data);record('settings/propose',data,r);assert.equal(ok(r,502).error,'ai_timeout');assert.equal(lastFailure(s),'timeout');assert.equal(ok(await call(s,'ai/usage')).fast.used,0);const log=JSON.stringify(usage(s));assert.ok(!log.includes('不可记录'));assert.ok(!JSON.stringify(s.f.db.raw.prepare('SELECT * FROM ai_requests WHERE tenant_id=?').all(s.t.id)).includes('不可记录'))}finally{Date.now=original}
}));

test('V041 G1 深度请求89秒完成可结算，预占覆盖90秒截止',()=>school(async s=>{
 const original=Date.now;let clock=original();Date.now=()=>clock;
 try{model(s,()=>{clock+=89000;return {suggestions:[]}});const r=ok(await ai(s,'settings/propose',{instruction:"调整设置",tier:'deep'}));assert.equal(r.usage.used_today,1);assert.equal(usage(s)[0].result,'ok');assert.equal(usage(s)[0].duration_ms,89000)}finally{Date.now=original}
}));

test('V041 G1 剩余29999毫秒不重试，恰好30000毫秒可重试且不延长截止',()=>school(async s=>{
 const original=Date.now;let clock=original();Date.now=()=>clock;
 try{model(s,()=>{clock+=15001;return {content:'invalid'}});ok(await ai(s,'settings/propose',{instruction:"调整设置"}),502);assert.equal(s.modelCalls.length,1);assert.equal(lastFailure(s),'protocol_invalid');assert.equal(ok(await call(s,'ai/usage')).fast.used,0);
 model(s,(_,n)=>{clock+=n===1?15000:1000;return n===1?{content:'invalid'}:{suggestions:[]}});ok(await ai(s,'settings/propose',{instruction:"调整设置"}));assert.equal(s.modelCalls.length,2);assert.equal(s.modelCalls[0].deadline_at,s.modelCalls[1].deadline_at);assert.equal(ok(await call(s,'ai/usage')).fast.used,1)}finally{Date.now=original}
}));

test('V041 G1 HTTP401/402/404/503原因保留，机构只返回ai_unavailable且不计次',()=>school(async s=>{
 const originalFetch=globalThis.fetch;model(s);s.f.env.DEEPSEEK_API_KEY='local-test-key-not-live';delete s.f.env.AI_PROVIDER;
 try{for(const status of [401,402,404,503]){globalThis.fetch=async(url,init)=>{if(String(url).startsWith('https://api.deepseek.com/')){const b=JSON.parse(init.body);assert.equal(b.max_tokens,4096);return new Response('sensitive-provider-text',{status})}return originalFetch(url,init)};const r=await ai(s,'settings/propose',{instruction:"调整设置"});record('settings/propose',{instruction:"调整设置"},r);assert.equal(ok(r,502).error,'ai_unavailable');assert.equal(lastFailure(s),'provider_http_'+status)}assert.equal(ok(await call(s,'ai/usage')).fast.used,0);assert.ok(!JSON.stringify(usage(s)).includes('sensitive-provider-text'))}finally{globalThis.fetch=originalFetch}
}));

test('V041 G1 协议错误、响应超大、其他异常分类，不额外计次或保存原文',()=>school(async s=>{

 for(const [value,expected,calls] of [[{content:'invalid private text'},'protocol_invalid',2],[{content:'x'.repeat(500001)},'response_too_large',1],[()=>{throw Error('private failure')},'other',1]]){model(s,value);ok(await ai(s,'settings/propose',{instruction:"调整设置"}),502);assert.equal(lastFailure(s),expected);assert.equal(s.modelCalls.length,calls)}assert.equal(ok(await call(s,'ai/usage')).fast.used,0);assert.ok(!JSON.stringify(usage(s)).includes('private'));
 assert.equal(aiFailureReason(new HttpError(403,'private','forbidden')),'other');
}));

test('V041 G1 提供方JSON包装损坏或超过2MiB受限，无真实网络',()=>school(async s=>{
 const old=globalThis.fetch;model(s);s.f.env.DEEPSEEK_API_KEY='local-test-key-not-live';delete s.f.env.AI_PROVIDER;
 try{for(const [body,reason] of [['not JSON','protocol_invalid'],['x'.repeat(2*1024*1024+1),'response_too_large']]){globalThis.fetch=async(url,init)=>String(url).startsWith('https://api.deepseek.com/')?new Response(body):old(url,init);ok(await ai(s,'settings/propose',{instruction:"调整设置"}),502);assert.equal(lastFailure(s),reason)}assert.equal(ok(await call(s,'ai/usage')).fast.used,0)}finally{globalThis.fetch=old}
}));

test('V041 G1 平台按day/tenant/tool附failure_reasons，旧失败归other',()=>school(async s=>{
 model(s,()=>{const e=Error('no body');e.ai_failure_reason='provider_http_402';throw e});ok(await ai(s,'settings/propose',{instruction:"调整设置"}),502);
 model(s,{content:'invalid'});ok(await ai(s,'settings/propose',{instruction:"调整设置"}),502);model(s);ok(await ai(s,'settings/propose',{instruction:"调整设置"}));
 const day=new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'});for(const group of ['day','tenant','tool']){const r=ok(await ops(s,'ai/usage?from='+day+'&to='+day+'&group='+group+'&tenant_id='+s.t.id));assert.equal(r.items.reduce((n,x)=>n+x.failed,0),2);const reasons=r.items[0].failure_reasons;assert.equal(reasons.provider_http_402,1);assert.equal(reasons.protocol_invalid,1);assert.equal(Object.values(reasons).reduce((n,x)=>n+x,0),r.items[0].failed)}
}));

after(async()=>{await mkdir('work/v041',{recursive:true});await writeFile('work/v041/http-ai-'+(process.env.TEST_BUNDLE==='1'?'bundle':'source')+'.json',JSON.stringify({local_only:true,examples:httpExamples},null,2)+'\n')});
