/**
 * dsh-industrial-design — Host bundle for the "工业设计大师" S0–S7 state machine.
 *
 * Bundles the cognitive-layer skill (skills/industrial-design-master/SKILL.md) and
 * registers state-machine tools. Project state is persisted to a file-backed
 * JSON store (MVP: not cross-process safe; see README).
 *
 * v0.4.0: added machine judge (consistency aggregation), real-geometry record,
 * research synthesis, design-DNA record, CMF record, and geometry-anchored
 * generation records (ControlNet / IP-Adapter fields).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { homedir } from 'node:os'

export const inject = ['tools']

// ---------------------------------------------------------------------------
// Config schema (schemastery) — 可配置项
// ---------------------------------------------------------------------------
// schemastery 由 host 提供（peer 依赖）。正常安装为真实目录时可解析 → 出设置表单；
// 经 plugin_manager 对本地目录用 link:（符号链接）安装时，Node 默认把 bundle 解析到
// 真实路径、看不到 host 提升的 node_modules，此时回退到 profile 的 node_modules 显式
// 定位 schemastery 的 ESM 入口，保证仍能出表单、参数可编辑。
// 0.1.7+ 支持 `.volatile()`：字段在 Settings > Plugins 出表单、原地更新（读取需经 `.get()`）。
function volatile(schema) {
  const mark = schema.volatile
  return typeof mark === 'function' ? mark.call(schema) : schema
}

const z = await (async () => {
  try {
    return (await import('@deepseek-ai/schemastery')).default
  } catch {
    const roots = [
      process.env.DSH_PROFILE_DIR,
      process.env.DSH_HOME && process.env.DSH_PROFILE
        ? join(process.env.DSH_HOME, 'profiles', process.env.DSH_PROFILE)
        : undefined
    ].filter(Boolean)
    for (const root of roots) {
      const entry = join(root, 'node_modules', '@deepseek-ai', 'schemastery', 'lib', 'index.mjs')
      try {
        return (await import(pathToFileURL(entry).href)).default
      } catch { /* try next root */ }
    }
    return null
  }
})()

export const Config = z
  ? z.object({
      firstCategoryN: volatile(z.number().min(1).default(30).description('首批品类（first_project.category_id）收敛所需样本数 N：攒满 N 个同类项目后才按品类分层统计放行。示例：30 表示首个品类需 30 个真实项目。')),
      consistencyThreshold: volatile(z.number().min(0).max(1).default(0.9).description('S7 一致性校验阈值（0~1）：正交视图组与设计 DNA 的同源一致率须 ≥ 此值才放行。示例：0.9 表示 ≥90%。')),
      skeletonMatchThreshold: volatile(z.number().min(0).max(1).default(0.85).description('S5.5 轻量几何骨架吻合度阈值（0~1）：骨架投影与锚定线稿关键特征线吻合度须 ≥ 此值。示例：0.85 表示 ≥85%。')),
      maxConvergenceRounds: volatile(z.number().min(1).default(3).description('同一方向触顶失败后的收敛轮次上限。示例：3 表示连续 3 轮不达标即须回退 S2 或更换方向。')),
      categoryList: volatile(z.array(z.string()).default([]).description('允许的品类白名单（品类 id 数组）。空数组 = 不限制；非空时 industrial_project_init 声明的 category_id 必须在列。示例：["handheld","wearable","desktop"]。')),
      cadMCP: volatile(z.string().default('').description('S6 真实几何导出的 CAD 工具名/前缀（可选）。填写后 industrial_get_state 会检测匹配的 CAD 工具（如 freecad / cad_mcp）。示例：填 "freecad" 可匹配 freecad_* 系列工具；留空则 S6 降级为「图 + 说明」，不产出可测几何。'))
    })
  : undefined

// ---------------------------------------------------------------------------
// Bundled skill — single source of truth is skills/industrial-design-master/SKILL.md
// ---------------------------------------------------------------------------
const SKILL_PATH = new URL('./skills/industrial-design-master/SKILL.md', import.meta.url)
const SKILL_RAW = readFileSync(SKILL_PATH, 'utf8')

function parseSkill(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return { meta: {}, body: raw.trim() }
  const meta = {}
  for (const line of match[1].split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i === -1) continue
    const key = line.slice(0, i).trim()
    let value = line.slice(i + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    meta[key] = value
  }
  return { meta, body: match[2].trim() }
}

const SKILL = parseSkill(SKILL_RAW)

// ---------------------------------------------------------------------------
// Project state store (file-backed JSON; MVP — not cross-process safe)
// ---------------------------------------------------------------------------
const STATE_DIR = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'industrial-design')
const STATE_FILE = join(STATE_DIR, 'projects.json')

function loadStore() {
  if (!existsSync(STATE_FILE)) return {}
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')) } catch { return {} }
}

function saveStore(store) {
  mkdirSync(STATE_DIR, { recursive: true })
  writeFileSync(STATE_FILE, JSON.stringify(store, null, 2), 'utf8')
}

const STAGES = ['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S5.5', 'S6', 'S7']

const GATES = {
  S0: '准出：用户显式确认冻结 Brief（含 category_id）。',
  S1: '准出：≥5 条事实级洞察且用户确认无重大遗漏。',
  S2: '准出：机会点与 Brief 硬约束无冲突。',
  S3: '准出：用户至少选定 1 个方向进入 S4。',
  S4: '准出：用户选定 1 个方案，可指定局部修改。',
  S5: '准出：用户确认 Design DNA（生成 design_dna_id）。',
  'S5.5': '准出：骨架投影与锚定线稿关键特征线吻合度 ≥ 阈值。',
  S6: '准出：DFM 无阻断级问题，用户确认 CMF。',
  S7: '准出：一致性校验通过 + 用户签收。'
}

// 交互确认门禁：离开该阶段前必须已由用户确认（ask_user_question → industrial_confirm 记录）。
// 未确认时 industrial_advance_stage 返回 blocked 而非推进；S2/S5.5 为自动/机器门禁，不在此列。
const CONFIRM_GATES = {
  S0: { key: 'brief_frozen', label: '冻结 Brief', question: '是否确认冻结 Brief（含品类 category_id）？' },
  S1: { key: 'insights_confirmed', label: '确认洞察无遗漏', question: '调研洞察是否已无重大遗漏？' },
  S3: { key: 'direction_selected', label: '选定设计方向', question: '请选定要进入 S4 的设计方向。' },
  S4: { key: 'concept_selected', label: '选定方案', question: '请选定要进入 S5 的方案。' },
  S5: { key: 'dna_confirmed', label: '确认 Design DNA', question: '是否确认冻结 Design DNA？' },
  S6: { key: 'cmf_confirmed', label: '确认 CMF', question: '是否确认 CMF 规格？' },
  S7: { key: 'signed_off', label: '签收', question: '是否签收最终交付？' }
}

const CONFIRM_NODES = Object.values(CONFIRM_GATES).map((g) => g.key)

function confirmKeysAtOrAfter(stage) {
  const idx = STAGES.indexOf(stage)
  const keys = []
  for (let i = idx; i < STAGES.length; i++) {
    const g = CONFIRM_GATES[STAGES[i]]
    if (g) keys.push(g.key)
  }
  return keys
}

function newProject(args) {
  return {
    projectId: args.project_id,
    name: args.name || args.project_id,
    categoryId: args.category_id || '',
    stage: 'S0',
    designDnaId: '',
    brief: args.brief || {},
    locked: {},
    lockedAllow: [],
    confirmations: {},
    generations: [],
    consistency: [],
    research: [],
    opportunities: [],
    dna: [],
    cmf: [],
    geometry: [],
    changelog: [],
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
}

function mustProject(store, id) {
  const p = store[id]
  if (!p) throw new Error(`项目不存在：${id}。请先调用 industrial_project_init。`)
  return p
}

function text(value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
}

const OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => text(value)
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

function makeProjectInit(getCfg) {
  return {
    name: 'industrial_project_init',
    description:
      'S0：创建/初始化一个工业设计项目，声明品类（category_id，随 Brief 冻结锁定）并记录 Brief 草稿。返回项目当前状态。',
    parameters: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: '项目唯一 ID' },
        name: { type: 'string', description: '项目名称（可选，缺省用 project_id）' },
        category_id: { type: 'string', description: '品类声明（如 handheld / desktop / wearable / appliance …），S0 声明后随 Brief 冻结' },
        brief: { type: 'object', description: 'Brief 草稿（核心功能/目标用户/售价区间/材料工艺偏好等，任意键值）' }
      },
      required: ['project_id', 'category_id']
    },
    output: OUTPUT,
    async execute(args) {
      const store = loadStore()
      if (store[args.project_id]) throw new Error(`项目已存在：${args.project_id}。用 industrial_get_state 查看，勿重复初始化。`)
      const cfg = getCfg()
      const allowed = Array.isArray(cfg.categoryList) ? cfg.categoryList : []
      if (allowed.length > 0 && !allowed.includes(args.category_id)) {
        throw new Error(`品类 ${args.category_id} 不在配置的品类列表内。可用品类：${allowed.join(' / ')}（或在插件配置中清空 categoryList 以允许任意品类）。`)
      }
      store[args.project_id] = newProject(args)
      saveStore(store)
      return store[args.project_id]
    }
  }
}

const advanceStage = {
  name: 'industrial_advance_stage',
  description:
    '推进设计阶段（S0→S1→…→S7）。默认前进一格；可显式回流到较早阶段（须给 reason）。前进不可跳级。前进时硬校验交互确认门禁：若当前阶段需用户确认且未记录，返回 blocked（须先 ask_user_question → industrial_confirm 再推进）。',
  parameters: {
    type: 'object',
    properties: {
      project_id: { type: 'string', description: '项目 ID' },
      target_stage: { type: 'string', enum: STAGES, description: '可选：目标阶段。前进时只能到下一阶段；回退（回流）时须给 reason。缺省 = 前进一格。' },
      design_dna_id: { type: 'string', description: 'S5→S5.5 前进时可选传入已锁定的 Design DNA id' },
      reason: { type: 'string', description: '回退/回流原因（回退时必填）' }
    },
    required: ['project_id']
  },
  output: OUTPUT,
  async execute(args) {
    const store = loadStore()
    const p = mustProject(store, args.project_id)
    const curIdx = STAGES.indexOf(p.stage)
    let targetIdx
    if (args.target_stage) {
      targetIdx = STAGES.indexOf(args.target_stage)
      if (targetIdx === -1) throw new Error(`非法阶段：${args.target_stage}`)
      if (targetIdx > curIdx && targetIdx !== curIdx + 1) throw new Error(`前进不可跳级：当前 ${p.stage}，只能到 ${STAGES[curIdx + 1]}`)
      if (targetIdx < curIdx && !args.reason) throw new Error('回流（回退阶段）必须提供 reason。')
    } else {
      if (curIdx >= STAGES.length - 1) throw new Error('已在 S7（终点）。')
      targetIdx = curIdx + 1
    }
    const isForward = targetIdx > curIdx

    // 前进：先校验「交互确认」门禁——离开当前阶段前必须已记录用户确认，否则 block（不推进、不改状态）。
    if (isForward) {
      const gate = CONFIRM_GATES[p.stage]
      if (gate && !(p.confirmations && p.confirmations[gate.key])) {
        return {
          blocked: true,
          stage: p.stage,
          next_stage: STAGES[targetIdx],
          requires_confirmation: gate.key,
          confirmation_label: gate.label,
          confirmation_question: gate.question,
          instruction:
            '必须先用 ask_user_question 向用户确认（options 用本项目实际的方向/方案/选项，推荐项放首并标注「（推荐）」，multi_select 默认 false），拿到用户答案后调 industrial_confirm 记录，再重新调 industrial_advance_stage。未确认前无法推进。'
        }
      }
    } else {
      // 回流：清掉回流目标阶段及其之后的确认记录，迫使重新确认。
      for (const key of confirmKeysAtOrAfter(STAGES[targetIdx])) {
        if (p.confirmations) delete p.confirmations[key]
      }
    }

    if (curIdx === 0 && targetIdx === 1 && !p.categoryId) {
      throw new Error('S0 准出需要 category_id（品类未声明）。用 industrial_project_init 声明品类后再推进。')
    }
    if (args.design_dna_id) p.designDnaId = args.design_dna_id
    const from = p.stage
    p.stage = STAGES[targetIdx]
    p.updatedAt = Date.now()
    p.changelog.push({ at: Date.now(), from, to: p.stage, reason: args.reason || (isForward ? 'advance' : 'reflow') })
    saveStore(store)
    return { ...p, gate_hint: GATES[p.stage] || '', confirmed_gates: Object.keys(p.confirmations || {}) }
  }
}

const lockVariables = {
  name: 'industrial_lock_variables',
  description:
    '锁定/解锁变量（变量锁定矩阵）。记录本轮重推中必须保持不变（锁定）与允许变化（可变更）的变量，区分「迭代」与「重抽」。',
  parameters: {
    type: 'object',
    properties: {
      project_id: { type: 'string', description: '项目 ID' },
      locked: { type: 'object', description: '必须锁定的变量（key → value）' },
      allow_changes: { type: 'array', items: { type: 'string' }, description: '允许变化的变量名列表' },
      reason: { type: 'string', description: '本轮锁定依据（如「S3 方向重推」）' }
    },
    required: ['project_id', 'locked']
  },
  output: OUTPUT,
  async execute(args) {
    const store = loadStore()
    const p = mustProject(store, args.project_id)
    p.locked = args.locked
    p.lockedAllow = args.allow_changes || []
    p.updatedAt = Date.now()
    p.changelog.push({ at: Date.now(), kind: 'lock_variables', reason: args.reason || '' })
    saveStore(store)
    return { project_id: p.projectId, stage: p.stage, locked: p.locked, allow_changes: p.lockedAllow }
  }
}

const recordGeneration = {
  name: 'industrial_record_generation',
  description:
    '写一条 generation_record（生成可复现性）。每次关键图像生成后必须调用，缺 record 的生成不进指标统计。S5.5/S7 出正交视图须带几何锚（control_mode/reference_image）。',
  parameters: {
    type: 'object',
    properties: {
      project_id: { type: 'string', description: '项目 ID' },
      stage: { type: 'string', description: '生成所在阶段（S4 / S5.5 / S7 …）' },
      view: { type: 'string', enum: ['front', 'side', 'back', 'top', '45', 'perspective', 'scene', 'cmf'], description: '视图：front=正 / side=侧 / back=背 / top=俯 / 45=45° / perspective=透视图 / scene=场景渲染 / cmf=CMF 表现' },
      control_mode: { type: 'string', enum: ['none', 'canny', 'lineart', 'depth'], description: '几何锚定方式。S5.5/S7 出正交视图须用 canny/lineart/depth 锚定骨架投影，禁止 none 裸文生图。' },
      reference_image: { type: 'string', description: '几何锚参考图（锚定线稿/骨架投影图；路径或已上传附件 id）' },
      reference_strength: { type: 'number', description: '几何锚强度 0~1（ControlNet 强度，越接近 1 越贴合参考轮廓）' },
      adapter_strength: { type: 'number', description: '一致性适配强度 0~1（IP-Adapter/MV-Adapter，锁风格与跨视图身份一致）' },
      model_version: { type: 'string', description: '生成模型版本' },
      prompt: { type: 'string', description: '提示词（或其哈希 prompt_hash）' },
      seed: { type: 'string', description: '随机种子（可选）' },
      skeleton_hash: { type: 'string', description: '几何骨架 hash（无骨架则 N/A）' },
      condition_params: { type: 'object', description: '条件控制参数（Canny/Lineart/Depth 阈值等）' },
      design_dna_id: { type: 'string', description: '关联的 design_dna_id（可选，缺省取项目当前值）' },
      note: { type: 'string', description: '备注：回流/否决/难例归因等' }
    },
    required: ['project_id', 'model_version', 'prompt']
  },
  output: OUTPUT,
  async execute(args) {
    const store = loadStore()
    const p = mustProject(store, args.project_id)
    const record = {
      record_id: `gr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      project_id: p.projectId,
      category_id: p.categoryId,
      design_dna_id: args.design_dna_id || p.designDnaId || 'N/A',
      stage: args.stage || p.stage,
      view: args.view || '',
      control_mode: args.control_mode || 'none',
      reference_image: args.reference_image ?? '',
      reference_strength: args.reference_strength ?? null,
      adapter_strength: args.adapter_strength ?? null,
      seed: args.seed ?? '',
      model_version: args.model_version,
      prompt: args.prompt,
      skeleton_hash: args.skeleton_hash ?? 'N/A',
      condition_params: args.condition_params ?? {},
      timestamp: new Date().toISOString(),
      note: args.note || ''
    }
    p.generations.push(record)
    p.updatedAt = Date.now()
    saveStore(store)
    return record
  }
}

const recordConsistency = {
  name: 'industrial_record_consistency',
  description:
    '记录一条 S7 一致性校验结果（10.2 清单逐项判定：机器/人工/混合）。组级任一项不通过即该视图组不通过。用 industrial_compute_consistency 聚合量化。',
  parameters: {
    type: 'object',
    properties: {
      project_id: { type: 'string', description: '项目 ID' },
      item: { type: 'string', description: '校验项（主特征线位置/外轮廓比例/分件线连续性/R角/按键接口数量位置/LOGO位/CMF表现…）' },
      verdict: { type: 'string', enum: ['pass', 'fail'], description: '二值判定' },
      judge_type: { type: 'string', enum: ['machine', 'human', 'mixed'], description: '判定方式：机器/人工/混合' },
      detail: { type: 'string', description: '口径/误差或复核说明' },
      feature_consistency: { type: 'string', description: '可选：特征级一致率（通过特征项数/抽检总特征项数）' },
      view_group: { type: 'string', description: '可选：所属视图组（如 front/side/back/top），用于 industrial_compute_consistency 的组级通过率统计' }
    },
    required: ['project_id', 'item', 'verdict', 'judge_type']
  },
  output: OUTPUT,
  async execute(args) {
    const store = loadStore()
    const p = mustProject(store, args.project_id)
    const record = {
      item: args.item,
      verdict: args.verdict,
      judge_type: args.judge_type,
      detail: args.detail || '',
      feature_consistency: args.feature_consistency || '',
      view_group: args.view_group || '',
      at: Date.now(),
      timestamp: new Date().toISOString()
    }
    p.consistency.push(record)
    p.updatedAt = Date.now()
    saveStore(store)
    return record
  }
}

const synthesizeResearch = {
  name: 'industrial_synthesize_research',
  description:
    'S1：把调研结论结构化归档为洞察清单（编号 I-01…）。每条洞察必须三态标注：fact（事实，带来源）/ inference（推断）/ tbd（待验证）。返回洞察数与 S1 准出门禁提示。',
  parameters: {
    type: 'object',
    properties: {
      project_id: { type: 'string', description: '项目 ID' },
      insights: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '洞察编号，如 I-01' },
            statement: { type: 'string', description: '洞察陈述' },
            source: { type: 'string', description: '事实来源（fact 必填；inference/tbd 可空）' },
            type: { type: 'string', enum: ['fact', 'inference', 'tbd'], description: '三态标注：fact=事实（带来源）/ inference=推断 / tbd=待验证' }
          },
          required: ['id', 'statement', 'type']
        },
        description: '洞察清单'
      },
      opportunities: { type: 'array', items: { type: 'string' }, description: '可选：S2 机会点草稿（2~3 个）' }
    },
    required: ['project_id', 'insights']
  },
  output: OUTPUT,
  async execute(args) {
    const store = loadStore()
    const p = mustProject(store, args.project_id)
    const facts = args.insights.filter((i) => i.type === 'fact').length
    p.research = args.insights
    if (Array.isArray(args.opportunities)) p.opportunities = args.opportunities
    p.updatedAt = Date.now()
    p.changelog.push({ at: Date.now(), kind: 'synthesize_research', facts, total: args.insights.length })
    saveStore(store)
    return {
      project_id: p.projectId,
      total: args.insights.length,
      facts,
      gate_hint: facts >= 5
        ? 'S1 准出门禁满足（≥5 条事实级洞察）。可推进 S2。'
        : `S1 准出门禁未满足：当前 ${facts} 条事实级洞察，需 ≥5。继续补齐调研。`,
      opportunities: p.opportunities || []
    }
  }
}

const recordDna = {
  name: 'industrial_record_dna',
  description:
    'S5：冻结并记录设计 DNA（轮廓比例、主特征线、关键 R 角、分件逻辑、CMF 基调、LOGO 位、人机基准尺寸）+ 锚定线稿。生成 design_dna_id，作为 S6/S7 单一真源。',
  parameters: {
    type: 'object',
    properties: {
      project_id: { type: 'string', description: '项目 ID' },
      design_dna_id: { type: 'string', description: '可选：自定义 DNA id；缺省自动生成' },
      silhouette_ratio: { type: 'string', description: '外轮廓/长宽高比例（如 78×40×12mm，长宽高 6.5:3.3:1）' },
      feature_lines: { type: 'array', items: { type: 'string' }, description: '主特征线描述列表（如「侧视肩部上扬腰线」）' },
      key_radii: { type: 'string', description: '关键 R 角（如「顶部圆角 R8，底部 R3」）' },
      parting_logic: { type: 'string', description: '分件逻辑（分模线/分件线/装配缝位置）' },
      cmf_base: { type: 'string', description: 'CMF 基调（材质/主色/表面处理）' },
      logo_position: { type: 'string', description: 'LOGO 位' },
      ergonomic_dims: { type: 'object', description: '人机基准尺寸（如 握持宽度/按键间距）' },
      anchor_sketch: { type: 'string', description: '锚定线稿（路径或附件 id/哈希）' },
      note: { type: 'string', description: '备注' }
    },
    required: ['project_id']
  },
  output: OUTPUT,
  async execute(args) {
    const store = loadStore()
    const p = mustProject(store, args.project_id)
    const dnaId = args.design_dna_id || `dna-${Date.now().toString(36)}`
    const record = {
      design_dna_id: dnaId,
      silhouette_ratio: args.silhouette_ratio || '',
      feature_lines: args.feature_lines || [],
      key_radii: args.key_radii || '',
      parting_logic: args.parting_logic || '',
      cmf_base: args.cmf_base || '',
      logo_position: args.logo_position || '',
      ergonomic_dims: args.ergonomic_dims || {},
      anchor_sketch: args.anchor_sketch || '',
      note: args.note || '',
      at: Date.now(),
      timestamp: new Date().toISOString()
    }
    p.dna.push(record)
    p.designDnaId = dnaId
    p.updatedAt = Date.now()
    p.changelog.push({ at: Date.now(), kind: 'record_dna', design_dna_id: dnaId })
    saveStore(store)
    return { ...record, gate_hint: 'S5 准出：DNA 已冻结，进入 S5.5/S6/S7 的视图变更必须回流修改本 DNA。' }
  }
}

const recordCmf = {
  name: 'industrial_record_cmf',
  description:
    'S6：记录 CMF（色彩/材质/表面处理）规格与备选方案。S6 准出门禁之一（用户确认 CMF）。',
  parameters: {
    type: 'object',
    properties: {
      project_id: { type: 'string', description: '项目 ID' },
      spec: { type: 'object', description: 'CMF 规格书（material=材质 / finish=表面处理 / color=色号 / texture=纹理 / logo_process=LOGO 工艺）' },
      options: { type: 'array', items: { type: 'string' }, description: '备选 CMF 方案列表（供用户交互选择）' },
      selected: { type: 'string', description: '用户选定的 CMF 方案（与 options 之一对应）' },
      note: { type: 'string', description: '备注' }
    },
    required: ['project_id']
  },
  output: OUTPUT,
  async execute(args) {
    const store = loadStore()
    const p = mustProject(store, args.project_id)
    const record = {
      spec: args.spec || {},
      options: args.options || [],
      selected: args.selected || '',
      note: args.note || '',
      at: Date.now(),
      timestamp: new Date().toISOString()
    }
    p.cmf.push(record)
    p.updatedAt = Date.now()
    p.changelog.push({ at: Date.now(), kind: 'record_cmf', selected: args.selected || '' })
    saveStore(store)
    return { ...record, gate_hint: 'S6 准出之一：CMF 已记录；仍需 DFM 无阻断级问题（用户确认 CMF 时调用 ask_user_question）。' }
  }
}

const recordGeometry = {
  name: 'industrial_record_geometry',
  description:
    'S5.5/S6：记录真实可测几何的导出（STEP/IGES/OBJ/3DM），以及骨架吻合度 / 尺寸校核结论。用于把 S5.5 轻量骨架落地为可测几何、支撑 DFM 初检。',
  parameters: {
    type: 'object',
    properties: {
      project_id: { type: 'string', description: '项目 ID' },
      format: { type: 'string', enum: ['STEP', 'IGES', 'OBJ', '3DM', 'image'], description: '导出格式；image=降级为图（无 CAD 能力时）' },
      file_path: { type: 'string', description: '几何文件路径（或图片路径）' },
      source: { type: 'string', enum: ['skeleton', 'cad_mcp', 'manual'], description: '来源：skeleton=骨架重建 / cad_mcp=CAD MCP 导出 / manual=手工建模' },
      skeleton_match: { type: 'number', description: '骨架吻合度 0~1（S5.5 门禁：投影与锚定线稿关键特征线吻合度）' },
      dimensions_checked: { type: 'boolean', description: '是否完成人机尺寸校核' },
      dfm_notes: { type: 'array', items: { type: 'string' }, description: 'DFM 初检问题列表（拔模角/壁厚/分模面/装配间隙）' },
      note: { type: 'string', description: '备注' }
    },
    required: ['project_id', 'format']
  },
  output: OUTPUT,
  async execute(args) {
    const store = loadStore()
    const p = mustProject(store, args.project_id)
    const record = {
      format: args.format,
      file_path: args.file_path || '',
      source: args.source || 'manual',
      skeleton_match: args.skeleton_match ?? null,
      dimensions_checked: args.dimensions_checked ?? false,
      dfm_notes: args.dfm_notes || [],
      note: args.note || '',
      at: Date.now(),
      timestamp: new Date().toISOString()
    }
    p.geometry.push(record)
    p.updatedAt = Date.now()
    p.changelog.push({ at: Date.now(), kind: 'record_geometry', format: args.format })
    saveStore(store)
    return record
  }
}

const recordConfirm = {
  name: 'industrial_confirm',
  description:
    '记录用户在关键决策点的确认结果（交互确认门禁）。模型必须先调 ask_user_question 拿到用户答案，再用本工具记录；industrial_advance_stage 会硬校验对应阶段是否已确认，未确认无法推进。S7 签收通过 node=signed_off 记录。',
  parameters: {
    type: 'object',
    properties: {
      project_id: { type: 'string', description: '项目 ID' },
      node: { type: 'string', enum: CONFIRM_NODES, description: '确认节点：brief_frozen=冻结Brief / insights_confirmed=确认洞察 / direction_selected=选定方向 / concept_selected=选定方案 / dna_confirmed=确认DNA / cmf_confirmed=确认CMF / signed_off=签收' },
      choice: { type: 'string', description: '用户的选择/答案（如「冻结，进入调研」「方向A」）' },
      note: { type: 'string', description: '备注' }
    },
    required: ['project_id', 'node', 'choice']
  },
  output: OUTPUT,
  async execute(args) {
    const store = loadStore()
    const p = mustProject(store, args.project_id)
    p.confirmations = p.confirmations || {}
    p.confirmations[args.node] = { choice: args.choice, note: args.note || '', at: Date.now(), timestamp: new Date().toISOString() }
    p.updatedAt = Date.now()
    p.changelog.push({ at: Date.now(), kind: 'confirm', node: args.node, choice: args.choice })
    saveStore(store)
    const remaining = CONFIRM_NODES.filter((n) => !p.confirmations[n])
    return {
      project_id: p.projectId,
      stage: p.stage,
      node: args.node,
      choice: args.choice,
      confirmed: Object.keys(p.confirmations),
      remaining_unconfirmed: remaining,
      hint: remaining.length > 0 ? `剩余待确认节点：${remaining.join(' / ')}（按阶段推进时逐个确认）。` : '全部确认节点已完成。'
    }
  }
}

function makeComputeConsistency(getCfg) {
  return {
    name: 'industrial_compute_consistency',
    description:
      '机器判定器：聚合 S7 一致性校验结果，量化「特征级一致率」与「组级通过率」，并与配置阈值比对给出达标判定。10.2 的 launch blocker「同源一致率≥阈值」由本工具落地。',
    parameters: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: '项目 ID' }
      },
      required: ['project_id']
    },
    output: OUTPUT,
    async execute(args) {
      const store = loadStore()
      const p = mustProject(store, args.project_id)
      const items = p.consistency || []
      const total = items.length
      const passed = items.filter((r) => r.verdict === 'pass').length
      const rate = total > 0 ? passed / total : 0
      const threshold = getCfg().consistencyThreshold

      const breakdown = {}
      for (const r of items) {
        breakdown[r.item] = breakdown[r.item] || { pass: 0, fail: 0, judge: r.judge_type }
        breakdown[r.item][r.verdict === 'pass' ? 'pass' : 'fail'] += 1
      }

      const groups = {}
      for (const r of items) {
        if (!r.view_group) continue
        groups[r.view_group] = groups[r.view_group] || []
        groups[r.view_group].push(r)
      }
      const groupNames = Object.keys(groups)
      const passedGroups = groupNames.filter((g) => groups[g].every((r) => r.verdict === 'pass')).length
      const groupRate = groupNames.length > 0 ? passedGroups / groupNames.length : null

      const verdict = total === 0 ? '无数据' : rate >= threshold ? '达标' : '不达标'
      return {
        project_id: p.projectId,
        stage: p.stage,
        total_items: total,
        passed_items: passed,
        feature_consistency_rate: Number(rate.toFixed(4)),
        group_pass_rate: groupRate === null ? null : Number(groupRate.toFixed(4)),
        groups: groupNames.length > 0 ? { total: groupNames.length, passed: passedGroups } : null,
        threshold,
        verdict,
        breakdown,
        note: total === 0
          ? '尚无一致性校验记录，请先在 S7 用 industrial_record_consistency 逐项记录（可带 view_group）。'
          : verdict === '达标'
            ? `特征级一致率 ${(rate * 100).toFixed(1)}% ≥ 阈值 ${(threshold * 100).toFixed(0)}%，S7 一致性校验通过。`
            : `特征级一致率 ${(rate * 100).toFixed(1)}% < 阈值 ${(threshold * 100).toFixed(0)}%，需回流修正视图后重测（对照变量锁定矩阵 §3 的 S7 视图重出）。`
      }
    }
  }
}

// 检测生图工具「能力」而非仅名字：读取每个标准工具的参数 schema，
// 判断是否支持参考图输入（source/source_path 等）与 ControlNet/workflow 几何锚定。
// 注意：这是「声明能力」检测（工具暴露了什么参数），不是「实测能力」（后端是否真按这些参数出图）。
function probeImageCapability(ctx) {
  const getDef = (n) => {
    if (!ctx.tools || typeof ctx.tools.get !== 'function') return undefined
    try { return ctx.tools.get(n) } catch { return undefined }
  }
  const paramNames = (def) => {
    const p = def && def.parameters
    const props = p && typeof p === 'object' ? p.properties : undefined
    return props && typeof props === 'object' ? Object.keys(props) : []
  }
  const REF_FIELDS = ['source', 'source_path', 'source_paths', 'source_attachment_id', 'source_attachment_ids', 'reference_image', 'reference_images', 'init_image', 'image', 'images', 'control_image']
  const WORKFLOW_FIELDS = ['workflow', 'workflow_json', 'controlnet', 'control_mode', 'controlnet_image']
  const STRENGTH_FIELDS = ['reference_strength', 'adapter_strength', 'strength', 'denoise', 'controlnet_strength', 'conditioning_scale']

  const probe = (name) => {
    const def = getDef(name)
    if (!def) return null
    const props = paramNames(def)
    const refFields = props.filter((f) => REF_FIELDS.includes(f))
    const workflowFields = props.filter((f) => WORKFLOW_FIELDS.includes(f))
    const strengthFields = props.filter((f) => STRENGTH_FIELDS.includes(f))
    const anchoring = workflowFields.length > 0 ? 'workflow' : refFields.length > 0 ? 'reference' : 'text_only'
    return { tool: name, anchoring, ref_fields: refFields, workflow_fields: workflowFields, strength_fields: strengthFields }
  }

  const detected = ['generate_image', 'generate_images', 'edit_image'].map(probe).filter(Boolean)
  const names = detected.map((d) => d.tool)
  let anchoring = 'none'
  if (detected.length > 0) {
    const hasWorkflow = detected.some((d) => d.workflow_fields.length > 0)
    const hasRef = detected.some((d) => d.ref_fields.length > 0)
    anchoring = hasWorkflow && hasRef ? 'full' : hasWorkflow ? 'workflow' : hasRef ? 'reference' : 'text_only'
  }

  const CAP_NOTES = {
    none: '未检测到生图工具（generate_image / generate_images / edit_image）：S7 视图渲染需先安装并配置具备生图能力的插件。',
    full: '支持几何锚定（ControlNet/workflow + 参考图输入），可产出 S7 正交视图组。',
    workflow: '检测到 ControlNet/workflow 参数（可几何锚定），但未见参考图编辑入口——建议核实 edit_image 是否可用。',
    reference: '检测到参考图输入（图生图/IP-Adapter），但未见 ControlNet/workflow 参数——多视图一致性需靠参考图锁定，几何锚定能力有限。',
    text_only: '仅检测到 prompt 生图（纯文生图），无法满足 S7「禁止裸文生图」红线——请换用支持 ControlNet/参考图的条件控制插件。'
  }

  return {
    names,
    anchoring,
    tools: detected,
    note: names.length > 0
      ? `已检测到生图工具：${names.join('、')}。能力判定：${CAP_NOTES[anchoring]}`
      : CAP_NOTES.none
  }
}

function makeGetState(ctx, getCfg) {
  return {
    name: 'industrial_get_state',
    description:
      '读取项目当前状态：stage / category_id / 锁定变量 / design_dna_id / generation_record / 一致性结果 / 洞察 / DNA / CMF / 几何；并检测生图工具与 CAD 工具是否可用（S7 渲染与 S6 几何依赖）。',
    parameters: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: '项目 ID' }
      },
      required: ['project_id']
    },
    output: OUTPUT,
    async execute(args) {
      const store = loadStore()
      const p = mustProject(store, args.project_id)

      const cap = probeImageCapability(ctx)
      const imageTools = cap.names
      const hasImageGen = imageTools.length > 0

      const cfg = getCfg()
      const cadPrefix = (cfg.cadMCP || '').trim()
      const knownCad = ['freecad_mcp', 'cad_mcp', 'freecad', 'cogram']
      let cadTools = []
      if (ctx.tools && typeof ctx.tools.get === 'function') {
        cadTools = knownCad.filter((n) => ctx.tools.get(n))
        if (cadPrefix && !cadTools.includes(cadPrefix)) {
          try {
            const defs = typeof ctx.tools.definitions === 'function' ? ctx.tools.definitions() : null
            if (defs) {
              const names = (Array.isArray(defs) ? defs : Object.values(defs))
                .map((d) => (d && typeof d === 'object' ? d.name : d))
                .filter((n) => typeof n === 'string')
              cadTools = cadTools.concat(names.filter((n) => n.startsWith(cadPrefix)))
            }
          } catch { /* ignore */ }
        }
      }
      const hasCad = cadTools.length > 0

      const cons = p.consistency || []
      const consTotal = cons.length
      const consPassed = cons.filter((r) => r.verdict === 'pass').length

      return {
        ...p,
        image_gen_available: hasImageGen,
        image_tools: imageTools,
        image_capability: {
          anchoring: cap.anchoring,
          tools: cap.tools.map((d) => ({
            tool: d.tool,
            anchoring: d.anchoring,
            ref_fields: d.ref_fields,
            workflow_fields: d.workflow_fields,
            strength_fields: d.strength_fields
          }))
        },
        image_gen_note: cap.note,
        cad_available: hasCad,
        cad_tools: cadTools,
        cad_note: hasCad
          ? `已检测到 CAD 工具：${cadTools.join('、')}（S6 可导出真实几何 STEP/IGES/OBJ）。`
          : cadPrefix
            ? `未检测到前缀为 "${cadPrefix}" 的 CAD 工具：S6 降级为「图 + 说明」。`
            : '未配置 cadMCP 且未检测到已知 CAD 工具：S6 降级为「图 + 说明」（不产出可测几何）。',
        consistency: consTotal > 0
          ? { total: consTotal, passed: consPassed, feature_rate: Number((consPassed / consTotal).toFixed(4)) }
          : { total: 0, passed: 0, feature_rate: null },
        summary: {
          generations: (p.generations || []).length,
          consistency_records: consTotal,
          research_insights: (p.research || []).length,
          dna_records: (p.dna || []).length,
          cmf_records: (p.cmf || []).length,
          geometry_records: (p.geometry || []).length
        },
        config: cfg,
        confirmations: p.confirmations || {},
        pending_confirmation: (() => {
          const gate = CONFIRM_GATES[p.stage]
          if (gate && !(p.confirmations && p.confirmations[gate.key])) {
            return { stage: p.stage, key: gate.key, label: gate.label, question: gate.question }
          }
          return null
        })()
      }
    }
  }
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------
export function apply(ctx, config = {}) {
  const unwrap = (value) =>
    value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value

  const getCfg = () => ({
    firstCategoryN: unwrap(config.firstCategoryN) ?? 30,
    consistencyThreshold: unwrap(config.consistencyThreshold) ?? 0.9,
    skeletonMatchThreshold: unwrap(config.skeletonMatchThreshold) ?? 0.85,
    maxConvergenceRounds: unwrap(config.maxConvergenceRounds) ?? 3,
    categoryList: unwrap(config.categoryList) ?? [],
    cadMCP: unwrap(config.cadMCP) ?? ''
  })

  // 显式声明「自动生成设置表单」策略，确保 Settings > Plugins 出可编辑表单。
  const settings = ctx.get('settings')
  if (settings && typeof settings.configure === 'function') {
    try {
      ctx.effect(() => settings.configure({ auto: true }))
    } catch {
      /* 已注册策略时忽略 */
    }
  }

  ctx.effect(() => {
    const skills = ctx.get('skills')
    if (!skills) return
    return skills.register({
      name: 'industrial-design-master',
      title: '工业设计大师（S0–S7 状态机）',
      description: SKILL.meta.description || '工业设计七阶段状态机认知层',
      whenToUse: SKILL.meta.whenToUse || '用户发起工业设计或产品外观设计需求时',
      source: 'dsh-industrial-design',
      content: SKILL.body,
      invocation: { modelInvocable: true, userInvocable: true }
    })
  })

  ctx.effect(() => {
    const disposers = [
      ctx.tools.register(makeProjectInit(getCfg)),
      ctx.tools.register(advanceStage),
      ctx.tools.register(lockVariables),
      ctx.tools.register(recordGeneration),
      ctx.tools.register(recordConsistency),
      ctx.tools.register(synthesizeResearch),
      ctx.tools.register(recordDna),
      ctx.tools.register(recordCmf),
      ctx.tools.register(recordGeometry),
      ctx.tools.register(recordConfirm),
      ctx.tools.register(makeComputeConsistency(getCfg)),
      ctx.tools.register(makeGetState(ctx, getCfg))
    ]
    return () => disposers.forEach((dispose) => dispose())
  })
}
