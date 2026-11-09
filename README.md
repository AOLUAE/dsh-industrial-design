# dsh-industrial-design

工业设计大师 · S0–S7 状态机插件（v0.3.0）

把一次工业设计需求从 Brief 冻结（S0）逐步推进到正交视图组交付（S7）的 **状态编排器**。它内置了「工业设计大师」认知层技能，并提供 6 个工具用于项目状态、变量锁定、生成复现与一致性校验的落地。

> 配套 PRD：`工业设计大师Agent_PRD_v1.5`。本插件是三步路径（认知层 → 生图接入 → 状态机插件）的第 ③ 步。

## ⚠️ 前置依赖（必读）

S7 的「视图与渲染交付」依赖**生图工具** `generate_image` / `edit_image`。本插件**不内置**生图能力——因为生图需要你自己的凭据（API Key / 订阅 / ComfyUI），不是「装上插件就能出图」。

- **S0–S6**：无需生图插件，状态机可独立运行。
- **S7**：必须先安装并配置**任一具备生图能力的插件**（如 `dsh-image-gen`，或暴露 `generate_image` / `generate_images` / `edit_image` 工具的其他插件），否则模型会明确提示你「缺少生图工具」。

```bash
# 示例：安装 dsh-image-gen（也可用任意具备生图能力的插件）
pnpm dsh plugin --profile <profile> add dsh-image-gen
```

安装后在「设置 → 插件」配置 provider（如 openai-compat 中转站）与 API Key。

## 功能

- **内置技能** `industrial-design-master`：七阶段状态机（S0–S7 + S5.5）、变量锁定矩阵、一致性校验清单（10.2）、品类动态锁定、generation_record 模板。加载后模型即充当工业设计编排者。
- **6 个工具**：
  | 工具 | 作用 |
  | --- | --- |
  | `industrial_project_init` | S0 立项，冻结 Brief（category_id 必填） |
  | `industrial_advance_stage` | 阶段推进 / 回流（前进不跳级，回流需理由） |
  | `industrial_lock_variables` | 记录变量锁定矩阵 |
  | `industrial_record_generation` | 写 generation_record（可复现） |
  | `industrial_record_consistency` | 记录 10.2 逐项判定（机器/人工/混合） |
  | `industrial_get_state` | 读取当前项目状态 |
- **状态持久化**：项目状态存于 `$DSH_HOME/industrial-design/projects.json`（MVP 为单文件、非跨进程安全，后续版本迁到 sessionProjections/configEditor）。
- **交互确认**：技能会在关键决策点调用 `ask_user_question` 弹出交互选择框（带推荐选项 + 允许自由输入），用于 S0 冻结 Brief / S3 选方向 / S4 选方案 / S5 确认 DNA / S7 签收。
- **双端可用**：本插件为 Host bundle，桌面端与网页版（Web GUI）均可使用；工具与状态存储在宿主运行时，与客户端形态无关。

## 配置（v0.3.0）

在「设置 → 插件」里配置以下参数（填写即覆盖默认值；`industrial_get_state` 返回的 `config` 字段为当前生效值）：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `firstCategoryN` | 30 | 首批单品类固定样本量 N |
| `consistencyThreshold` | 0.9 | 机器判定器「机器 vs 人评」对齐的一致率门槛 |
| `skeletonMatchThreshold` | 0.85 | S5.5 骨架投影与锚定线稿吻合度门槛 |
| `maxConvergenceRounds` | 3 | 同一阶段触顶失败的重推轮次上限 |
| `categoryList` | [] | 允许的品类白名单；非空时 `industrial_project_init` 拒绝列表外品类 |

## 安装

在 DeepSeek Harness 项目根目录：

```bash
pnpm dsh plugin --profile <profile> add dsh-industrial-design
```

或本地目录 / GitHub 直装：

```bash
pnpm dsh plugin --profile <profile> add ./dsh-industrial-design
pnpm dsh plugin --profile <profile> add git+https://github.com/<you>/dsh-industrial-design.git
```

安装后重启对应 Profile，技能 `industrial-design-master` 与 6 个工具即生效。

## 使用

在对话中直接说「帮我做一个 XX 产品的外观设计」，加载技能后模型会：

1. S0 用 `industrial_project_init` 建项目、渐进追问冻结 Brief；
2. S1–S6 逐步推进，每次进入/离开阶段都核对门禁；
3. S7 用 `industrial_record_consistency` 记录一致性判定，用 `industrial_record_generation` 记录每张生成图的复现参数。

## 项目结构

```
dsh-industrial-design/
├── index.js                       # Host 插件入口（注册技能 + 6 工具）
├── cordis.patch.yml               # bundle 装载清单
├── package.json                   # dsh.bundle.patch 元数据
├── skills/industrial-design-master/
│   └── SKILL.md                   # 内置认知层技能（含 frontmatter）
├── locale/en.json · zh.json       # 显示名与描述
├── icon.svg                       # 图标
├── README.md
└── LICENSE                        # Apache-2.0
```

## MVP 边界（v0.1.0 明确不做）

- 机器判定器打分、golden set 回归、RBAC 多用户签收、知识库 L1–L6、DFM 工程校验（L5 仅保留最小四规则提示）。
- UI 面板（自定义面板；Config 参数表单已由 v0.2.0 的 Config schema + volatile 字段自动提供）。
- 外观专利检索：仅启发式提示，不构成法律意见。

## License

[Apache-2.0](LICENSE)
