// 任务 2：Cloudflare D1 / R2 模拟器与线上行为一致性边界测试（超限报错、限内通过）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { LocalD1, fixture } from "./support.mjs";
import { LocalR2 } from "./r2.mjs";
import { validateD1 } from "./d1-emulator.mjs";
import { refreshGalleryStorage } from "../src/server/gallery-storage.js";
import { setup } from "./fixtures-credit.mjs";

function withD1(fn, options) {
  const db = new LocalD1(options);
  return Promise.resolve()
    .then(() => fn(db))
    .finally(() => {
      db.limits.close();
      db.raw.close();
    });
}

test("D1 一致性：绑定参数类型校验（拒绝 undefined/NaN/Infinity/BigInt/对象；接受 null/bool/ArrayBuffer/Uint8Array）", () =>
  withD1(async (db) => {
    for (const bad of [undefined, NaN, Infinity, -Infinity, 1n, { a: 1 }, () => {}])
      assert.throws(() => db.prepare("SELECT ?").bind(bad), /D1_TYPE_ERROR/);

    const okRow = await db
      .prepare("SELECT ? AS a, ? AS b, ? AS c, ? AS d, ? AS e")
      .bind(null, true, false, new Uint8Array([1, 2, 3]).buffer, new Uint8Array([4, 5]))
      .first();
    assert.equal(okRow.a, null);
    assert.equal(okRow.b, 1);
    assert.equal(okRow.c, 0);
    assert.equal(okRow.d.length, 3);
    assert.equal(okRow.e.length, 2);

    // 序号占位符 ?NNN 超过 100 拒绝，100 以内通过。
    assert.throws(() => db.prepare("SELECT ?101"), /D1_TOO_MANY_PARAMETERS/);
    assert.doesNotThrow(() => validateD1("SELECT ?100", Array(100).fill(1)));
  }));

test("D1 一致性：compound SELECT 5 段上限与注释/引号词法隔离", () =>
  withD1(async (db) => {
    const five = Array(5).fill("SELECT 1").join(" UNION ALL ");
    const six = Array(6).fill("SELECT 1").join(" UNION ALL ");
    assert.equal((await db.prepare(five).all()).results.length, 5);
    assert.throws(() => db.prepare(six), /D1_TOO_MANY_COMPOUND_TERMS/);

    // 嵌套子查询各自计数（每层 ≤ 5 段）允许通过。
    const nested =
      "SELECT * FROM (" +
      five +
      ") UNION ALL SELECT * FROM (" +
      five +
      ")";
    assert.equal((await db.prepare(nested).all()).results.length, 10);

    // 字符串字面量与 SQL 注释中的 UNION 不计入段数。
    const commented =
      "SELECT 'UNION UNION UNION UNION UNION UNION' AS txt /* UNION UNION UNION UNION UNION */ -- UNION UNION\n";
    assert.equal((await db.prepare(commented).first("txt")).startsWith("UNION"), true);
  }));

test("D1 一致性：任意 SQL 函数参数上限 32（非仅 JSON 函数），且不误拦表列清单", () =>
  withD1(async (db) => {
    const ok32 = "SELECT max(" + Array(32).fill("1").join(",") + ") AS v";
    const bad33 = "SELECT max(" + Array(33).fill("1").join(",") + ") AS v";
    assert.equal(await db.prepare(ok32).first("v"), 1);
    assert.throws(() => db.prepare(bad33), /D1_TOO_MANY_FUNCTION_ARGUMENTS/);

    const okPrintf = "SELECT printf('" + "%s".repeat(31) + "'," + Array(31).fill("'a'").join(",") + ") AS s";
    const badPrintf = "SELECT printf('" + "%s".repeat(32) + "'," + Array(32).fill("'a'").join(",") + ") AS s";
    assert.equal((await db.prepare(okPrintf).first("s")).length, 31);
    assert.throws(() => db.prepare(badPrintf), /D1_TOO_MANY_FUNCTION_ARGUMENTS/);

    // CREATE TABLE / INSERT 列清单超过 32 列（但在 100 列以内）不应被误判为函数参数。
    const cols40 = Array.from({ length: 40 }, (_, i) => "c" + i);
    await db.prepare("CREATE TABLE wide40(" + cols40.map((c) => c + " INTEGER").join(",") + ")").run();
    await db
      .prepare("INSERT INTO wide40(" + cols40.join(",") + ") VALUES(" + Array(40).fill("1").join(",") + ")")
      .run();
    assert.equal(await db.prepare("SELECT c39 FROM wide40").first("c39"), 1);
  }));

test("D1 一致性：单表最多 100 列、查询结果最多 100 列、单次结果集上限 50MB", () =>
  withD1(async (db) => {
    const cols100 = Array.from({ length: 100 }, (_, i) => "c" + i);
    const cols101 = Array.from({ length: 101 }, (_, i) => "c" + i);

    await db.prepare("CREATE TABLE ok100(" + cols100.map((c) => c + " INTEGER").join(",") + ")").run();
    await assert.rejects(
      db.prepare("CREATE TABLE bad101(" + cols101.map((c) => c + " INTEGER").join(",") + ")").run(),
      /D1_TOO_MANY_COLUMNS/,
    );

    const select100 = "SELECT " + cols100.map((_, i) => i + " AS c" + i).join(",");
    const select101 = "SELECT " + cols101.map((_, i) => i + " AS c" + i).join(",");
    assert.equal(Object.keys(await db.prepare(select100).first()).length, 100);
    await assert.rejects(db.prepare(select101).first(), /D1_TOO_MANY_COLUMNS/);
    await assert.rejects(db.prepare(select101).all(), /D1_TOO_MANY_COLUMNS/);
  }));

test("D1 一致性：结果集总大小超过上限报错，限内通过", () =>
  withD1(
    async (db) => {
      await db.prepare("CREATE TABLE blobs(id INTEGER PRIMARY KEY, body TEXT)").run();
      await db.prepare("INSERT INTO blobs VALUES(1, ?), (2, ?)").bind("a".repeat(300), "b".repeat(300)).run();
      // 限制设为 1000 字节：单行（~320B）通过，两行（~640B）通过，三行+超限失败。
      assert.equal((await db.prepare("SELECT * FROM blobs").all()).results.length, 2);
      await db.prepare("INSERT INTO blobs VALUES(3, ?)").bind("c".repeat(500)).run();
      await assert.rejects(db.prepare("SELECT * FROM blobs").all(), /D1_RESULT_SIZE_EXCEEDED/);
    },
    { maxResultBytes: 1000 },
  ));

test("D1 一致性：禁止显式事务 SQL、仅允许官方 17 项 PRAGMA、事务级外键与 CREATE TRIGGER 不误拦", () =>
  withD1(async (db) => {
    // 默认外键开启。
    assert.equal(await db.prepare("PRAGMA foreign_keys").first("foreign_keys"), 1);

    // 显式事务与保存点均拒绝。
    for (const stmt of ["BEGIN", "BEGIN IMMEDIATE", "COMMIT", "END TRANSACTION", "ROLLBACK", "SAVEPOINT s1", "RELEASE s1"])
      assert.throws(() => db.prepare(stmt), /D1_TRANSACTION_NOT_ALLOWED/);
    assert.throws(() => db.prepare("   -- 注释\n  "), /No SQL statements detected/);

    // 不支持的 PRAGMA 与 PRAGMA optimize(-1) 拒绝；官方支持项通过。
    for (const bad of ["PRAGMA journal_mode=WAL", "PRAGMA cache_size=2000", "PRAGMA user_version=1", "PRAGMA optimize(-1)"])
      assert.throws(() => db.prepare(bad), /D1_UNSUPPORTED_PRAGMA/);

    await db.prepare("CREATE TABLE p(id INTEGER PRIMARY KEY)").run();
    await db.prepare("CREATE TABLE c(id INTEGER PRIMARY KEY, pid INTEGER REFERENCES p(id))").run();
    assert.ok(Array.isArray((await db.prepare("PRAGMA foreign_key_list(c)").all()).results));
    assert.ok(Array.isArray((await db.prepare("PRAGMA table_list").all()).results));

    // CREATE TRIGGER 内含 BEGIN ... END 不应被误判为显式事务。
    await db
      .prepare("CREATE TRIGGER trg_p AFTER INSERT ON p BEGIN SELECT 1; END")
      .run();

    // batch 内 PRAGMA defer_foreign_keys=ON 允许先插子行再插父行，提交时仍校验外键。
    await db.batch([
      db.prepare("PRAGMA defer_foreign_keys=ON"),
      db.prepare("INSERT INTO c VALUES(1, 10)"),
      db.prepare("INSERT INTO p VALUES(10)"),
    ]);
    assert.equal(await db.prepare("SELECT COUNT(*) n FROM c").first("n"), 1);

    // batch 内未修复的外键违例在提交时回滚。
    await assert.rejects(
      db.batch([
        db.prepare("PRAGMA defer_foreign_keys=ON"),
        db.prepare("INSERT INTO c VALUES(2, 999)"),
      ]),
      /FOREIGN KEY/,
    );
    assert.equal(await db.prepare("SELECT COUNT(*) n FROM c").first("n"), 1);

    // first(colName) 缺失列抛 D1_COLUMN_NOTFOUND；raw({columnNames}) 返回二维数组。
    await assert.rejects(db.prepare("SELECT 1 AS a").first("missing"), /D1_COLUMN_NOTFOUND/);
    assert.deepEqual(await db.prepare("SELECT 1 AS a, 'x' AS b").raw({ columnNames: true }), [
      ["a", "b"],
      [1, "x"],
    ]);
  }));

test("R2 一致性：key/metadata 上限、head/get(range/onlyIf)、delete 1000 上限、list(limit/cursor/delimiter)", async () => {
  const r2 = new LocalR2();

  // 不存在的对象 head / get 均返回 null。
  assert.equal(await r2.head("missing"), null);
  assert.equal(await r2.get("missing"), null);

  // key 长度 ≤ 1024 字节通过，1025 字节拒绝。
  const key1024 = "k".repeat(1024);
  const putOk = await r2.put(key1024, "hello world", {
    httpMetadata: { contentType: "text/plain" },
    customMetadata: { env: "test" },
  });
  assert.equal(putOk.key, key1024);
  assert.equal(putOk.size, 11);
  assert.equal(putOk.httpMetadata.contentType, "text/plain");
  await assert.rejects(r2.put("k".repeat(1025), "x"), /R2_KEY_TOO_LONG/);

  // metadata 超过 8192 字节拒绝。
  await assert.rejects(
    r2.put("meta-too-big", "x", { customMetadata: { big: "a".repeat(8200) } }),
    /R2_METADATA_TOO_BIG/,
  );

  // head 返回元数据，不含 body。
  const head = await r2.head(key1024);
  assert.equal(head.size, 11);
  assert.equal(head.etag, putOk.etag);
  assert.equal("text" in head, false);

  // get 支持 range (offset/length 与 suffix) 与 onlyIf。
  const part = await r2.get(key1024, { range: { offset: 6, length: 5 } });
  assert.equal(await part.text(), "world");
  assert.deepEqual(part.range, { offset: 6, length: 5 });
  const tail = await r2.get(key1024, { range: { suffix: 5 } });
  assert.equal(await tail.text(), "world");
  const condFail = await r2.get(key1024, { onlyIf: { etagMatches: "deadbeef" } });
  assert.equal(condFail.key, key1024);
  assert.equal("text" in condFail, false);
  const putCondFail = await r2.put(key1024, "nope", { onlyIf: { etagDoesNotMatch: "*" } });
  assert.equal(putCondFail, null);

  // delete 单次最多 1000 个 key。
  await assert.rejects(
    r2.delete(Array.from({ length: 1001 }, (_, i) => "k" + i)),
    /R2_DELETE_TOO_MANY_KEYS/,
  );
  await r2.delete(Array.from({ length: 1000 }, (_, i) => "absent/" + i));

  // list：拒绝空/非法 cursor (10023)、拒绝 limit<1 或 >1000、未截断时不返回 cursor、支持 delimiter。
  await r2.put("a/1.txt", "1");
  await r2.put("a/2.txt", "2");
  await r2.put("a/sub/3.txt", "3");
  await r2.put("a/sub/4.txt", "4");
  await assert.rejects(r2.list({ cursor: "" }), /10023/);
  await assert.rejects(r2.list({ cursor: "bad" }), /10023/);
  await assert.rejects(r2.list({ limit: 0 }), /R2_INVALID_LIMIT/);
  await assert.rejects(r2.list({ limit: 1001 }), /R2_INVALID_LIMIT/);

  const delimPage = await r2.list({ prefix: "a/", delimiter: "/" });
  assert.deepEqual(delimPage.objects.map((x) => x.key), ["a/1.txt", "a/2.txt"]);
  assert.deepEqual(delimPage.delimitedPrefixes, ["a/sub/"]);
  assert.equal(delimPage.truncated, false);
  assert.equal("cursor" in delimPage, false, "未截断时不应返回 cursor");

  const p1 = await r2.list({ prefix: "a/", limit: 2 });
  assert.equal(p1.truncated, true);
  assert.ok(p1.cursor);
  const p2 = await r2.list({ prefix: "a/", limit: 2, cursor: p1.cursor });
  assert.equal(p2.truncated, false);
  assert.equal("cursor" in p2, false);
  assert.equal(p1.objects.length + p2.objects.length, 4);
});

test("R2 一致性：LocalR2.head() 真实命中 gallery-storage 生产分支并返回准确字节数", async () => {
  const f = await fixture();
  try {
    const s = await setup(f, 0, "r2head");
    const r2Key = "promo/" + s.t.id + "/gallery/img_head_check";
    const encoded = "A".repeat(1234);
    await f.env.CHANNEL_MEDIA.put(r2Key, encoded, { httpMetadata: { contentType: "text/plain" } });
    // 写入 bytes=0 的待测图库记录，触发 refreshGalleryStorage 走 head() 分支。
    f.db.raw
      .prepare(
        "INSERT INTO gallery_images(tenant_id,id,r2_key,mime,width,height,tags_json,consent,bytes,created_at,created_by,updated_at,updated_by) VALUES(?,?,?,?,?,?,?,?,0,?,?,?,?)",
      )
      .run(s.t.id, "img_head_check", r2Key, "image/png", 10, 10, "[]", 0, Date.now(), s.user.id, Date.now(), s.user.id);
    let headCalls = 0;
    const origHead = f.env.CHANNEL_MEDIA.head.bind(f.env.CHANNEL_MEDIA);
    f.env.CHANNEL_MEDIA.head = async (k) => {
      headCalls++;
      return origHead(k);
    };
    const storage = await refreshGalleryStorage(f.env, s.r);
    assert.equal(headCalls, 1, "应走生产 CHANNEL_MEDIA.head() 分支而非回退 get()");
    assert.equal(storage.used, 1234);
    assert.equal(storage.complete, true);
  } finally {
    f.restore();
  }
});
