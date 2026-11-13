# dsh-industrial-design

工业设计大师 · S0–S7 状态机插件（v0.4.3）

把一次工业设计需求从 Brief 冻结（S0）逐步推进到正交视图组交付（S7）的 **状态编排器**。它内置了「工业设计大师」认知层技能，并提供 12 个工具用于项目状态、交互确认门禁、变量锁定、生成复现、调研洞察、DNA/CMF/几何归档与一致性校验（含机器判定器打分）。

> 配套 PRD：`工业设计大师Agent_PRD_v1.5`。本插件是三步路径（认知层 → 生图接入 → 状态机插件）的第 ③ 步。

## ⚠️ 前置依赖（必读）

S7 的「视图与渲染交付」依赖**生图工具** `generate_image` / `edit_image`。本插件**不内置**生图能力——因为生图需要你自己的凭据（API Key / 订阅 / ComfyUI），不是「装上插件就能出图」。

- **S0–S6**：无需生图插件，状态机可独立运行。
- **S7**：必须先安装并配置**暴露 `generate_image` / `generate_images` / `edit_image` 标准工具、且支持几何锚定（ControlNet/workflow 或参考图输入）的生图插件**（如 `dsh-image-gen` 挂 ComfyUI / dashscope / openai-compat 硅基流动）。`industrial_get_state` 会按参数 schema 检测能力（`image_capability.anchoring`），`text_only` 或缺失时会明确提示你换用/安装支持条件控制的插件。

```bash
# 示例：安装 dsh-image-gen（也可用其他暴露标准生图工具、且支持条件控制的插件）
dsh plugin --profile <profile> add dsh-image-gen
```

安装后在「设置 → 插件」配置 provider（如 openai-compat 中转站）与 API Key。

## 功能

- **内置技能** `industrial-design-master`：七阶段状态机（S0–S7 + S5.5）、变量锁定矩阵、一致性校验清单（10.2）、品类动态锁定、generation_record 模板。加载后模型即充当工业设计编排者。
- **12 个工具**：
  | 工具 | 作用 |
  | --- | --- |
  | `industrial_project_init` | S0 立项，冻结 Brief（category_id 必填，可白名单校验） |
  | `industrial_advance_stage` | 阶段推进 / 回流（前进不跳级，回流需理由；前进硬校验交互确认门禁，未确认返回 blocked） |
  | `industrial_confirm` | 记录用户在各确认节点的拍板结果（advance_stage 放行前须先经 ask_user_question 问询并记录） |
  | `industrial_lock_variables` | 记录变量锁定矩阵 |
  | `industrial_record_generation` | 写 generation_record（含 view/control_mode/参考图/锚强度，可复现） |
  | `industrial_record_consistency` | 记录 10.2 逐项判定（机器/人工/混合，可带 view_group） |
  | `industrial_compute_consistency` | 机器判定器：聚合特征级一致率/组级通过率并与阈值比对 |
  | `industrial_synthesize_research` | S1 归档调研洞察（fact/inference/tbd 三态标注） |
  | `industrial_record_dna` | S5 记录设计 DNA（自动生成 design_dna_id） |
  | `industrial_record_cmf` | S6 记录 CMF 规格书 |
  | `industrial_record_geometry` | S5.5/S6 记录几何骨架/STEP/IGES/OBJ 导出 |
  | `industrial_get_state` | 读取当前状态（含生图工具能力检测、cad 检测、一致性聚合、summary） |
- **状态持久化**：项目状态存于 `$DSH_HOME/industrial-design/projects.json`（MVP 为单文件、非跨进程安全，后续版本迁到 sessionProjections/configEditor）。
- **交互确认（硬校验 + 全量弹框）**：S0 冻结 Brief / S3 选方向 / S4 选方案 / S5 确认 DNA / S6 确认 CMF / S7 签收等关键决策点由状态机强制——`industrial_advance_stage` 前进时若未确认会返回 `blocked`，模型据此调 `ask_user_question` 弹框（推荐选项 + 自由输入）拿到答案后用 `industrial_confirm` 记录，方能放行。此外，**所有面向用户的提问（含 S0 Brief 采集的每一轮追问、S2 权重等）都通过 `ask_user_question` 弹框交互，不在正文里罗列问题**。
- **双端可用**：本插件为 Host bundle，桌面端与网页版（Web GUI）均可使用；工具与状态存储在宿主运行时，与客户端形态无关。

## 配置（v0.4.3）

在「设置 → 插件 → industrial-design」里配置以下参数（填写即覆盖默认值；`industrial_get_state` 返回的 `config` 字段为当前生效值）：

| 参数 | 默认 | 说明 | 示例 |
| --- | --- | --- | --- |
| `firstCategoryN` | 30 | 首批品类（`first_project.category_id`）收敛所需样本量 N：攒满 N 个同类项目后才按品类分层统计放行 | 30；首批品类是「手持设备 handheld」时就等攒满 30 个 handheld 项目 |
| `consistencyThreshold` | 0.9 | S7 一致性阈值（0~1）：正交视图组与设计 DNA 的同源一致率须 ≥ 此值才放行；`industrial_compute_consistency` 用它判定达标/不达标 | 0.9 = ≥90%；放宽到 0.8 即 ≥80% |
| `skeletonMatchThreshold` | 0.85 | S5.5 几何骨架吻合度阈值（0~1）：骨架投影与锚定线稿关键特征线吻合度须 ≥ 此值 | 0.85 = ≥85%；越接近 1 越严格 |
| `maxConvergenceRounds` | 3 | 同一方向触顶失败后的收敛轮次上限 | 3 = 连续 3 轮不达标即回退 S2 或更换方向 |
| `categoryList` | [] | 允许的品类白名单（品类 id 数组）。空数组 = 不限制；非空时 `industrial_project_init` 的 `category_id` 必须在列 | `["handheld","wearable","desktop"]` 只允许这三个品类 |
| `cadMCP` | "" | CAD MCP 工具名前缀（用于真实几何导出）。留空则 `industrial_get_state` 按内置已知 CAD 工具名检测 | `"freecad_mcp"` 或 `"cad"`，留空自动检测 |

> 说明：参数带「中文描述 + 示例」会随配置表单一起显示；README 这里同步维护一份便于离线查阅。

## 安装

`dsh` 是 DeepSeek Harness 自带的命令行工具（位于安装目录 `resources/runtime/cli/bin/dsh.cmd`，通常已加入 PATH；若提示「找不到命令」，请用该完整路径调用）。

### 方式一：npm 安装（推荐）

```bash
dsh plugin --profile <profile> add dsh-industrial-design
```

### 方式二：GitHub 直装（npm 源不通时）

```bash
dsh plugin --profile <profile> add git+https://github.com/AOLUAE/dsh-industrial-design.git
```

### 方式三：clone 后本地目录安装（无网络时）

```bash
git clone https://github.com/AOLUAE/dsh-industrial-design.git
dsh plugin --profile <profile> add ./dsh-industrial-design
```

把 `<profile>` 换成你的 profile 名（如 `desktop` / `web` / `tui`，即 `$DSH_HOME/profiles/` 下的目录名）。安装后重启对应 Profile，技能 `industrial-design-master` 与 12 个工具即生效。

> 也可以在 DeepSeek Harness 图形界面的「设置 → 插件」里安装：粘贴 `dsh-industrial-design`（npm）或 `git+...` 地址，或选择 clone 下来的本地目录。

## 使用

在对话中直接说「帮我做一个 XX 产品的外观设计」，加载技能后模型会：

1. S0 用 `industrial_project_init` 建项目、渐进追问冻结 Brief；
2. S1–S6 逐步推进，每次进入/离开阶段都核对门禁；S1 用 `industrial_synthesize_research` 归档洞察、S5 用 `industrial_record_dna` 锁 DNA、S5.5/S6 用 `industrial_record_geometry` 记录骨架/几何、S6 用 `industrial_record_cmf` 记录 CMF；
3. S7 用 `industrial_record_consistency` 记录一致性判定，用 `industrial_record_generation` 记录每张生成图的复现参数（含几何锚），最后用 `industrial_compute_consistency` 聚合判定是否达标。

## 项目结构

```
dsh-industrial-design/
├── index.js                       # Host 插件入口（注册技能 + 12 工具）
├── cordis.patch.yml               # bundle 装载清单
├── package.json                   # dsh.bundle.patch 元数据
├── lib/client.js                  # Client 设置表单卡片（plugins.bundle.config）
├── skills/industrial-design-master/
│   └── SKILL.md                   # 内置认知层技能（含 frontmatter）
├── locale/en.json · zh.json       # 显示名与描述
├── icon.svg                       # 图标
├── README.md
└── LICENSE                        # Apache-2.0
```

## MVP 边界（延后项）

- 机器判定器已提供 `industrial_compute_consistency` 的规则聚合（特征级一致率/组级通过率），但「机器视觉自动打分」仍需接入图像判定后端；golden set 回归、RBAC 多用户签收、知识库 L1–L6、DFM 工程校验（L5 仅保留最小四规则提示）仍在延后清单。
- UI 面板（自定义面板；Config 参数表单已由 Config schema + client 卡片提供）。
- 智能产品 UI 草图、实时迭代（需 UI 大改）。
- 外观专利检索：仅启发式提示，不构成法律意见。

## License

[Apache-2.0](LICENSE)
