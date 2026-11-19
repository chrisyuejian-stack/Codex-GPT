import {rolesInput} from '../src/server/accounts.js';
import {can,modules} from '../src/server/permissions.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { fixture } from "./support.mjs";

import { setup } from "./fixtures-credit.mjs";

const PASSWORD='PhaseTwoSecure9';
const examples=[];
async function call(f,path,method='GET',data,cookie='',ops=false,extra={}) {
  const origin=ops?'https://console.school.test':'https://school.test';
  const response=await f.request(origin+path,{method,headers:{Origin:origin,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{}),...(ops?{'Cf-Access-Jwt-Assertion':f.access}:{}),...extra},body:data===undefined?undefined:JSON.stringify(data)});
  const text=await response.text();let body;try {body=JSON.parse(text);}catch {body={text};}
  if(path.includes('/auth/')||path.includes('/guardians')||path.includes('/parents/')||path.includes('/ops/')||path.includes('/parent/children')||path.includes('/public/tenant-brand')||path.endsWith('/api/me')||path.endsWith('/api/password')||path.includes('/supervisors')||/\/api\/(?:accounts|data\/students)(?:\/|$)/.test(path))
    examples.push({request:{method,path,body:data??null,actor:ops?'platform_admin':cookie.startsWith('__Host-yx')?'root_session':'path_session_or_anonymous'},response:{status:response.status,body}});
  return {status:response.status,body,text,cookie:response.headers.get('set-cookie')?.split(';')[0],queries:Number(response.headers.get('x-test-d1-queries'))};
}
function ok(x,status=200) {assert.equal(x.status,status,x.text);return x.body;}

const scoped=(s,path,method='GET',d,token=s.token)=>call(s.f,'/'+s.t.slug+'/api/'+path,method,d,'channel_session='+token);

async function withSetup(fn,n=2) {const f=await fixture();try {await fn({...await setup(f,n,'identity'),f});}finally {f.restore();}}

// §7 11,19a: count actual PBKDF2 operations, rather than comparing wall-clock time.

test('YX2 学员新增字段保存读取，伪造跨机构来源线索拒绝',()=>withSetup(async s=>{
  let old=ok(await scoped(s,'data/students/'+s.students[0])).record;
  ok(await scoped(s,'data/students/'+old.id,'PATCH',{version:old.version,nickname:'小星',parent_consent_media:true,source_lead_id:null,report_class_id:null}));
  const updated=ok(await scoped(s,'data/students/'+old.id)).record;assert.equal(updated.nickname,'小星');assert.equal(updated.parent_consent_media,1);
  ok(await scoped(s,'data/students/'+old.id,'PATCH',{version:updated.version,source_lead_id:'rec_ffffffffffffffffffffffff'}),404);
}));

test('YX2 新角色组合合法性与权限并集，个人角色不能混用',async()=>{
  assert.deepEqual(rolesInput(['supervisor','consultant','academic','finance']),['supervisor','consultant','academic','finance']);
  for(const one of ['teacher','student']) {assert.deepEqual(rolesInput([one]),[one]);assert.throws(()=>rolesInput([one,'consultant']));}
  const policy={modules:Object.fromEntries(modules.map(x=>[x,true])),settings:{},rights:[]};

  assert.equal(can({roles:['consultant']},policy,'prices','write'),false);
  assert.equal(can({roles:['consultant']},policy,'settings','propose'),true);

});
