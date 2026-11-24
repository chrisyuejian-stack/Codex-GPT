# 进度：GPT（Codex）

追加式，按日期写：审查意见、后端改动、发现的问题。恢复工作后，先补审 Antigravity 代管期间的后端改动：迁移 0033/0034/0035、`/api/teacher/today`、学员尾号搜索、机构信息编辑、课程形式合并、排课时长换算。不要改 `任务板.md`、`项目状态.md`（由 Claude 统一维护）。


## 恢复后的第一步清单（2026-11-23，Claude 写）
1. 读 `AGENTS.md`、`项目状态.md` 第 4 节、`任务板.md` 末尾、`部署手册.md`、`进度_Antigravity.md`。
2. 补审后端改动（按风险从高到低）：迁移 0035（加列 + 重建 6 个 `course_limits_*` 触发器，旧数据与「已存在的行」的触发器行为）；迁移 0034（课酬标准合并冲突规则，已结算月份的课酬不得变化）；排课总时长换算（`scheduling.js` 的 `unitMinutes`，所有创建课程入口是否走同一套）；`normalizeFormat` 全覆盖（导入、AI、备份恢复）；迁移 0033 回访接口；学员手机尾号搜索（Worker 内解密比对，上限 5000 条）；机构信息编辑（联系说明加密）；`/api/teacher/today`、read-batch 白名单；机构记录缓存。
3. 审查 #22 的后端清理清单（`docs/fengqin/后端清理清单_2026-11-22.md`，33 项候选），确认后由 Antigravity 执行（任务板 #5）。
4. 发现问题写进本文件并通知用户；改动走 `codex/<主题>` 分支与 PR。


## GPT：本轮两PR的共同记录（2026-11-24）

为避免并行PR在追加文档上冲突，两个分支携带完全相同的本轮记录。补审修复对应`codex/backend-review`，12项清理对应`codex/backend-cleanup-batch1`；各自的行为/接口变化只在对应PR合入后生效，记录不表示已经部署。


## 2026-11-24：恢复后补审与任务 #5 的33项裁定（main@7d2bfe3）

基线：从最新 `origin/main@7d2bfe3`（PR #37，业务代码含 PR #21–#36）开 `codex/backend-review`；按用户顺序读 AGENTS、交接进度、0034/0035 演练、接口末节、迁移登记和清理清单。以下为源码及本地模拟器结论，既有生产部署/临时库演练只引用 Antigravity 的记录，本人没有连接或改写生产。

### 一、按风险排序的书面结论

1. **0035与排课/课酬：通过，补测试加固。** 新建/编辑课程和模板共用 `resolveScheduleDuration`，批量生成再走同一 normalizer，补课预查和写入经 `prepareMakeupLesson` 共用校验。`45×2=90`；`0.5×45=23` 为已确认的四舍五入规则；跨午夜400，非法半课时步进422。Excel导入当前仅有学员/老师/余额，没有另一个课表导入入口；不把不存在的课表导入宣称为已验证。新增测试实际生成模板课程、预查并保存半课时补课、按课次计200而非100；原测试保留按units计酬与后半段冲突验证。
   - 真实0035脚本的独立触发器测试核对六个触发器：历史duration/units不被回写；不改非法旧值时可更新note，新增/改变非法值时拒绝，`unit_minutes=NULL` 的新增兼容分支仍只允许旧式30/45/60分钟。
   - 边界说明：回填无法从旧值推断30/45/60时用60兜底（例旧duration23、units0.5→unit_minutes60，但duration仍23）；触发器不强制历史duration等于新乘积。业务编辑会按新规则重算，不是纯note直写；历史异常值若将来需要纠偏，应单独预览处理，不能修改已上线迁移或锁月数据。
2. **0034课程形式合并与历史已结算金额：通过，原测试存在覆盖缺口，已补实测。** 写入、费率匹配/重叠检查、导入中文别名、导出标签统一class→group；当前AI上下文读取工具目录的form字段，不读取lessons.format，不存在另一个class分支；不把工具目录form（one_to_one/group/small_class/package/camp）混同于排课format强改。院校库扩展点保留。
   - 原 `format-merge` 标称已结算不变的测试实际没有提交/批准锁月，且没有注入重叠旧费率。新增回归通过财务提交→主管批准，注入class旧费率及新group重叠费率，再执行真实0034，逐字段比对锁月快照、settlements及payroll响应完全不变；rateLocks仍409阻止回改。恢复归一化另测多条冲突、created_at相同的id决胜及不改snapshot；真实预览→整体恢复另测兼容0035备份中的class和45×0.5=23。
   - 兼容范围是**当前结构35中的旧枚举**；结构33及更早明确422拒绝，不承诺跨结构自动升级。清理清单仍写33/下一迁移35已经过时，当前占用至0035，下一个可用号0036。
3. **机构信息、背景和安全：通过。** contact_text用AES-GCM及机构`:contact` AAD；GET/PATCH/409最新值、续费通知均正确解密，空串清空。写入只允许主管且白名单字段；version预读检查+批次guard防并发过写。login_bg校验PNG/JPEG/WebP魔数、base64及解码后≤204800字节；不是完整图像解码器。审计只写是否设置/变更等摘要，未写contact明文/密文和原图。现有settings-institution测试覆盖409、权限、边界、脱敏与备份往返。
4. **0033线索回访：通过。** tenant作用域、leads.read/update、operation_id归属、乐观锁及lead+followup+audit原子批次齐全；lost时记录与线索均清空next_followup；转换学员完整保留。相同operation_id、相同作者及线索重放不再次落记录；并发竞争可能先409，重试可得到重放结果。lead_followups已纳入全量备份、外键拓扑恢复；当前版本35的备份往返测试覆盖它（不是回退BACKUP_VERSION到33）。
5. **学员尾号搜索：两项P2，已复现并修复。** ①5001条有号码候选时原LIMIT5000返回成功但遗漏记录；②用另一个合法32字节FIELD_KEY或损坏密文时，原catch吞错误返回无匹配。新增测试先复现200/静默漏搜，再修为5001哨兵→422 phone_search_limit、解密失败→503 phone_search_unavailable；非法密钥仍走全局503 CONFIG_INVALID。不返回敏感内容，5000条完整搜索及普通文本/状态过滤仍通过。接口约定已追加，供Antigravity处理提示。此问题影响结果可信度，不涉及已落账金额或权限泄露。
6. **聚合读、缓存及其它提速改动：通过。** teacher/today要求teacher与teacher_id，课表/点名复用原鉴权，仅本人主讲的已结束未提交课程可带review，最多8条且多的由前端按原接口读。read-batch仅GET白名单，每条仍鉴权，排除有审计副作用的renewal-brand；并行读取没有移除锁月/权限复核。机构缓存按原始D1绑定隔离60秒、每次检查TENANT_ID、初始化和整体恢复主动失效，缓存不存授权信息。财务6个月并行计算和点名并行读取的业务计算路径、原子写入及D1限制未变。

**审查意见**：本地范围未发现P0/P1阻塞问题；合入本轮P2加固后可通过后端补审。触发器直接SQL测试、模拟器及浏览器冒烟不能替代真实D1恢复事务/生产验收；继续由Antigravity按部署手册执行上线和核对。0035新基准备份与次日03:00 R2落盘仍以其线上记录为准。

### 二、33项逐项裁定（先裁定，后另分支执行低/中风险清理）

已重新用rg交叉检索当前src/tenant、src/ui、src/shared、scripts、tests，包括动态字符串拼接和页面回退/导出链，不沿用清单的“#4完成即可删”假设。

| 编号 | 裁定 | 当前依据与调整原因 |
|---|---|---|
| 1.1 | 暂留，交Antigravity | tenant/index.html属前端，meta仍在；不越权修改。 |
| 1.2 | 暂留，随1.1联动 | Worker仍替换上述占位；单删会把模板token送到HTML。 |
| 1.3 | 可删，批次1 | secureResponse的login形参体内零使用，唯一调用固定false。 |
| 1.4 | 可删，批次1 | 登录夹具turnstile字段无人读取；保留所有登录断言。 |
| 1.5 | 可删，批次1 | 两个性能脚本TURNSTILE_MODE变量服务端零读取。 |
| 1.6 | 可删，批次1 | ACCESS_MODE测试赋值零读取；保留原控制台域名、权限及404防回归断言。 |
| 1.7 | 暂留，交Antigravity | remote-public仍检验1.1，待前端meta联动撤除；不可现在削弱公开页检查。 |
| 1.8 | 暂留历史脚本 | 同4.6；历史验收证据不做批量删改。 |
| 2.1 | 可删，批次1 | teacher_can_publish_reports无调用；GET也须隐藏库中残留键，PUT拒绝；不删设置表/历史行。 |
| 2.2 | 可删，批次1 | public/theme.css全仓无运行调用，只有旧缓存断言；新前端主题为静态CSS。 |
| 2.3 | 只删HTTP旧入口，批次1 | GET workbench零运行调用；**repo.workbench仍被c2/home调用，必须保留**，原清单不可泛化为整方法死代码。 |
| 2.4 | 只删HTTP旧入口，批次1 | GET renewals零运行调用；repo.renewals仍被c2/renewals调用，保留，remind/generate等写路由不动。 |
| 2.5 | 暂留兼容 | schedule-templates别名仍在前端read-batch白名单和性能用例；待前端同步移除后再撤。 |
| 2.6 | 暂留财务核对 | finance/report仍被seed-verify和多项财务对账/精度测试使用，不能为减代码删除核对能力。 |
| 2.7 | 暂留书签兼容 | 旧/app子路径仍安全返回同一SPA；没有证据证明外部书签已消失，收益小。 |
| 2.8 | 暂留实际调用 | PR35后fq-students仍DELETE data/packages/:id，v2f/c3仍有对应操作；app.js仍DELETE data/lessons/:id。整组删除会破坏真实页面。暂不拆同组其他方法以免出现不对称兼容。 |
| 2.9 | 暂留实际回退 | app.js needSummary与v2t.js仍调用todo/summary，收件箱已替换侧栏并不代表旧回退无人用。 |
| 2.10 | 全组保留，当前无可安全整删项 | c3.generationDialog调用templates/preview；fq-teacher→ChannelC3.teacherStudents→teacher-students及详情，点名余额也读该接口；v2s班级详情调用classes/:id/roster。PR35没有删除这些活跃链。 |
| 2.11 | 暂留实际调用/AI配置依赖 | fq-settings仍复用ChannelToolSettings，yx-settings的动态分区保留courses/stages/calendar/profile/changes/gallery；feedback仍有yx-growth调用，AI目录引用课程/阶段/班型。#6完成不等于整组弃用。 |
| 3.1 | 可删，批次1 | source_course_id已随方案下线；只移除teacherToday死谓词，不碰前端残留。 |
| 3.2 | 暂留维护写锁守卫 | 当前确无创建data_jobs的新入口，但可能阻止遗留ready/staging任务状态下误写；与3.3做一次明确的运维退役更可审，不为少两条SQL先移安全守卫。 |
| 3.3 | 高风险待用户确认，不执行 | data_job_rows/data_jobs/one_data_job涉及DDL，先确定遗留任务/导入处置，再占0036或后续号；本轮不占号。 |
| 3.4 | 必须保留 | trusted_imports仍被活跃触发器/夹具依赖，删除会破坏销课、排课、快照。 |
| 3.5 | 高风险待用户确认，不执行 | users.platform_phone_hmac无业务读取但DROP COLUMN仍是线上DDL，本轮不改。 |
| 3.6 | 必须保留 | tenants旧列属于产品决定1保留结构，且在备份列清单中；禁止为了清理破坏备份契约。 |
| 3.7 | 暂留，若要删先确认 | purged_*守卫仍提供机构存在性校验，删触发器需迁移，收益不足。 |
| 4.1 | 可移到tests，批次1 | IMPORT_SHAPES仅fixtures-original-data使用；移动不是删除夹具覆盖，生产双Worker不再携带约30KB测试形状。 |
| 4.2 | 可移到tests，批次1 | LEGACY_ROW_BUDGET只用于历史预算用例；常量移测试本地，原超限断言保留。 |
| 4.3 | 可删，批次1 | build先复制的tenant.js/css立即被生成文件覆盖，console-assets死分支一并移除。 |
| 4.4 | 暂留拒绝路径计时 | 单机构只有根/api，但拒绝的旧slug仍用这两处标记验证0次D1；正则不参与机构解析，不为清理降低测试要求。 |
| 4.5 | 暂留，交Antigravity | console/vendor是前端目录且离线拼音生成、安全测试仍用；如迁至scripts/vendor需前端负责人另PR。 |
| 4.6 | 暂留历史归档 | package-stage/旧预览脚本不参与运行；项目要求源码、验收脚本存档，未经归档整理决定不批量销毁。 |
| 4.7 | 暂留历史部署说明 | 历史升级材料作为溯源，不修改deployment前端负责记录；现行部署按部署手册。 |

**第5节保留项全部保留**：applications命名、tenant_id/表结构、密码/会话/AES/同源/限流、主管全量备份及每日R2、AI通用层与schoolDatabaseContext、renewals/generate与makeups/skip、auth/status、trusted_imports、反Turnstile/旧平台拒绝等安全断言。没有新增迁移，没有删表/删列。

### 三、验证记录

- 定向复现：新增尾号测试在修复前分别得到错误的200截断成功、200空结果；修复后通过5000/5001、错误密钥、损坏密文与状态/文本过滤。
- 增补迁移/锁月/模板/补课/恢复测试不删除现有用例，不降低D1/R2限制。完整门禁结果待本分支执行后追加。

- 清理执行前的补充裁定：**4.4改为暂留**。实际回归发现 `/unknown-school/api/me` 的404仍要求 `Server-Timing` 显示0次D1，这是有效的拒绝路径性能/隔离断言；可选slug正则只用于只读标记和计时，不参与租户解析或恢复旧入口。保留两处正则及全部断言，不为清理放宽测试。4.1实际当前对象为575行，清单的981行是旧统计，按当前导出对象完整迁到测试。
- 其它改动复核补充：`unionAll`递归分组保持每个compound SELECT≤5；备份GC空cursor省略、UTC19:00对应北京时间03:00及30天保留逻辑正确。ORIGIN_HOST仅在匹配明确配置的回源主机时映射APP_HOST，不信任任意转发头，直接回源域名写请求的Origin仍被拒绝；学员点评补字段继续按本人学生关联查询。对应原有D1/R2、同源、学员接口测试保留。


## 2026-11-24：任务 #5 · 后端清理批次1（codex/backend-cleanup-batch1）

独立工作树从最新main@7d2bfe3开分支；33项风险裁定和后端补审全文见同日`codex/backend-review` PR。本批仅执行其中12项：1.3/1.4/1.5/1.6、2.1/2.2/2.3/2.4、3.1、4.1/4.2/4.3。

- 移除secureResponse废弃login形参和固定false实参；仅清除测试/性能脚本中的Turnstile/Access失效字段，原有登录、安全、旧控制台主机及拒绝路径计时断言完整保留。HTML meta与Worker占位仍待Antigravity联动；4.4正则不删。
- 退役GET /api/public/theme.css、GET /api/workbench、GET /api/renewals；替代分别是静态主题/公共品牌、c2/home、c2/renewals或todo/inbox。保留c2/home调用的repo.workbench、c2/renewals调用的repo.renewals和全部续费写接口。前端（包括PR35后仍活跃的2.8–2.11）不变。
- GET设置不再返回teacher_can_publish_reports（包括已持久化旧键），PUT拒绝该键；历史设置行保留在库及备份中，不做DDL或数据清理。移除teacherToday对已删source_course_id的死判断。
- IMPORT_SHAPES从backup-model整体移到tests/fixtures-import-shapes.mjs，仍由100人原始数据夹具调用；不是删除备份模型或测试数据。LEGACY_ROW_BUDGET移到原测试本地，500000字节超限断言保留。移除构建时会立即被覆盖的app.js/css复制与console-assets死分支；生产运行、恢复表清单与格式版本仍35。
- **测试调整清单**：不删除任何测试文件；tools.test的workbench/renewals请求迁到c2/home/c2/renewals，原无财务金额泄露、余额断言保留；tools-budget同迁两个查询预算请求；ui-backend的已提醒次数/时间断言改查c2/renewals，保留原断言。page-performance仅删除已下线theme.css的no-store断言，新增backend-cleanup中的三个404/no-store及替代接口/写路由存续断言。d1-limits只改常量来源，fixtures-original-data只改形状来源；其它文件仅删无用环境/请求字段。
- **保留/待确认**：3.3遗留data_job两表/索引与3.5旧用户列若要删除，须用户明确确认后占0036或更后号，先演练再由Antigravity部署。本轮不发迁移；trusted_imports、tenants列、purged守卫、AI通用层、applications及所有安全/备份基础设施保留。历史验收与部署材料不批量销毁。
- 此PR仅后端/测试/构建脚本及指定追加文档，无前端、任务板、项目状态、生产部署改动。完整门禁结果执行后追加。

- 全量源码首跑还发现debt-and-balance的带查询串旧续费入口（renewals?group=debt）；同样改查c2/renewals?group=debt，保留未购包欠课可提醒/不可伪造提醒、total=1和reminded_count=1所有断言。修正后重跑完整门禁，不跳过用例。


### 2026-11-24：本轮验证与交接（两个PR共同记录）

环境为Node v24.22.1、Playwright 1.65.0；最终浏览器采用该版本配套Chromium 158.0.8127.18（原配置自动优先选择，不改测试配置）。

| 分支 | build | npm test | TEST_BUNDLE=1 npm test | migrations:preflight | 双端smoke |
|---|---|---|---|---|---|
| codex/backend-review | 通过 | 385/385，0 skip | 385/385，0 skip | 35项通过 | 串行24通过、2日期用例失败、2项原有skip；QA辅助函数待授权修复 |
| codex/backend-cleanup-batch1 | 通过 | 380/380，0 skip | 380/380，0 skip | 35项通过 | 26通过、2项原有手机skip、0失败，命令退出0 |

- 两分支迁移预检均为84表、4视图、63索引、70触发器，foreign_key_check=0、integrity=ok；没有占用0036，没有新的DDL。
- 清理后的备份运行时导出对象与main逐字段相同，移出的IMPORT_SHAPES与原对象也逐字段相同。main/补审/清理构建的12个前端静态产物SHA256逐项相同（不包含有意修改的_worker.js）。
- **E2E已观察问题（供Antigravity复核）**：并行负载下，日期输入用例`tests/e2e/date-input.spec.mjs:115`的discardDrawer点击确认按钮时发生DOM detached超时。系统Chromium156的两次完整运行分别为25通过/1失败、24通过/2失败；配套158并行运行也曾手机日期用例失败（25通过/1失败）。main原样单独日期用例和“认证→日期”两个桌面用例均通过，配套158单独日期亦通过，尚未确认后端因果。请QA检查Escape后固定200ms等待与确认弹窗卸载的竞态；本轮未改该目录、断言、timeout或retries，失败没有计为通过。
- 两项smoke skip来自main已有的`finance-leads.spec.mjs:6,92`（完整财务/线索流程只在桌面执行），本轮没有增加skip或放宽测试；原样报告其数量，不声称28/28全通过。后端源码/打包测试全部零跳过。
- 本轮仅本地模拟器/浏览器验证，无生产写入或部署。合入后由Antigravity按部署手册发布，主管0035新基准备份/每日03:00落盘仍需据线上记录核对。


### 2026-11-24：日期E2E阻塞的精确定位与待授权改动

最终空闲环境串行也在日期用例失败（24通过、桌面/手机日期2失败、原有2 skip），不能计作全绿。截图显示缴费抽屉已经关闭，源码定位到`discardDrawer`的选择器`dialog[open] button:has-text('确认')`误匹配正在卸载的缴费表单提交按钮；它不是放弃修改确认按钮。后端接口四门禁全绿，清理分支smoke全绿；补审分支smoke暂受这个QA辅助函数阻塞，未定位为接口回归。

建议仅修改`tests/e2e/date-input.spec.mjs`中的辅助函数：将宽泛的三个按钮文本选择器替换为下面两行，保留原click及全部业务断言，并在四轮关闭循环后增加抽屉清空断言：

```js
const confirmBtn = page.getByRole('dialog', { name: '放弃未保存的修改？', exact: true })
  .getByRole('button', { name: '放弃修改', exact: true });
// 保留原 count/isVisible/click 分支；循环后新增：
await expect(page.locator('.ui-sheet')).toHaveCount(0);
```

没有调整timeout、retries、skip或业务断言；不改src/tenant、src/ui、design。因AGENTS把tests/e2e归Antigravity，实际写入该文件须获用户单文件授权或由Antigravity执行。此处先给出可审查方案，授权前不改该目录。


### 2026-11-24：提交与当前交接点

- [PR #38：后端清理批次1](https://github.com/chrisyuejian-stack/Codex-GPT/pull/38)：12项安全清理；四门禁与原有smoke套件均通过，未合并/未部署。
- [PR #39：后端补审与加固（草稿）](https://github.com/chrisyuejian-stack/Codex-GPT/pull/39)：两项尾号P2修复、7项新回归和完整书面补审；四项后端门禁通过，但原样smoke的日期辅助函数仍失败，暂不标记可合并。
- 日期辅助函数方案已在`work/`临时副本用原有业务断言验证：桌面/手机两项均通过（2/2）；只限定放弃确认对话框并增加最终所有抽屉关闭断言。正式`tests/e2e/date-input.spec.mjs`完全未改，等待用户单文件授权或Antigravity执行。临时副本通过不替代正式套件门禁。
- 两PR携带同一份追加报告/接口说明，原main文档前缀未改，后续合并不需要在两份不同的尾部追加中二选一。未改任务板、项目状态、前端或任何数据库结构。


### 2026-11-24：用户澄清统筹权限与Antigravity交接

- 整体控制与规划仍归Claude；Claude额度不足期间，由Antigravity暂代统筹。GPT负责后端实现，与Antigravity协作处理跨目录改动、QA验收及部署交接。
- 本节取代上文“等待用户单文件授权”的处理方式：日期E2E辅助函数交Antigravity审查并执行，或由其确认GPT代修，不再要求用户逐项处理团队目录授权。正式测试文件仍未改，#39保持草稿直至正式门禁通过。
- 已在[PR #39协作交接评论](https://github.com/chrisyuejian-stack/Codex-GPT/pull/39#issuecomment-7128059071)提供精确选择器修复、加强断言、临时副本验证及正式回归要求，并同步更新PR描述。评论已发布，不代表Antigravity已经阅读或确认。
- 高风险删表/删列仍按用户原要求等待其明确确认；不把日常协作统筹等同于该项数据库操作授权。任务板、项目状态和前端目录保持职责边界。
