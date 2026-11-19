import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

test("第七阶段：全部自有前端无HTML注入汇、内联事件或动态执行；生产包压缩混淆、不含源码/映射/测试数据", async () => {
  for (const dir of ["tenant", "console"]) {
    const source = await readFile("src/" + dir + "/app.js", "utf8");
    assert.ok(
      !/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\s*\(|new\s+Function\s*\(/.test(
        source,
      ),
    );
    const html = await readFile("src/" + dir + "/index.html", "utf8");
    assert.ok(!/\son\w+\s*=|<script(?![^>]*\bsrc=)/i.test(html));
    assert.ok(source.includes(".textContent = text"));
  }
  const walk = async (dir) =>
    (
      await Promise.all(
        (await readdir(dir, { withFileTypes: true })).map((x) =>
          x.isDirectory() ? walk(dir + "/" + x.name) : [dir + "/" + x.name],
        ),
      )
    ).flat();
  const files = await walk("dist");
  assert.equal(files.length, 6);
  assert.ok(!files.some(p=>/console|share/.test(p)));
  assert.ok(!files.some((p) => /\.map$|\/src\/|\/tests\//.test(p)));
  for (const file of [
    "dist/_worker.js",
    "dist/assets/tenant.js",
    "backup-dist/backup-worker.js",
  ]) {
    const code = await readFile(file, "utf8");
    assert.ok(!code.includes("sourceMappingURL"));
    assert.ok(code.split("\n").length <= 4);
    assert.ok(
      !/function (resolveTenant|personalPay|renewalNotice)\(/.test(code),
    );
    assert.ok(!/fixture-valid|preview-school|FixtureSecure/.test(code));
  }
});
