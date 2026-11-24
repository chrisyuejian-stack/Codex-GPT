import { tenantAssets } from '../scripts/frontend-bundle.mjs';
import {mkdirSync,writeFileSync} from 'node:fs';
import {emulateD1,normalizeD1Param,validateD1} from './d1-emulator.mjs';
import {LocalR2} from './r2.mjs';
import {AsyncLocalStorage} from 'node:async_hooks';
import {DatabaseSync} from 'node:sqlite';
import {readFile} from 'node:fs/promises';
import sourceWorker from '../src/server/worker.js';
import {b64,bytes} from '../src/server/core.js';
const worker=process.env.TEST_BUNDLE==='1'?(await import('../dist/_worker.js')).default:sourceWorker;
export class LocalD1 {
  constructor(options = {}) {
    this.raw = new DatabaseSync(":memory:");
    // 与线上 Cloudflare D1 一致：默认开启外键约束检查。
    this.raw.exec("PRAGMA foreign_keys = ON");
    this.limits = emulateD1(this.raw, options);
    this.context = new AsyncLocalStorage();
    this.queryLimit = 40;
    this.queryReports = [];
  }
  count(statements = 1) {
    const value = this.context.getStore();
    if (value) {
      value.queries++;
      value.statements += statements;
      if (value.queries > this.queryLimit)
        throw Error("D1_QUERY_BUDGET_EXCEEDED");
    }
  }
  async measure(fn, metadata = {}) {
    return this.context.run({ queries: 0, statements: 0 }, async () => {
      const response = await fn(),
        stats = { ...this.context.getStore() };
      response.headers.set("x-test-d1-queries", String(stats.queries));
      response.headers.set("x-test-d1-statements", String(stats.statements));
      this.queryReports.push({
        ...stats,
        status: response.status,
        ...metadata,
      });
      return response;
    });
  }
  prepare(query) {
    validateD1(query);
    this.limits.installRows();
    const db = this;
    return {
      query,
      params: [],
      bind(...p) {
        validateD1(query, p);
        this.params = p.map(normalizeD1Param);
        return this;
      },
      async first(colName) {
        db.count();
        const stmt = db.raw.prepare(query);
        const colCount = stmt.columns().length;
        const row = db.limits.result(stmt.get(...this.params), colCount) || null;
        if (!row) return null;
        if (colName !== undefined) {
          if (!Object.hasOwn(row, colName))
            throw Error("D1_COLUMN_NOTFOUND: Column not found: " + colName);
          return row[colName];
        }
        return row;
      },
      async all() {
        db.count();
        const stmt = db.raw.prepare(query);
        const colCount = stmt.columns().length;
        return {
          success: true,
          results: db.limits.result(stmt.all(...this.params), colCount),
        };
      },
      async raw({ columnNames = false } = {}) {
        db.count();
        const stmt = db.raw.prepare(query);
        const cols = stmt.columns();
        const rows = db.limits.result(stmt.all(...this.params), cols.length);
        const out = rows.map((row) => cols.map((c) => row[c.name]));
        if (columnNames) out.unshift(cols.map((c) => c.name));
        return out;
      },
      async run() {
        db.count();
        const stmt = db.raw.prepare(query);
        const cols = stmt.columns();
        if (cols.length) {
          const results = db.limits.result(stmt.all(...this.params), cols.length);
          return { success: true, results, meta: { changes: 0 } };
        }
        const ddl = /^\s*(?:CREATE|ALTER)\b/i.test(query);
        if (ddl) db.raw.exec("BEGIN IMMEDIATE");
        try {
          const x = stmt.run(...this.params);
          db.limits.installRows();
          if (ddl) db.raw.exec("COMMIT");
          return { success: true, results: [], meta: { changes: Number(x.changes) } };
        } catch (e) {
          if (ddl) db.raw.exec("ROLLBACK");
          throw e;
        }
      },
    };
  }
  async batch(statements) {
    this.limits.installRows();
    for (const s of statements) validateD1(s.query, s.params);
    this.count(statements.length);
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const s of statements) {
        const statement = this.raw.prepare(s.query);
        const cols = statement.columns();
        if (cols.length)
          results.push({
            success: true,
            results: this.limits.result(statement.all(...s.params), cols.length),
            meta: { changes: 0 },
          });
        else
          results.push({
            success: true,
            results: [],
            meta: { changes: Number(statement.run(...s.params).changes) },
          });
      }
      this.limits.installRows();
      this.raw.exec("COMMIT");
      // D1 PRAGMA 仅在当前事务生效；提交后恢复默认外键检查。
      this.raw.exec("PRAGMA foreign_keys = ON");
      return results;
    } catch (e) {
      this.raw.exec("ROLLBACK");
      this.raw.exec("PRAGMA foreign_keys = ON");
      throw e;
    }
  }
}
export async function fixture({migrateIncome=true,migrateSettings=true,migratePlans=true,migrateAi=true,migrateGrowth=true,migratePlatform=true,migrateArticle=true,migrateProspects=true,migrateStorage=true,migrateRemoval=true,migrateSingleTenant=true,legacyUrls=true}={}){
  const db = new LocalD1();
  db.raw.exec(
    await readFile(
      new URL("../migrations/0001_foundation.sql", import.meta.url),
      "utf8",
    ),
  );
  db.raw.exec(
    await readFile(
      new URL("../migrations/0003_scheduling.sql", import.meta.url),
      "utf8",
    ),
  );
  db.raw.exec(
    await readFile(
      new URL("../migrations/0004_credits.sql", import.meta.url),
      "utf8",
    ),
  );
  db.raw.exec(
    await readFile(
      new URL("../migrations/0005_integer_money.sql", import.meta.url),
      "utf8",
    ),
  );
  db.raw.exec(
    await readFile(
      new URL("../migrations/0006_finance.sql", import.meta.url),
      "utf8",
    ),
  );
  db.raw.exec(
    await readFile(
      new URL("../migrations/0007_settlement_fingerprint.sql", import.meta.url),
      "utf8",
    ),
  );
  db.raw.exec(
    await readFile(
      new URL("../migrations/0008_mobile_reviews.sql", import.meta.url),
      "utf8",
    ),
  );
  db.raw.exec(
    await readFile(
      new URL("../migrations/0009_tools.sql", import.meta.url),
      "utf8",
    ),
  );
  db.raw.exec(
    await readFile(
      new URL("../migrations/0010_promo.sql", import.meta.url),
      "utf8",
    ),
  );
  db.raw.exec(
    await readFile(
      new URL("../migrations/0011_promo_image_limits.sql", import.meta.url),
      "utf8",
    ),
  );
  db.raw.exec(
    await readFile(
      new URL("../migrations/0012_ui_rebuild.sql", import.meta.url),
      "utf8",
    ),
  );
  db.raw.exec(
    await readFile(
      new URL("../migrations/0013_promo_rebuild.sql", import.meta.url),
      "utf8",
    ),
  );
  db.raw.exec(await readFile(new URL("../migrations/0014_debt_and_balance.sql", import.meta.url), "utf8"));
  db.raw.exec(await readFile(new URL("../migrations/0015_delete_capabilities.sql", import.meta.url), "utf8"));
  db.raw.exec(await readFile(new URL("../migrations/0016_page_query_indexes.sql", import.meta.url), "utf8"));
  db.raw.exec(await readFile(new URL("../migrations/0017_student_schedule_indexes.sql", import.meta.url), "utf8"));
  if (migrateIncome) db.raw.exec(await readFile(new URL("../migrations/0018_credit_income_and_schedule_guards.sql", import.meta.url), "utf8"));
  db.raw.exec(await readFile(new URL("../migrations/0019_identity_and_institutions.sql", import.meta.url), "utf8"));
  if(migrateSettings) db.raw.exec(await readFile(new URL("../migrations/0020_settings_and_templates.sql", import.meta.url), "utf8"));
  if(migrateSettings && migratePlans) db.raw.exec(await readFile(new URL("../migrations/0021_course_plans.sql", import.meta.url), "utf8"));
  if(migrateSettings && migratePlans && migrateAi) db.raw.exec(await readFile(new URL("../migrations/0022_content_and_ai.sql", import.meta.url), "utf8"));
  if(migrateSettings && migratePlans && migrateAi && migrateGrowth) db.raw.exec(await readFile(new URL("../migrations/0023_feedback_and_growth_reports.sql", import.meta.url), "utf8"));
  if(migrateSettings && migratePlans && migrateAi && migrateGrowth && migratePlatform) db.raw.exec(await readFile(new URL("../migrations/0024_platform_management.sql", import.meta.url), "utf8"));
  if(migrateSettings && migratePlans && migrateAi && migrateArticle) db.raw.exec(await readFile(new URL("../migrations/0025_article_metadata.sql", import.meta.url), "utf8"));
  if(migrateSettings && migratePlans && migrateProspects) db.raw.exec(await readFile(new URL('../migrations/0026_plan_prospects.sql',import.meta.url),'utf8'));
  if(migrateSettings && migrateStorage) db.raw.exec(await readFile(new URL('../migrations/0027_gallery_storage.sql',import.meta.url),'utf8'));
  if(migrateSettings && migratePlans && migrateStorage) db.raw.exec(await readFile(new URL('../migrations/0028_plan_v2.sql',import.meta.url),'utf8'));
  if (migrateRemoval) db.raw.exec(await readFile(new URL("../migrations/0029_remove_modules.sql", import.meta.url), "utf8"));
  if(migrateSingleTenant){db.raw.exec(await readFile('migrations/0030_single_tenant.sql','utf8'));db.raw.exec(await readFile('migrations/0031_backup_and_todo.sql','utf8'));db.raw.exec(await readFile('migrations/0032_backup_todo_actions.sql','utf8'));db.raw.exec(await readFile('migrations/0033_lead_followups.sql','utf8'));db.raw.exec(await readFile('migrations/0035_lesson_unit_minutes.sql','utf8'));}
 const env={CHANNEL_DB:db,CHANNEL_BACKUPS:new LocalR2(),CHANNEL_MEDIA:new LocalR2(),APP_HOST:'school.test',FIELD_KEY:b64(bytes(32)),BACKUP_KEY:b64(bytes(32)),HMAC_KEY:b64(bytes(32)),PW_PEPPER:b64(bytes(32)),SETUP_KEY:b64(bytes(32))};
 env.ASSETS={fetch:async(req)=>{const path=new URL(req.url).pathname,map={'/tenant.html':'src/tenant/index.html','/assets/tenant.js':'src/tenant/app.js','/assets/tenant.css':'src/tenant/app.css','/assets/tenant-fonts.css':'src/tenant/fq-fonts.css','/manifest.webmanifest':'src/tenant/pwa/manifest.webmanifest','/sw.js':'src/tenant/pwa/sw.js','/assets/icon-192.png':'src/tenant/pwa/icon-192.png','/assets/icon-512.png':'src/tenant/pwa/icon-512.png','/assets/icon-maskable-512.png':'src/tenant/pwa/icon-maskable-512.png','/assets/apple-touch-icon.png':'src/tenant/pwa/apple-touch-icon.png'};if(!map[path])return new Response('not found',{status:404});
 if(process.env.TEST_BUNDLE!=='1'&&['/assets/tenant.js','/assets/tenant.css','/assets/tenant-fonts.css'].includes(path)){const a=await tenantAssets();return new Response(path.endsWith('.js')?a.js:path.endsWith('-fonts.css')?a.deferredCss:a.css,{headers:{'Content-Type':path.endsWith('.js')?'text/javascript':'text/css'}});}
 return new Response(await readFile(process.env.TEST_BUNDLE==='1'?'dist'+path:map[path]),{headers:{'Content-Type':path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'text/html'}});}};
 const originalFetch=globalThis.fetch,children=[],instances=new Map();
 const directRequest=async(input,options={})=>db.measure(()=>{const req=new Request(input,options);if(options.cf)Object.defineProperty(req,'cf',{value:options.cf});return worker.fetch(req,env);},{url:String(input),method:options.method||'GET'});
 const f={env,db,instances,access:'',adminCookie:'',fork:async()=>{const child=await fixture({legacyUrls});children.push(child);return child;},request:async(input,options={})=>{
  if(!legacyUrls)return directRequest(input,options);
  const url=new URL(input),segment=url.pathname.split('/')[1],target=instances.get(segment);
  const headers=new Headers(options.headers);if(headers.has('Cookie'))headers.set('Cookie',headers.get('Cookie').replace(/(?:channel_session|__Host-yx_session)=/g,'__Host-fengqin_session='));
  if(target){url.pathname='/'+url.pathname.split('/').slice(2).join('/');return target.directRequest(url,{...options,headers});}
  return directRequest(url,{...options,headers});
 },directRequest,restore(){for(const child of children)child.restore();if(process.env.QUERY_REPORT_DIR){mkdirSync(process.env.QUERY_REPORT_DIR,{recursive:true});writeFileSync(process.env.QUERY_REPORT_DIR+'/'+crypto.randomUUID()+'.json',JSON.stringify(db.queryReports));}globalThis.fetch=originalFetch;db.limits.close();db.raw.close();if(db.queryReports.some(x=>x.queries>db.queryLimit))throw Error('HTTP 请求超过 D1 查询预算');}};return f;
}
