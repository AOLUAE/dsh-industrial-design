/**
 * dsh-industrial-design — Host bundle for the "工业设计大师" S0–S7 state machine.
 *
 * Bundles the cognitive-layer skill (skills/industrial-design-master/SKILL.md) and
 * registers six state-machine tools. Project state is persisted to a file-backed
 * JSON store (MVP: not cross-process safe; see README).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const inject = ['tools']

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
    generations: [],
    consistency: [],
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

const projectInit = {
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
    store[args.project_id] = newProject(args)
    saveStore(store)
    return store[args.project_id]
  }
}

const advanceStage = {
  name: 'industrial_advance_stage',
  description:
    '推进设计阶段（S0→S1→…→S7）。默认前进一格；可显式回流到较早阶段（须给 reason）。前进不可跳级。返回新状态与下一阶段准出门禁提示。',
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
    if (curIdx === 0 && targetIdx === 1 && !p.categoryId) {
      throw new Error('S0 准出需要 category_id（品类未声明）。用 industrial_project_init 声明品类后再推进。')
    }
    if (args.design_dna_id) p.designDnaId = args.design_dna_id
    const from = p.stage
    p.stage = STAGES[targetIdx]
    p.updatedAt = Date.now()
    p.changelog.push({ at: Date.now(), from, to: p.stage, reason: args.reason || (targetIdx > curIdx ? 'advance' : 'reflow') })
    saveStore(store)
    return { ...p, gate_hint: GATES[p.stage] || '' }
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
    '写一条 generation_record（生成可复现性）。每次关键图像生成后必须调用，缺 record 的生成不进指标统计。',
  parameters: {
    type: 'object',
    properties: {
      project_id: { type: 'string', description: '项目 ID' },
      stage: { type: 'string', description: '生成所在阶段（S4 / S5.5 / S7 …）' },
      view: { type: 'string', description: '视图（正/侧/背/俯/45°/透视图/场景渲染）' },
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
    '记录一条 S7 一致性校验结果（10.2 清单逐项判定：机器/人工/混合）。组级任一项不通过即该视图组不通过。',
  parameters: {
    type: 'object',
    properties: {
      project_id: { type: 'string', description: '项目 ID' },
      item: { type: 'string', description: '校验项（主特征线位置/外轮廓比例/分件线连续性/R角/按键接口数量位置/LOGO位/CMF表现…）' },
      verdict: { type: 'string', enum: ['pass', 'fail'], description: '二值判定' },
      judge_type: { type: 'string', enum: ['machine', 'human', 'mixed'], description: '判定方式：机器/人工/混合' },
      detail: { type: 'string', description: '口径/误差或复核说明' },
      feature_consistency: { type: 'string', description: '可选：特征级一致率（通过特征项数/抽检总特征项数）' }
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
      at: Date.now(),
      timestamp: new Date().toISOString()
    }
    p.consistency.push(record)
    p.updatedAt = Date.now()
    saveStore(store)
    return record
  }
}

function makeGetState(ctx) {
  return {
    name: 'industrial_get_state',
    description:
      '读取项目当前状态：stage / category_id / 锁定变量 / design_dna_id / generation_record 列表 / 一致性结果列表；并检测生图工具 generate_image 是否可用（S7 视图渲染依赖）。',
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
      const hasImageGen = Boolean(ctx.tools && typeof ctx.tools.get === 'function' && ctx.tools.get('generate_image'))
      return {
        ...p,
        image_gen_available: hasImageGen,
        image_gen_note: hasImageGen
          ? 'generate_image 工具可用（dsh-image-gen 已激活）。'
          : '未检测到 generate_image：S7 视图渲染需要 dsh-image-gen 插件（含已配置凭据），请先安装并配置。'
      }
    }
  }
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------
export function apply(ctx, _config) {
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
      ctx.tools.register(projectInit),
      ctx.tools.register(advanceStage),
      ctx.tools.register(lockVariables),
      ctx.tools.register(recordGeneration),
      ctx.tools.register(recordConsistency),
      ctx.tools.register(makeGetState(ctx))
    ]
    return () => disposers.forEach((dispose) => dispose())
  })
}
