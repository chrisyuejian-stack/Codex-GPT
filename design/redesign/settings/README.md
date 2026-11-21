# 设置 · Settings（静态设计稿）

视图：`overview-desk`（总览）、`accounts-desk`（账号与权限）、`institution-desk`（机构与品牌）、`courses-desk`（课程与教室）、`overview-phone`（分组列表）、`accounts-phone`（二级页）。html 与同名 png 并列，样式在 `mock.css`（前缀 `fq-se-`）。
结构：电脑端左侧分区导航（与待办页分类卡同款）+ 右侧内容；「总览」是统计卡 + 6 张分组卡 + 最近改动。手机端：分组列表 → 整页二级页（顶部「‹ 设置」返回）。从底部「更多」进入。

## 功能清单 → 新位置
| 现有功能（入口） | 新位置 |
|---|---|
| 账号列表、按角色筛选、新建员工账号、编辑、登录设备、查看完整号码、重置密码、分页（accountsV） | 账号与权限 › 账号面板（行内「编辑」+「⋯」） |
| 角色权限矩阵（rightsPage，仅主管） | 账号与权限 › 角色权限摘要卡 →「打开权限表」进整页矩阵（沿用现有勾选、浅黄改动、撤销、批量保存） |
| 教师与学员端开关 6 项（含 student_view_balance / student_view_payments、教务开通/重置账号） | 账号与权限 › 「教师端与学员端能看到什么」 |
| 机构信息展示（renewal-brand）、主色与咨询二维码（yxsBrandEditor、图库选择） | 机构与品牌 › 机构信息 / 主色与二维码 / 效果预览 |
| 课程大类、细分课程、教室与地点；新增、编辑、删除、手动排序（v2s courses、manualOrder） | 课程与教室（三面板同页，顶部药丸跳转） |
| 缺勤规则、欠课时上限、课表默认视图（c3 settingsPage） | 教务规则（未出稿，开关行 + 下拉，同账号页开关样式） |
| 续费提醒规则（renewal-settings，现在只在待办/续费弹窗里） | 教务规则 › 续费提醒（弹窗入口保留） |
| AI 用量（yxAiUsagePage）+ AI 模型/额度（/api/settings/ai，前端尚未做） | AI 设置（未出稿） |
| 导入向导、集中导出、数据备份（importWizard、exportsPage、fq-backup） | 数据与备份（未出稿；备份页已是新风格，直接放入） |
| 操作记录 / 登录记录 + 筛选（logsV） | 操作记录（未出稿）；总览底部显示最近 5 条设置类改动 |
| 头像菜单：修改密码、登录设备、退出 | 电脑端不变；手机端在设置总览「我的账号」 |

权限差异：主管全部可见；角色权限、数据备份、AI 设置仅主管（导航和卡片带锁图标）；教务看到课程与教室（按 settings 权限只读或可改）、账号（只能改教师/学员）、导入导出、操作记录；财务只有导出与操作记录（read_finance）。非主管看到的规则开关为禁用态。

## 交互
- 左侧导航/总览卡片「进入 →」切换分区，URL 用 `#settings-<分区>`；旧路由（settings-accounts、admin-courses、settings-institution 等）映射到对应分区。
- 「新建员工账号」「编辑」「新增细分课程/教室」打开右侧抽屉（沿用 newAccount / editAccount / recordForm）；「⋯」为动作菜单；删除走确认框。
- 开关即点即存（同现在）；机构与品牌改完后，预览即时更新，点右上「保存修改」一次提交，有未保存项时显示橙色药丸。
- 手机端：账号行点进账号详情页（编辑和「⋯」里的操作放在详情页底部）；角色权限点进「教务/财务」单角色列表，按分组勾选。

## 与现状相比的主要变化
1. 「课程与教室」从「老师」分组移回设置；设置页签（基本设置/账号/角色权限/导入/导出/数据备份/操作记录/AI 用量）收为 7 个分区 + 总览。
2. 「教师与学员端」开关从机构设置移到「账号与权限」，与账号、权限放在一起。
3. 续费提醒规则在设置里有固定位置；三处课程子页合为一页。

## 需要用户决定
1. 课程与教室是否移回设置（老师分组里保留一个跳转入口？）。
2. 单机构后，机构名称、Logo、联系说明是否改为主管可直接编辑（现在只读，「由管理员维护」），需后端提供写接口。
3. 教室表是否增加只读列「本周使用节数」（需后端统计，可不做）。
4. 手机端是否只读「数据与备份」（导入、恢复建议只在电脑上做）。

## 可复用
accountsV、newAccount、editAccount、devices、showSecret、rightsPage、RIGHT_ROWS、institution、yxsBrandEditor、settingsPage(c3 absence/personal/view)、courses(v2s)、recordForm、manualOrder、renewalRules / ruleDialog、yxAiUsagePage、importWizard、exportsPage、FengqinBackup.backupPage、logsV；接口 accounts、rights、settings、absence-policies、renewal-settings、renewal-brand、settings/brand、settings/ai、ai/usage、data/course_categories|course_types|locations、logs。
