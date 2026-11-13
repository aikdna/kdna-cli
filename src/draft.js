'use strict';
/*
 * Friendly 0.6.0 authoring: a small human/Agent-friendly draft that compiles
 * into the full authored input `kdna create` accepts.
 *
 * Draft format (marker `kdna.draft/1`):
 *   {
 *     format: 'kdna.draft/1',
 *     asset: { id, type?, title, summary, language, version, description?, keywords?, license? },
 *     scope: 'one sentence: what this asset covers and what it does not',
 *     actors: [{ id, name, kind? }],        // kind defaults to 'person'
 *     highest_question: 'the question the whole asset answers',
 *     boundaries: 'asset-level limits' | null,
 *     judgments: [{
 *       id,                                 // e.g. 'update:order'
 *       focus,                              // short title of the judgment
 *       statement,                          // the authored conclusion
 *       applies_when,                       // judgment scope sentence
 *       boundaries?: string,                // judgment-level limits
 *       method?: 'feeling' | { term, roles: { '<role-or-en-alias>': 'text' } }
 *       answer_kind?: 'preference',
 *       reasons?: string[],
 *       example?: { summary, context, input?, application, result }
 *     }],                                   // at least one
 *     timestamp?: ISO-8601 'Z' string       // created_at/updated_at; default: now
 *   }
 */
const { randomUUID } = require('node:crypto');

const FORMAT = 'kdna.draft/1';
const SLUG = /^[a-z0-9][a-z0-9._-]*$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const INIT_MODES = new Set(['minimal', 'interview', 'works', 'research']);
const INIT_LANGS = new Set(['en', 'zh']);
const ASSET_TYPES = new Set(['domain', 'cluster', 'tool', 'sample', 'fixture', 'bundle']);
const DUPLICATE_ROLE_FIX_HINT = 'Each role in method.components must appear at most once per judgment. Merge statements that share the same role in order into a single component so no authored reasoning is lost.';
const CATCH_ALL_SCOPES = new Set(['all', 'always', 'any', 'everything', 'general', 'universal', '通用', '所有', '所有场景', '任何', '任何场景', '全部', '不限']);

// 1-to-1 English draft aliases for Core's closed `method_roles` vocabulary.
// Authors in `kdna.draft/1` may write either these English keys or Core's
// canonical Chinese role keys; `compileDraft` emits Core's canonical role keys.
const ROLE_ALIASES_EN = Object.freeze({
  analogy: Object.freeze({
    reference_case: '参照对象',
    correspondence: '对应关系',
    transfer_rule: '借用办法',
    key_differences: '关键差异',
    non_transferable_limits: '不可迁移之处',
  }),
  calculation: Object.freeze({
    inputs_and_meaning: '输入与含义',
    formula_or_relation: '计算关系',
    assumptions: '计算假设',
    bounds: '取值边界',
    error_notes: '误差说明',
  }),
  causal_analysis: Object.freeze({
    phenomenon: '待解释现象',
    causal_link: '原因关系',
    candidate_causes: '候选原因',
    distinguishing_basis: '区分依据',
    counterfactual_cases: '反向情况',
  }),
  criteria_comparison: Object.freeze({
    criterion: '判断标准',
    comparison_method: '对照办法',
    decision_rule: '归结办法',
    baseline_floor: '底线要求',
    exceptions: '例外情况',
  }),
  elimination: Object.freeze({
    candidate_set: '候选范围',
    elimination_criteria: '排除条件',
    retention_rule: '保留办法',
    special_cases: '特殊情况处理',
  }),
  evidence_analysis: Object.freeze({
    materials_used: '所用材料',
    evidence_link: '材料与判断的联系',
    contrary_evidence: '反向材料',
    weighing_rationale: '材料取舍',
  }),
  experience: Object.freeze({
    lesson: '经验要点',
    reference_experience: '参考经历',
    applicable_cases: '适用情形',
    exceptions: '例外情况',
  }),
  feedback: Object.freeze({
    target: '调整目标',
    signal: '反馈信号',
    adjustment_rule: '调整办法',
    stop_condition: '停止条件',
    conflict_handling: '冲突处理',
  }),
  feeling: Object.freeze({
    personal_preference: '个人感受',
    experience_notes: '体验说明',
    preference_shift: '偏好变化',
  }),
  inference: Object.freeze({
    premise: '判断前提',
    derivation: '推导关系',
    key_assumptions: '关键假设',
    exceptions: '例外情况',
  }),
  interpretation: Object.freeze({
    subject_interpreted: '解读对象',
    interpretive_link: '解释关系',
    context: '相关语境',
    cues: '理解线索',
    alternative_readings: '替代解读',
  }),
  observation: Object.freeze({
    observed_basis: '观察依据',
    criteria: '判定口径',
    observation_limits: '观察限制',
  }),
  other: Object.freeze({
    method_description: '方法说明',
    basis: '判断依据',
    relation: '作用关系',
    notes: '补充说明',
    limits: '适用限制',
  }),
  recognition: Object.freeze({
    features: '识别特征',
    category_definition: '类别定义',
    matching_rule: '匹配办法',
    confusable_cases: '易混淆情况',
  }),
  simulation: Object.freeze({
    initial_conditions: '起点条件',
    change_assumptions: '变化假设',
    progression: '演变关系',
    branching_scenarios: '情景分叉',
    inflection_signals: '转折信号',
  }),
  tradeoff: Object.freeze({
    options: '候选方案',
    factors: '比较因素',
    priority_rule: '取舍原则',
    accepted_cost: '不可兼得之处',
    priority_shift: '优先变化',
  }),
});

function englishAliasFor(term, canonicalRole) {
  const aliases = ROLE_ALIASES_EN[term];
  if (!aliases) return null;
  for (const [en, zh] of Object.entries(aliases)) if (zh === canonicalRole) return en;
  return null;
}

function formatRoleLabel(term, canonicalRole) {
  const en = englishAliasFor(term, canonicalRole);
  return en ? `${en} (${canonicalRole})` : canonicalRole;
}

function resolveDraftRoles(term, givenRoles) {
  const aliases = ROLE_ALIASES_EN[term] ?? {};
  const normalized = {};
  const sourceKeysByCanonical = new Map();
  const unknown = [];
  for (const [rawKey, value] of Object.entries(givenRoles)) {
    const canonical = aliases[rawKey] ?? rawKey;
    if (!sourceKeysByCanonical.has(canonical)) sourceKeysByCanonical.set(canonical, []);
    sourceKeysByCanonical.get(canonical).push(rawKey);
    normalized[canonical] = value;
  }
  const duplicates = [];
  for (const [canonical, keys] of sourceKeysByCanonical.entries()) {
    if (keys.length > 1) duplicates.push({ role: canonical, keys });
  }
  return { normalized, duplicates, unknown };
}

function roleTable() {
  try {
    const m = require('@aikdna/kdna-core/components');
    return typeof m.getMethodRoleTable === 'function' ? m.getMethodRoleTable() : null;
  } catch { return null; }
}

function inspectMethodComponents(judgment, table = roleTable()) {
  const term = judgment?.method?.method?.term;
  const roles = table && typeof term === 'string' ? table.roles?.[term] : null;
  if (!roles || !Array.isArray(judgment?.method?.components)) return null;
  const allowed = new Set([...roles.required, ...roles.optional]);
  const byRole = new Map();
  const invalidSet = new Set();
  judgment.method.components.forEach((component, idx) => {
    const r = component?.role;
    if (typeof r !== 'string') return;
    const cid = typeof component?.id === 'string' && component.id.trim() !== '' ? component.id : `#${idx}`;
    if (!byRole.has(r)) byRole.set(r, []);
    byRole.get(r).push(cid);
    if (!allowed.has(r)) invalidSet.add(r);
  });
  const duplicate_roles = [];
  for (const [role, component_ids] of byRole.entries()) {
    if (component_ids.length > 1) duplicate_roles.push({ role, component_ids });
  }
  const invalid_roles = [...invalidSet];
  const missing_required_roles = roles.required.filter(r => !byRole.has(r));
  return {
    term,
    expected: roles.required,
    optional: roles.optional,
    duplicate_roles,
    invalid_roles,
    missing_required_roles,
    ...(duplicate_roles.length ? { fix_hint: DUPLICATE_ROLE_FIX_HINT } : {}),
  };
}

function exampleDraft(mode, lang) {
  const zh = lang === 'zh';
  if (mode === 'interview') {
    return zh ? {
      format: FORMAT,
      asset: { id: 'release-readiness-decisions', type: 'domain', title: '发布门禁与时效取舍规范', summary: '团队在上线窗口与回归验证冲突时的判断取舍。', language: 'zh-CN', version: '0.1.0' },
      scope: '适用于常规产品迭代的发布评审；紧急安全漏洞止血不在此范围。',
      actors: [{ id: 'author', name: '示例团队负责人', kind: 'person' }],
      highest_question: '当约定上线时间与关键回归验证发生冲突时，团队如何取舍？',
      boundaries: '不适用于正在造成数据损坏的线上紧急故障止血。',
      judgments: [{
        id: 'decision:first-dilemma',
        focus: '上线时间窗口与未完成回归检查冲突时如何抉择',
        statement: '只要核心路径的契约或数据完整性检查未完成，就推迟发布窗口，宁可承担延期沟通成本也不带未知风险上线。',
        applies_when: '常规版本发布前24小时内发现核心流程存在未验证变更。',
        boundaries: '当线上已发生P0级数据损坏且热修复仅触及单一隔离开关时，转入紧急止血流程。',
        method: {
          term: 'tradeoff',
          roles: {
            '候选方案': '按原时间带未验证变更上线，或推迟发布先完成核心回归检查。',
            '比较因素': '短期准时交付承诺与核心数据及契约可回滚性。',
            '取舍原则': '不可逆的数据与契约风险高于短期排期守时。',
            '不可兼得之处': '接受短期延期通告与外部排期重排的沟通成本。',
          },
        },
      }],
    } : {
      format: FORMAT,
      asset: { id: 'release-readiness-decisions', type: 'domain', title: 'Release gate tradeoffs', summary: 'How our team trades schedule predictability against unverified release changes.', language: 'en', version: '0.1.0' },
      scope: 'Routine product release readiness reviews; active P0 security or data-loss hotfixes are outside this scope.',
      actors: [{ id: 'author', name: 'Example release lead', kind: 'person' }],
      highest_question: 'When a target ship window collides with an incomplete core verification check, which gives way?',
      boundaries: 'Does not apply during active P0 data-corruption containment where an isolated kill-switch hotfix is required.',
      judgments: [{
        id: 'decision:first-dilemma',
        focus: 'Ship window versus incomplete core contract verification',
        statement: 'Hold the release window whenever a core contract or data-integrity check remains unverified, even if stakeholders must be notified of a slip.',
        applies_when: 'Routine scheduled releases within 24 hours of launch when a core path changed after the last green verification run.',
        boundaries: 'Yields to emergency containment protocol during an active P0 data-loss incident.',
        method: {
          term: 'tradeoff',
          roles: {
            options: 'Ship on the announced date with an unverified core change versus slip the window until verification completes.',
            factors: 'Calendar predictability versus irreversible contract or data regression.',
            priority_rule: 'Reversible schedule slips always beat irreversible integrity regressions.',
            accepted_cost: 'Explicitly accept stakeholder rescheduling overhead and delay announcements.',
          },
        },
      }],
    };
  }
  if (mode === 'works') {
    return zh ? {
      format: FORMAT,
      asset: { id: 'technical-review-standards', type: 'domain', title: '技术方案评审标准提炼', summary: '从既有评审记录提炼的设计文档准入标准。', language: 'zh-CN', version: '0.1.0' },
      scope: '适用于跨服务接口与数据模型变更的设计评审；单文件局部重构不在此范围。',
      actors: [{ id: 'author', name: '示例架构评审人', kind: 'person' }],
      highest_question: '一份跨服务技术方案需要满足什么标准才能进入实现？',
      boundaries: '不适用于探索性原型验证阶段的一次性实验代码。',
      judgments: [{
        id: 'work:first-criterion',
        focus: '设计方案是否明确写出失败回退与不适用边界',
        statement: '凡涉及持久化或跨服务契约的方案，必须先写明失败回退路径与明确的不适用条件，否则退回补充后再审。',
        applies_when: '评审涉及数据库结构、消息契约或公共API变更的技术方案时。',
        boundaries: '纯内部无状态计算函数的性能优化无需单独提交回退预案。',
        method: {
          term: 'criteria_comparison',
          roles: {
            '判断标准': '方案是否同时给出可执行的失败回退步骤与明确的适用边界。',
            '对照办法': '逐项核对变更涉及的持久化表与外部接口是否配有回滚或降级路径。',
            '归结办法': '两项齐全即准予进入实现；任一项缺失则退回补充。',
          },
        },
        reasons: ['历史故障复盘表明，缺少回退预案的变更平均恢复时间显著拉长。'],
        example: {
          summary: '订单状态枚举扩展评审',
          context: '团队准备为订单表新增两个中间状态并同步给结算服务。',
          input: '初版方案只描述了正向迁移SQL与新字段含义，未说明旧版消费者读取新状态的兼容处理。',
          application: '对照失败回退与兼容边界标准，要求补充双写过渡与回滚步骤。',
          result: '作者补充读兼容降级策略后二次评审通过。',
        },
      }],
    } : {
      format: FORMAT,
      asset: { id: 'technical-review-standards', type: 'domain', title: 'Design review admission criteria', summary: 'Distilled standards for approving cross-service engineering design proposals.', language: 'en', version: '0.1.0' },
      scope: 'Design proposals touching persistent schemas or cross-service APIs; single-module refactors and throwaway spikes are excluded.',
      actors: [{ id: 'author', name: 'Example staff reviewer', kind: 'person' }],
      highest_question: 'When is a cross-service technical proposal ready to move from design review into implementation?',
      boundaries: 'Throwaway prototype spikes that never touch production data or shared APIs are outside this standard.',
      judgments: [{
        id: 'work:first-criterion',
        focus: 'Explicit rollback path and non-goals before implementation',
        statement: 'Return any schema or cross-service API proposal for revision until it names both an executable rollback step and explicit out-of-scope boundaries.',
        applies_when: 'Reviewing engineering RFCs that alter database tables, queue payloads, or public HTTP contracts.',
        boundaries: 'Stateless internal helper changes with no wire or storage impact do not require a separate rollback section.',
        method: {
          term: 'criteria_comparison',
          roles: {
            criterion: 'Presence of an executable rollback procedure and explicit non-goal boundaries for every changed contract.',
            comparison_method: 'Check each modified table or endpoint in the proposal against its stated downgrade and rollback behavior.',
            decision_rule: 'Approve for implementation when both are concrete; return for revision if either is missing or hand-waved.',
          },
        },
        reasons: ['Past postmortems showed unscripted rollbacks multiplied recovery time during partial deploys.'],
        example: {
          summary: 'Order status enum expansion RFC',
          context: 'Checkout service proposed two new intermediate order states consumed by billing.',
          input: 'Draft RFC specified forward migration SQL only without old-consumer fallback behavior.',
          application: 'Checked against the rollback and compatibility criterion and requested a two-phase read-compatible rollout plan.',
          result: 'Proposal was approved on the next pass once unknown-enum fallback and rollback steps were added.',
        },
      }],
    };
  }
  if (mode === 'research') {
    return zh ? {
      format: FORMAT,
      asset: { id: 'queue-retry-positions', type: 'domain', title: '异步任务重试与死信策略研究判断', summary: '基于压测与故障材料确定的异步队列重试上限立场。', language: 'zh-CN', version: '0.1.0' },
      scope: '适用于调用外部第三方支付或通知接口的异步工作队列；内存态幂等重算不在此范围。',
      actors: [{ id: 'author', name: '示例平台工程组', kind: 'person' }],
      highest_question: '外部依赖抖动时，异步工作队列应如何设定自动重试与隔离边界？',
      boundaries: '当下游明确返回参数非法等4xx确定性拒绝时，禁止进入自动重试。',
      judgments: [{
        id: 'research:first-position',
        focus: '外部接口超时场景下的指数退避重试上限',
        statement: '对可重试的5xx或网络超时采用带抖动的指数退避，自动重试不超过3次，超限立即转入死信队列等待人工或批量重放。',
        applies_when: '异步消费者调用具备幂等键保护的外部HTTP接口并收到5xx或连接超时。',
        boundaries: '无幂等键保护的扣款或发券接口在确认下游状态前不得自动重放。',
        method: {
          term: 'evidence_analysis',
          roles: {
            '所用材料': '过去两季度的网关超时压测报告与三次雪崩事故复盘记录。',
            '材料与判断的联系': '压测显示超过3次无上限重试会把队列积压放大4倍并拖垮共享连接池。',
            '反向材料': '短暂网络闪断在10秒内恢复时，多重试几次可减少人工重放操作。',
            '材料取舍': '优先用3次上限与死信隔离阻断级联雪崩，再用批量重放工具弥补长闪断恢复。',
          },
        },
      }],
    } : {
      format: FORMAT,
      asset: { id: 'queue-retry-positions', type: 'domain', title: 'Async webhook retry positions', summary: 'Evidence-backed retry and dead-letter positions for outbound webhook workers.', language: 'en', version: '0.1.0' },
      scope: 'Asynchronous worker queues calling idempotent external HTTP endpoints; non-idempotent mutations without idempotency keys are excluded.',
      actors: [{ id: 'author', name: 'Example platform team', kind: 'person' }],
      highest_question: 'How aggressively should outbound worker queues retry transient upstream failures before isolating messages?',
      boundaries: 'Deterministic 4xx validation rejections and non-idempotent mutations must never enter automatic retry.',
      judgments: [{
        id: 'research:first-position',
        focus: 'Capped jittered backoff before dead-letter isolation',
        statement: 'Cap automatic retries at three attempts with jittered exponential backoff on 5xx or timeout responses, then route immediately to the dead-letter queue.',
        applies_when: 'Outbound worker tasks carrying an idempotency key that receive HTTP 5xx or socket timeout errors.',
        boundaries: 'Stops immediately on HTTP 4xx responses or whenever an endpoint lacks idempotency-key deduplication.',
        method: {
          term: 'evidence_analysis',
          roles: {
            materials_used: 'Two quarters of load-test traces and three upstream brownout postmortems.',
            evidence_link: 'Traces showed retries beyond three attempts amplified worker pool saturation 4x without improving success rate during brownouts.',
            contrary_evidence: 'Higher retry caps occasionally auto-healed 60-second partner blips without operator replay.',
            weighing_rationale: 'Preventing cascading worker exhaustion outweighs occasional one-command dead-letter replay after long blips.',
          },
        },
      }],
    };
  }
  return zh ? {
    format: FORMAT,
    asset: { id: 'weekly-update-preferences', type: 'domain', title: '团队异步周报书写偏好', summary: '关于常规异步团队周报先后顺序的简洁判断。', language: 'zh-CN', version: '0.1.0' },
    scope: '适用于团队常规异步文字周报；线上紧急故障通报不在此范围。',
    actors: [{ id: 'author', name: '示例作者', kind: 'person' }],
    highest_question: '一份常规异步周报应当按什么顺序组织核心信息？',
    boundaries: '不适用于需要即时响应的线上事故升级通报。',
    judgments: [{
      id: 'main:first',
      focus: '异步周报的段落顺序',
      statement: '先写本周已完成并可验证的结果，再写当前阻塞项，最后写下周唯一最关键的下一步动作。',
      applies_when: '撰写面向跨职能协作成员的常规异步周报时。',
      boundaries: '当存在需要队友在截止时间前拍板的阻塞决策时，将该决策请求置顶。',
      method: 'feeling',
    }],
  } : {
    format: FORMAT,
    asset: { id: 'weekly-update-preferences', type: 'domain', title: 'Async weekly update order', summary: 'How routine asynchronous engineering status updates should be ordered.', language: 'en', version: '0.1.0' },
    scope: 'Routine weekly asynchronous written team updates; live incident response is outside this scope.',
    actors: [{ id: 'author', name: 'Example author', kind: 'person' }],
    highest_question: 'In what order should a routine weekly written update present information?',
    boundaries: 'Does not apply to live incident pages or urgent escalation notices.',
    judgments: [{
      id: 'main:first',
      focus: 'Order of sections in a weekly written update',
      statement: 'Lead with shipped outcomes backed by a link, follow with active blockers, and close with the next concrete action.',
      applies_when: 'Writing routine weekly asynchronous updates for teammates and leads.',
      boundaries: 'If a time-sensitive decision from a reader blocks the next action, place that decision request at the top.',
      method: 'feeling',
    }],
  };
}

function scaffoldDraft(mode = 'minimal', options = {}) {
  if (!INIT_MODES.has(mode)) {
    throw Object.assign(new Error('KDNA_INVALID_INIT_MODE'), { code: 'KDNA_INVALID_INIT_MODE' });
  }
  const lang = options?.lang ?? 'en';
  if (!INIT_LANGS.has(lang)) {
    throw Object.assign(new Error('KDNA_INVALID_INIT_LANG'), { code: 'KDNA_INVALID_INIT_LANG' });
  }
  if (options?.example === true) {
    return exampleDraft(mode, lang);
  }
  const zh = lang === 'zh';
  if (mode === 'interview') {
    return zh ? {
      format: FORMAT,
      asset: { id: 'my-decision-system', type: 'domain', title: 'TODO: 你的判断系统标题', summary: 'TODO: 用一句话说明这套判断系统帮助决定哪些反复出现的选择', language: 'zh-CN', version: '0.1.0' },
      scope: 'TODO: 说明这套判断系统覆盖的具体工作情境，以及哪些情形不在范围内。',
      actors: [{ id: 'author', name: 'TODO: 作者姓名或团队名称', kind: 'person' }],
      highest_question: 'TODO: 这套判断系统整体回答的核心问题',
      boundaries: 'TODO: 整份资产层面的硬边界（在哪些情形下必须停用或交回人工判断）',
      judgments: [{
        id: 'decision:first-dilemma',
        focus: 'TODO: 两个目标发生冲突时的具体抉择问题',
        statement: 'TODO: 用你自己的话写出可执行的取舍结论（不要写空泛套话）',
        applies_when: 'TODO: 触发这条判断的具体条件（谁、什么任务、什么时机）',
        boundaries: 'TODO: 这条判断停止适用或发生反转的明确阈值/反例条件',
        method: {
          term: 'tradeoff',
          roles: {
            '候选方案': 'TODO: 彼此竞争的具体候选方案',
            '比较因素': 'TODO: 在压力下重点权衡的比较因素',
            '取舍原则': 'TODO: 哪个因素优先胜出及其理由',
            '不可兼得之处': 'TODO: 你明确愿意承担的代价或舍弃项',
          },
        },
      }],
    } : {
      format: FORMAT,
      asset: { id: 'my-decision-system', type: 'domain', title: 'TODO: title of your judgment system', summary: 'TODO: one sentence on what recurring choices this system helps decide', language: 'en', version: '0.1.0' },
      scope: 'TODO: the specific work situations this system covers, and what stays outside it.',
      actors: [{ id: 'author', name: 'TODO: author name', kind: 'person' }],
      highest_question: 'TODO: the overarching question this judgment system answers',
      boundaries: 'TODO: asset-wide hard limits where these judgments must stop or yield',
      judgments: [{
        id: 'decision:first-dilemma',
        focus: 'TODO: the contested decision question when two goals collide',
        statement: 'TODO: your operational choice or priority in your own words (not a generic platitude)',
        applies_when: 'TODO: concrete conditions (who, what task, when) under which this choice applies',
        boundaries: 'TODO: exact case or threshold where this rule stops applying or flips',
        method: {
          term: 'tradeoff',
          roles: {
            options: 'TODO: the concrete options being weighed against each other',
            factors: 'TODO: the factors compared under pressure',
            priority_rule: 'TODO: which factor wins first and why',
            accepted_cost: 'TODO: what cost or downside you explicitly accept',
          },
        },
      }],
    };
  }
  if (mode === 'works') {
    return zh ? {
      format: FORMAT,
      asset: { id: 'my-distilled-works', type: 'domain', title: 'TODO: 从既有作品提炼的判断系统标题', summary: 'TODO: 用一句话说明从作者既有作品中提炼出的领域判断', language: 'zh-CN', version: '0.1.0' },
      scope: 'TODO: 原作覆盖的领域与受众情境，以及明确排除的范围。',
      actors: [{ id: 'author', name: 'TODO: 原作者姓名', kind: 'person' }],
      highest_question: 'TODO: 这些作品共同回答的中心问题',
      boundaries: 'TODO: 整份提炼作品的适用边界',
      judgments: [{
        id: 'work:first-criterion',
        focus: 'TODO: 从作者作品中提炼出的具体常见评审/决策问题',
        statement: 'TODO: 作者明确主张的结论或准入标准',
        applies_when: 'TODO: 作者应用这一标准的具体审阅或创作情境',
        boundaries: 'TODO: 作者指出的例外情形或停止适用边界',
        method: {
          term: 'criteria_comparison',
          roles: {
            '判断标准': 'TODO: 作者用来衡量对象的明确标准',
            '对照办法': 'TODO: 如何把具体稿件或方案与该标准逐项对照',
            '归结办法': 'TODO: 满足与不满足标准时分别如何做出决定',
          },
        },
        reasons: ['TODO: 来自原作的论证依据或真实观察记录'],
        example: {
          summary: 'TODO: 具体示例案例标题',
          context: 'TODO: 案例发生的背景情境',
          input: 'TODO: 被审视的具体初稿或输入问题',
          application: 'TODO: 如何将该判断标准应用到这一输入上',
          result: 'TODO: 最终作出的修改或处置决定',
        },
      }],
    } : {
      format: FORMAT,
      asset: { id: 'my-distilled-works', type: 'domain', title: 'TODO: title of the distilled judgment work', summary: 'TODO: one sentence on the domain judgments distilled from authored materials', language: 'en', version: '0.1.0' },
      scope: 'TODO: the domain and audience covered by the source works, and what is excluded.',
      actors: [{ id: 'author', name: 'TODO: original author name', kind: 'person' }],
      highest_question: 'TODO: the central question answered across these works',
      boundaries: 'TODO: limits of the distilled work as a whole',
      judgments: [{
        id: 'work:first-criterion',
        focus: 'TODO: specific recurring question distilled from the author’s works',
        statement: 'TODO: the author’s explicit conclusion or standard',
        applies_when: 'TODO: concrete review or writing context where the author applies this standard',
        boundaries: 'TODO: explicit counter-condition or exception stated by the author',
        method: {
          term: 'criteria_comparison',
          roles: {
            criterion: 'TODO: the explicit criterion the author checks against',
            comparison_method: 'TODO: how a concrete work or draft is compared against that criterion',
            decision_rule: 'TODO: how passing vs failing that criterion settles the decision',
          },
        },
        reasons: ['TODO: authored rationale or concrete observation from the source work'],
        example: {
          summary: 'TODO: short title of a concrete example case',
          context: 'TODO: background situation of the case',
          input: 'TODO: specific draft or decision input examined',
          application: 'TODO: how this judgment was applied to that input',
          result: 'TODO: the resulting decision or revision disposition',
        },
      }],
    };
  }
  if (mode === 'research') {
    return zh ? {
      format: FORMAT,
      asset: { id: 'my-research-judgments', type: 'domain', title: 'TODO: 基于资料研究的判断作品标题', summary: 'TODO: 用一句话说明经多源证据对照后确立的领域立场', language: 'zh-CN', version: '0.1.0' },
      scope: 'TODO: 研究覆盖的准确领域、证据时效范围及排除在外的场景。',
      actors: [{ id: 'author', name: 'TODO: 采纳并承担这些判断立场的主体名称', kind: 'person' }],
      highest_question: 'TODO: 基于研究资料重点回答的核心领域问题',
      boundaries: 'TODO: 证据边界、法域限制或需要重新核证的触发条件',
      judgments: [{
        id: 'research:first-position',
        focus: 'TODO: 存在竞争性证据的具体技术或领域问题',
        statement: 'TODO: 权衡证据后明确采纳的立场结论',
        applies_when: 'TODO: 与支撑证据相匹配的具体运行或业务条件',
        boundaries: 'TODO: 证据缺失或反向条件出现时该立场不再成立的边界',
        method: {
          term: 'evidence_analysis',
          roles: {
            '所用材料': 'TODO: 审阅过的授权资料、基准测试或标准规范',
            '材料与判断的联系': 'TODO: 这些材料如何支撑所采纳的立场',
            '反向材料': 'TODO: 已审视过的相反证据或竞争方案表现',
            '材料取舍': 'TODO: 为何在声明范围内采纳当前立场而非替代方案',
          },
        },
      }],
    } : {
      format: FORMAT,
      asset: { id: 'my-research-judgments', type: 'domain', title: 'TODO: title of the evidence-backed judgment work', summary: 'TODO: one sentence on the domain decisions grounded in compared materials', language: 'en', version: '0.1.0' },
      scope: 'TODO: exact domain, evidence horizon, and contexts outside scope.',
      actors: [{ id: 'author', name: 'TODO: decision owner adopting these positions', kind: 'person' }],
      highest_question: 'TODO: the core domain question evaluated from the research materials',
      boundaries: 'TODO: evidence limits, jurisdiction boundaries, or conditions requiring fresh verification',
      judgments: [{
        id: 'research:first-position',
        focus: 'TODO: contested technical or domain question with competing evidence',
        statement: 'TODO: the adopted position chosen after weighing the evidence',
        applies_when: 'TODO: specific operating conditions matching the supporting evidence',
        boundaries: 'TODO: counter-conditions or missing-evidence cases where this position does not hold',
        method: {
          term: 'evidence_analysis',
          roles: {
            materials_used: 'TODO: the authorized evidence or standards examined',
            evidence_link: 'TODO: how those materials support the adopted position',
            contrary_evidence: 'TODO: competing or contrary evidence considered',
            weighing_rationale: 'TODO: why the adopted position was chosen under the stated scope',
          },
        },
      }],
    };
  }
  return zh ? {
    format: FORMAT,
    asset: { id: 'my-first-judgment', type: 'domain', title: 'TODO: 这份判断资产的标题', summary: 'TODO: 用一句话说明这份资产帮助做出什么决定', language: 'zh-CN', version: '0.1.0' },
    scope: 'TODO: 这份资产覆盖什么场景，以及不覆盖什么场景。',
    actors: [{ id: 'author', name: 'TODO: 作者或团队名称', kind: 'person' }],
    highest_question: 'TODO: 整份资产回答的核心问题',
    boundaries: 'TODO: 整份资产层面的适用边界（或设为 null）',
    judgments: [{
      id: 'main:first',
      focus: 'TODO: 第一条判断的简短议题标题',
      statement: 'TODO: 你本人认可并愿意署名负责的判断结论',
      applies_when: 'TODO: 这条判断适用的具体情境',
      boundaries: 'TODO: 这条判断停止适用的边界条件（或删除此字段）',
      method: 'feeling',
    }],
  } : {
    format: FORMAT,
    asset: { id: 'my-first-judgment', type: 'domain', title: 'TODO: a title for this asset', summary: 'TODO: one sentence on what this asset helps decide', language: 'en', version: '0.1.0' },
    scope: 'TODO: what this asset covers, and what it does not cover.',
    actors: [{ id: 'author', name: 'TODO: author or team name', kind: 'person' }],
    highest_question: 'TODO: the question this whole asset answers',
    boundaries: 'TODO: limits of the asset as a whole (or set to null)',
    judgments: [{
      id: 'main:first',
      focus: 'TODO: short title of the first judgment',
      statement: 'TODO: the conclusion you stand behind, in your own words',
      applies_when: 'TODO: the situation in which this judgment applies',
      boundaries: 'TODO: where this judgment stops applying (or remove this field)',
      method: 'feeling',
    }],
  };
}

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const isText = v => typeof v === 'string' && v.trim() !== '';
const todo = v => typeof v === 'string' && /^TODO\b/.test(v.trim());

function diag(field, code, message, hint) { return { field, code, message, hint }; }

function validateDraft(draft) {
  const out = [];
  const need = (field, v, what, example) => {
    if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
      out.push(diag(field, 'missing_field', `${field} is required but missing or empty.`, `Add ${what}${example ? `, e.g. ${example}` : ''}.`));
      return false;
    }
    if (todo(v)) out.push(diag(field, 'placeholder_not_replaced', `${field} still holds the scaffold TODO placeholder.`, `Replace it with ${what}.`));
    return true;
  };
  if (draft.format !== FORMAT) out.push(diag('format', 'bad_format', `format must be "${FORMAT}".`, `Set "format": "${FORMAT}".`));
  const a = draft.asset;
  if (!isObj(a)) out.push(diag('asset', 'missing_field', 'asset is required.', 'Add asset: {id,title,summary,language,version}.'));
  else {
    if (need('asset.id', a.id, 'a lowercase slug', '"team-update"') && typeof a.id === 'string' && !SLUG.test(a.id)) out.push(diag('asset.id', 'invalid_value', 'asset.id must be a lowercase slug (a-z, 0-9, . _ -).', 'Use e.g. "team-update".'));
    if (a.type !== undefined) {
      if (typeof a.type !== 'string' || !ASSET_TYPES.has(a.type)) out.push(diag('asset.type', 'invalid_value', `asset.type must be one of: ${[...ASSET_TYPES].join(', ')}.`, 'Use e.g. "domain" or "sample".'));
    }
    need('asset.title', a.title, 'a title');
    need('asset.summary', a.summary, 'a one-sentence summary');
    need('asset.language', a.language, 'a language tag', '"en"');
    if (need('asset.version', a.version, 'a semantic version', '"0.1.0"') && !/^\d+\.\d+\.\d+$/.test(a.version)) out.push(diag('asset.version', 'invalid_value', 'asset.version must be MAJOR.MINOR.PATCH.', 'Use e.g. "0.1.0".'));
    if (a.description !== undefined) {
      if (!isText(a.description)) out.push(diag('asset.description', 'invalid_value', 'asset.description must be a non-empty string.', 'Write a description or omit the field.'));
      else if (todo(a.description)) out.push(diag('asset.description', 'placeholder_not_replaced', 'asset.description still holds the scaffold TODO placeholder.', 'Replace it with the asset description, or omit the field.'));
    }
    if (a.keywords !== undefined) {
      if (!Array.isArray(a.keywords) || a.keywords.some(k => !isText(k))) out.push(diag('asset.keywords', 'invalid_value', 'asset.keywords must be an array of non-empty strings.', 'Use e.g. ["engineering", "review"].'));
      else a.keywords.forEach((k, idx) => { if (todo(k)) out.push(diag(`asset.keywords[${idx}]`, 'placeholder_not_replaced', `asset.keywords[${idx}] still holds a TODO placeholder.`, 'Replace it with a keyword.')); });
    }
    if (a.license !== undefined) {
      if (!isObj(a.license)) out.push(diag('asset.license', 'invalid_value', 'asset.license must be {identifier, uri?}.', 'Use e.g. {identifier:"CC-BY-4.0", uri:"https://creativecommons.org/licenses/by/4.0/"}.'));
      else {
        need('asset.license.identifier', a.license.identifier, 'a license identifier', '"CC-BY-4.0"');
        if (a.license.uri !== undefined) {
          if (!isText(a.license.uri)) out.push(diag('asset.license.uri', 'invalid_value', 'asset.license.uri must be a non-empty URI string.', 'Provide a valid URI or omit uri.'));
          else if (todo(a.license.uri)) out.push(diag('asset.license.uri', 'placeholder_not_replaced', 'asset.license.uri still holds a TODO placeholder.', 'Replace it with the license URI.'));
        }
        const allowedLicenseKeys = new Set(['identifier', 'uri']);
        for (const k of Object.keys(a.license)) if (!allowedLicenseKeys.has(k)) out.push(diag(`asset.license.${k}`, 'unknown_field', `Unknown asset.license field "${k}".`, 'Allowed: identifier, uri.'));
      }
    }
    const allowedAssetKeys = new Set(['id', 'type', 'title', 'summary', 'language', 'version', 'description', 'keywords', 'license']);
    for (const k of Object.keys(a)) if (!allowedAssetKeys.has(k)) out.push(diag(`asset.${k}`, 'unknown_field', `Unknown asset field "${k}".`, `Allowed: ${[...allowedAssetKeys].join(', ')}.`));
  }
  need('scope', draft.scope, 'a scope sentence');
  need('highest_question', draft.highest_question, 'the question this asset answers');
  if (draft.boundaries !== undefined && draft.boundaries !== null && !isText(draft.boundaries)) out.push(diag('boundaries', 'invalid_value', 'boundaries must be text or null.', 'Write the limits as one sentence, or set null.'));
  else if (todo(draft.boundaries)) out.push(diag('boundaries', 'placeholder_not_replaced', 'boundaries still holds the scaffold TODO placeholder.', 'Replace it with the limits, or set null.'));
  const actorIds = new Set();
  if (!Array.isArray(draft.actors) || !draft.actors.length) out.push(diag('actors', 'missing_field', 'actors needs at least one actor.', 'Add actors: [{id:"author",name:"Your name"}].'));
  else draft.actors.forEach((x, i) => {
    if (!isObj(x)) { out.push(diag(`actors[${i}]`, 'invalid_value', 'actor must be an object.', 'Use {id,name}.')); return; }
    need(`actors[${i}].id`, x.id, 'an actor id', '"author"'); need(`actors[${i}].name`, x.name, 'the actor name');
    if (isText(x.id)) { if (actorIds.has(x.id)) out.push(diag(`actors[${i}].id`, 'duplicate_id', `Duplicate actor id "${x.id}".`, 'Actor ids must be unique.')); actorIds.add(x.id); }
  });
  const table = roleTable();
  const allowedJudgmentDraftKeys = new Set(['id', 'focus', 'statement', 'applies_when', 'boundaries', 'method', 'answer_kind', 'reasons', 'example']);
  if (!Array.isArray(draft.judgments) || !draft.judgments.length) out.push(diag('judgments', 'missing_field', 'judgments needs at least one judgment.', 'Add judgments: [{id,focus,statement,applies_when}].'));
  else {
    const seen = new Set();
    draft.judgments.forEach((j, i) => {
      const p = `judgments[${i}]`;
      if (!isObj(j)) { out.push(diag(p, 'invalid_value', 'judgment must be an object.', 'Use {id,focus,statement,applies_when}.')); return; }
      if (need(`${p}.id`, j.id, 'a judgment id', '"main:first"')) { if (seen.has(j.id)) out.push(diag(`${p}.id`, 'duplicate_id', `Duplicate judgment id "${j.id}".`, 'Judgment ids must be unique.')); seen.add(j.id); }
      need(`${p}.focus`, j.focus, 'a short focus title');
      need(`${p}.statement`, j.statement, 'the authored conclusion');
      need(`${p}.applies_when`, j.applies_when, 'when this judgment applies');
      if (j.boundaries !== undefined && j.boundaries !== null && !isText(j.boundaries)) out.push(diag(`${p}.boundaries`, 'invalid_value', 'boundaries must be text or null.', 'Write one sentence, or remove the field.'));
      else if (todo(j.boundaries)) out.push(diag(`${p}.boundaries`, 'placeholder_not_replaced', 'boundaries still holds the scaffold TODO placeholder.', 'Replace it, or remove the field.'));
      const m = j.method === undefined ? 'feeling' : j.method;
      const term = typeof m === 'string' ? m : m?.term;
      const roles = table && typeof term === 'string' ? table.roles?.[term] : null;
      if (typeof term !== 'string' || (table && !roles)) out.push(diag(`${p}.method`, 'invalid_method', `Unknown method${typeof term === 'string' ? ` "${term}"` : ''}.`, table ? `Use one of: ${Object.keys(table.roles).join(', ')}.` : 'Use a Core method term.'));
      else if (typeof m === 'string' && term !== 'feeling') {
        const reqSnippet = roles.required.map(r => `"${englishAliasFor(term, r) ?? r}":"..."`).join(', ');
        out.push(diag(`${p}.method`, 'method_roles_required', `Method "${term}" needs its roles written out.`, `Use method: {term:"${term}", roles:{${reqSnippet}}}.`));
      } else if (isObj(m)) {
        const given = isObj(m.roles) ? m.roles : {};
        const { normalized, duplicates } = resolveDraftRoles(term, given);
        if (duplicates.length) {
          out.push(diag(`${p}.method.roles`, 'duplicate_method_roles',
            `Method "${term}" specifies the same role more than once: ${duplicates.map(d => `${d.role} (via ${d.keys.join(', ')})`).join('; ')}.`,
            DUPLICATE_ROLE_FIX_HINT));
        }
        const missing = roles.required.filter(r => !isText(normalized[r]));
        if (missing.length) {
          const missingLabels = missing.map(r => formatRoleLabel(term, r));
          const addSnippet = missing.map(r => `"${englishAliasFor(term, r) ?? r}":"..."`).join(', ');
          const optLabels = roles.optional.map(r => formatRoleLabel(term, r)).join(', ');
          out.push(diag(`${p}.method.roles`, 'method_roles_missing', `Method "${term}" is missing required roles: ${missingLabels.join(', ')}.`, `Add roles ${addSnippet}. Optional: ${optLabels}.`));
        }
        const allowedCanonical = new Set([...roles.required, ...roles.optional]);
        const aliases = ROLE_ALIASES_EN[term] ?? {};
        const unknown = Object.keys(given).filter(rk => !allowedCanonical.has(aliases[rk] ?? rk));
        if (unknown.length) {
          const allowedLabels = [...roles.required, ...roles.optional].map(r => formatRoleLabel(term, r)).join(', ');
          out.push(diag(`${p}.method.roles`, 'method_roles_unknown', `Method "${term}" has unknown roles: ${unknown.join(', ')}.`, `Allowed: ${allowedLabels}.`));
        }
        for (const [rk, rv] of Object.entries(given)) {
          if (todo(rv)) out.push(diag(`${p}.method.roles.${rk}`, 'placeholder_not_replaced', `${p}.method.roles.${rk} still holds the scaffold TODO placeholder.`, `Replace it with the authored "${rk}" statement.`));
        }
      }
      if (j.reasons !== undefined) {
        if (!Array.isArray(j.reasons) || j.reasons.some(r => !isText(r))) out.push(diag(`${p}.reasons`, 'invalid_value', `${p}.reasons must be an array of non-empty strings.`, 'Provide ["authored rationale"] or omit reasons.'));
        else j.reasons.forEach((r, rIdx) => { if (todo(r)) out.push(diag(`${p}.reasons[${rIdx}]`, 'placeholder_not_replaced', `${p}.reasons[${rIdx}] still holds a TODO placeholder.`, 'Replace it with an authored rationale or omit reasons.')); });
      }
      if (j.example !== undefined) {
        if (!isObj(j.example)) out.push(diag(`${p}.example`, 'invalid_value', `${p}.example must be {summary, context, input?, application, result}.`, 'Provide an example object or omit example.'));
        else {
          need(`${p}.example.summary`, j.example.summary, 'an example summary title');
          need(`${p}.example.context`, j.example.context, 'the example context');
          if (j.example.input !== undefined) {
            if (!isText(j.example.input)) out.push(diag(`${p}.example.input`, 'invalid_value', `${p}.example.input must be a non-empty string when provided.`, 'Write the input case or omit input.'));
            else if (todo(j.example.input)) out.push(diag(`${p}.example.input`, 'placeholder_not_replaced', `${p}.example.input still holds a TODO placeholder.`, 'Replace it with the input case or omit input.'));
          }
          need(`${p}.example.application`, j.example.application, 'how the judgment applies');
          need(`${p}.example.result`, j.example.result, 'the resulting disposition');
          const allowedExampleKeys = new Set(['summary', 'context', 'input', 'application', 'result']);
          for (const k of Object.keys(j.example)) if (!allowedExampleKeys.has(k)) out.push(diag(`${p}.example.${k}`, 'unknown_field', `Unknown example field "${k}".`, 'Allowed: summary, context, input, application, result.'));
        }
      }
      for (const k of Object.keys(j)) if (!allowedJudgmentDraftKeys.has(k)) out.push(diag(`${p}.${k}`, 'unknown_field', `Unknown judgment field "${k}".`, `Allowed: ${[...allowedJudgmentDraftKeys].join(', ')}.`));
    });
  }
  if (draft.timestamp !== undefined && !(typeof draft.timestamp === 'string' && ISO.test(draft.timestamp))) out.push(diag('timestamp', 'invalid_value', 'timestamp must be an ISO-8601 UTC string.', 'Use e.g. "2026-01-01T00:00:00Z".'));
  const known = new Set(['format', 'asset', 'scope', 'actors', 'highest_question', 'boundaries', 'judgments', 'timestamp']);
  for (const k of Object.keys(draft)) if (!known.has(k)) out.push(diag(k, 'unknown_field', `Unknown draft field "${k}".`, `Allowed: ${[...known].join(', ')}.`));
  return out;
}

const provided = text => (isText(text) && !todo(text) ? { state: 'provided', value: text } : { state: 'none', value: null });
// A boundary declaration is a list of complete Boundary objects, not text.
const boundary = (text, id, declaredBy, appliesTo) => (isText(text) && !todo(text)
  ? { state: 'provided', value: [{ id, effect: 'limit', statement: text, declared_by: declaredBy, applies_to: appliesTo, exception_refs: [] }] }
  : { state: 'none', value: null });
const nowZ = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

function compileDraft(draft) {
  if (!isObj(draft)) throw Object.assign(new Error('KDNA_DRAFT_INVALID'), { diagnostics: [diag('', 'not_an_object', 'Draft must be a JSON object.', 'Start from scaffoldDraft().')] });
  const problems = validateDraft(draft);
  if (problems.length) throw Object.assign(new Error('KDNA_DRAFT_INVALID'), { diagnostics: problems });
  const when = draft.timestamp || nowZ();
  const slug = draft.asset.id;
  const isChineseAsset = /^zh\b/i.test(String(draft.asset.language || ''));
  const defaultFeelingNote = isChineseAsset
    ? '这是作者声明的主观偏好与取向，不构成普适效果证明。'
    : 'This is the author’s stated preference, not evidence of a universal effect.';
  const table = roleTable();
  const actors = draft.actors.map(x => ({ id: `actor:${x.id}`, kind: x.kind || 'person', name: x.name }));
  const actorIds = actors.map(x => x.id);
  const reasons = [];
  const examples = [];
  const judgments = draft.judgments.map(j => {
    const m = j.method === undefined ? 'feeling' : j.method;
    const term = typeof m === 'string' ? m : m.term;
    const roleText = typeof m === 'string'
      ? { '个人感受': defaultFeelingNote }
      : resolveDraftRoles(term, m.roles ?? {}).normalized;
    const order = table ? [...table.roles[term].required, ...table.roles[term].optional] : Object.keys(roleText);
    const components = order.filter(r => isText(roleText[r])).map(r => ({
      id: `component:${j.id}:${r}`, method: { term }, role: r, material_refs: [], statement: roleText[r],
    }));
    const reasonRefs = [];
    if (Array.isArray(j.reasons)) {
      j.reasons.forEach((rText, idx) => {
        if (!isText(rText)) return;
        const rid = `reason:${j.id}:${idx + 1}`;
        reasonRefs.push(rid);
        reasons.push({
          id: rid,
          role: 'support',
          judgment_ref: j.id,
          statement: rText,
          component_refs: components.length ? [components[0].id] : [],
        });
      });
    }
    if (isObj(j.example)) {
      const ex = j.example;
      examples.push({
        id: `example:${j.id}`,
        title: ex.summary,
        kind: 'illustrative',
        context: isText(ex.input) ? `${ex.context}\nInput: ${ex.input}` : ex.context,
        input_refs: [],
        adopted_judgments: [{ kind: 'local', judgment_id: j.id }],
        application: ex.application,
        results: [{ id: `example-result:${j.id}`, kind: 'disposition', statement: ex.result }],
      });
    }
    const rc = `result-contract:${j.id}`;
    return {
      id: j.id,
      focus: j.focus,
      subject: { actor_ids: actorIds, statement: j.focus },
      scope: { statement: j.applies_when },
      answer_kind: j.answer_kind || 'preference',
      parent_ref: null,
      form: 'conclusion',
      core_expression: { kind: 'authored', statement: j.statement, qualification_refs: [] },
      method: { method: { term }, components, bindings: [] },
      material_refs: [],
      reason_refs: reasonRefs,
      content_uses: [],
      ports: [],
      inputs: [],
      boundaries: boundary(j.boundaries, `boundary:${j.id}`, actorIds[0], { kind: 'judgments', judgment_refs: [j.id] }),
      exceptions: { state: 'none', value: null },
      misuse: { state: 'none', value: null },
      extensions: [],
      result_contract: {
        id: rc,
        form: { term: 'scalar', vocabulary: 'core' },
        shape: { kind: 'scalar', scalar_type: 'text' },
        minimum: 1,
        maximum: 1,
        allowed_result_types: [{ term: 'text', vocabulary: 'core' }],
      },
      result: {
        contract_ref: rc,
        result_type: { term: 'text', vocabulary: 'core' },
        value: { kind: 'text', value: j.statement },
      },
    };
  });
  const version = draft.asset.version;
  const manifest = {
    asset_id: `asset:${slug}`,
    asset_uid: `uid:${slug}`,
    asset_type: draft.asset.type || 'domain',
    title: draft.asset.title,
    summary: draft.asset.summary,
    ...(isText(draft.asset.description) ? { description: draft.asset.description } : {}),
    ...(Array.isArray(draft.asset.keywords) ? { keywords: [...draft.asset.keywords] } : {}),
    languages: [draft.asset.language],
    lineage: [],
    history: { coverage: 'complete', statement: isChineseAsset ? '初始版本。' : 'Initial draft.', entries: [] },
    version,
    judgment_version: version,
    created_at: when,
    updated_at: when,
    compatibility: { min_loader_version: '0.36.0', profile: 'kdna.payload.judgment', profile_version: '0.5.1' },
    runtime: { mandatory_entries: [] },
    ...(isObj(draft.asset.license) ? { license: { identifier: draft.asset.license.identifier, ...(isText(draft.asset.license.uri) ? { uri: draft.asset.license.uri } : {}) } } : {}),
  };
  return {
    manifest,
    payload: {
      profile: 'kdna.payload.judgment',
      profile_version: '0.5.1',
      asset: { asset_id: `asset:${slug}`, asset_version: version, judgment_version: version },
      actors,
      scope: { statement: draft.scope },
      declarations: { highest_question: provided(draft.highest_question), boundaries: boundary(draft.boundaries, `boundary:${slug}`, actorIds[0], { kind: 'asset' }) },
      kernel: { purpose: { kind: 'summary' }, foundation_refs: [] },
      contracts: [],
      conditions: [],
      shared_declarations: [],
      materials: [],
      reasons,
      sources: [],
      source_uses: [],
      resources: [],
      relationships: [],
      dependencies: [],
      examples,
      exceptions: [],
      misuse: [],
      reading_order: judgments.map(j => j.id),
      extensions: [],
      judgments,
      asset_capability: 'asserted_answers',
    },
    members: [],
  };
}

const MANIFEST_REQUIRED_KEYS = ['asset_id', 'asset_uid', 'asset_type', 'title', 'version', 'judgment_version', 'created_at', 'updated_at', 'compatibility', 'runtime', 'summary', 'languages', 'history'];
const MANIFEST_OPTIONAL_KEYS = ['creator', 'content_digest', 'authoring', 'access', 'license', 'description', 'keywords', 'lineage'];
const MANIFEST_ALLOWED_KEYS = [...MANIFEST_REQUIRED_KEYS, ...MANIFEST_OPTIONAL_KEYS];

const PAYLOAD_REQUIRED_KEYS = ['profile', 'profile_version', 'asset', 'actors', 'scope', 'judgments', 'asset_capability', 'declarations', 'kernel', 'shared_declarations', 'materials', 'reasons', 'sources', 'source_uses', 'resources', 'relationships', 'dependencies', 'contracts', 'conditions', 'exceptions', 'misuse', 'examples'];
const PAYLOAD_OPTIONAL_KEYS = ['attributions', 'cohesion', 'content_risk', 'extensions', 'reading_order'];
const PAYLOAD_ALLOWED_KEYS = [...PAYLOAD_REQUIRED_KEYS, ...PAYLOAD_OPTIONAL_KEYS];

const COLLECTIONS = new Set(['actors', 'contracts', 'conditions', 'shared_declarations', 'materials', 'reasons', 'sources', 'source_uses', 'resources', 'relationships', 'dependencies', 'examples', 'exceptions', 'misuse', 'reading_order', 'extensions', 'judgments', 'attributions']);

const JUDGMENT_REQUIRED_KEYS = ['id', 'focus', 'subject', 'scope', 'form', 'answer_kind', 'core_expression', 'result_contract', 'method', 'material_refs', 'reason_refs', 'parent_ref', 'ports', 'inputs', 'content_uses'];
const JUDGMENT_OPTIONAL_KEYS = ['answer_other', 'answer_parts', 'boundaries', 'exceptions', 'extensions', 'lifecycle', 'misuse', 'result', 'formation_rule'];
const JUDGMENT_ALLOWED_KEYS = [...JUDGMENT_REQUIRED_KEYS, ...JUDGMENT_OPTIONAL_KEYS];

const SOURCE_EDITS_MANIFEST_EXTRA_KEYS = ['format_version', 'payload', 'representation_metadata', 'representation_origin'];

function checkVersionPairAlignment(manifest, payload) {
  const out = [];
  if (!isObj(manifest) || !isObj(payload) || !isObj(payload.asset)) return out;
  const mv = manifest.version, mjv = manifest.judgment_version;
  const av = payload.asset.asset_version, ajv = payload.asset.judgment_version;
  if (isText(mv) && isText(av) && mv !== av) {
    out.push(diag('/payload/asset/asset_version', 'version_mismatch',
      `Version mismatch between manifest.version ("${mv}") and payload.asset.asset_version ("${av}").`,
      'Update both manifest.version and payload.asset.asset_version to the same version string (and align manifest.judgment_version + payload.asset.judgment_version when judgments changed).'));
  }
  if (isText(mjv) && isText(ajv) && mjv !== ajv) {
    out.push(diag('/payload/asset/judgment_version', 'version_mismatch',
      `Version mismatch between manifest.judgment_version ("${mjv}") and payload.asset.judgment_version ("${ajv}").`,
      'Update both manifest.judgment_version and payload.asset.judgment_version to the same version string (typically matching manifest.version and payload.asset.asset_version).'));
  }
  if (isText(mv) && isText(av) && isText(mjv) && isText(ajv) && mv === av && mjv === ajv && mv !== mjv) {
    // Valid in Core when only container metadata changed, surfaced only by computeAdvisories when judgments changed.
  }
  if (isObj(manifest.asset_id !== undefined ? { id: manifest.asset_id } : null) && isText(manifest.asset_id) && isText(payload.asset.asset_id) && manifest.asset_id !== payload.asset.asset_id) {
    out.push(diag('/payload/asset/asset_id', 'asset_id_mismatch',
      `Asset ID mismatch between manifest.asset_id ("${manifest.asset_id}") and payload.asset.asset_id ("${payload.asset.asset_id}").`,
      'Keep manifest.asset_id and payload.asset.asset_id identical.'));
  }
  return out;
}

function validateFull(input, { sourceEdits = false } = {}) {
  const out = [];
  if (!isObj(input)) return [diag('', 'not_an_object', 'Input must be a JSON object.', sourceEdits ? 'Provide {manifest,payload}.' : 'Provide {manifest,payload,members}.')];
  const topKeys = sourceEdits ? ['manifest', 'payload'] : ['manifest', 'payload', 'members'];
  for (const k of topKeys) if (input[k] === undefined) out.push(diag(`/${k}`, 'missing_field', `/${k} is required.`, k === 'members' ? 'Add "members": [].' : `Add /${k}; run \`kdna init\` and compile a draft for a complete one.`));
  for (const k of Object.keys(input)) if (!topKeys.includes(k)) out.push(diag(`/${k}`, 'unknown_field', `Unknown top-level field "${k}".`, sourceEdits ? 'Only manifest and payload are accepted in source-pack edits.' : 'Only manifest, payload, members are accepted.'));
  const keyset = (value, requiredKeys, allowedKeys, base, hintFor) => {
    if (!isObj(value)) { if (value !== undefined) out.push(diag(base, 'invalid_value', `${base} must be an object.`, '')); return false; }
    for (const k of requiredKeys) if (!Object.hasOwn(value, k)) out.push(diag(`${base}/${k}`, 'missing_field', `${base}/${k} is required.`, hintFor(k)));
    for (const k of Object.keys(value)) if (!allowedKeys.includes(k)) out.push(diag(`${base}/${k}`, 'unknown_field', `${base}/${k} is not an allowed field.`, `Allowed: ${allowedKeys.join(', ')}.`));
    return true;
  };
  const manifestAllowed = sourceEdits ? [...MANIFEST_ALLOWED_KEYS, ...SOURCE_EDITS_MANIFEST_EXTRA_KEYS] : MANIFEST_ALLOWED_KEYS;
  keyset(input.manifest, MANIFEST_REQUIRED_KEYS, manifestAllowed, '/manifest', k => `Add ${k} to the manifest.`);
  out.push(...checkVersionPairAlignment(input.manifest, input.payload));
  if (keyset(input.payload, PAYLOAD_REQUIRED_KEYS, PAYLOAD_ALLOWED_KEYS, '/payload', k => (COLLECTIONS.has(k) ? `Add "${k}": [] when it has no entries.` : `Add ${k} to the payload.`))) {
    const table = roleTable();
    if (Array.isArray(input.payload.judgments)) {
      if (!input.payload.judgments.length) out.push(diag('/payload/judgments', 'missing_field', '/payload/judgments needs at least one judgment.', 'Add one judgment.'));
      input.payload.judgments.forEach((j, i) => {
        const base = `/payload/judgments/${i}`;
        if (!keyset(j, JUDGMENT_REQUIRED_KEYS, JUDGMENT_ALLOWED_KEYS, base, k => `Add ${k} to this judgment.`)) return;
        if (j.form === 'rule') {
          if (!Object.hasOwn(j, 'formation_rule')) out.push(diag(`${base}/formation_rule`, 'missing_field', `${base}/formation_rule is required when form is "rule".`, 'Add formation_rule to this rule judgment.'));
          if (Object.hasOwn(j, 'result')) out.push(diag(`${base}/result`, 'invalid_value', `${base}/result is not allowed when form is "rule".`, 'Remove result from rule judgments; use formation_rule instead.'));
        } else if (j.form === 'conclusion') {
          if (!Object.hasOwn(j, 'result')) out.push(diag(`${base}/result`, 'missing_field', `${base}/result is required when form is "conclusion".`, 'Add result to this conclusion judgment.'));
          if (Object.hasOwn(j, 'formation_rule')) out.push(diag(`${base}/formation_rule`, 'invalid_value', `${base}/formation_rule is not allowed when form is "conclusion".`, 'Remove formation_rule from conclusion judgments; use result instead.'));
        }
        const compCheck = inspectMethodComponents(j, table);
        if (compCheck) {
          if (compCheck.duplicate_roles.length) {
            out.push({
              ...diag(`${base}/method/components`, 'duplicate_method_roles',
                `Method "${compCheck.term}" repeats role(s): ${compCheck.duplicate_roles.map(d => `${d.role} (${d.component_ids.join(', ')})`).join('; ')}.`,
                DUPLICATE_ROLE_FIX_HINT),
              duplicate_roles: compCheck.duplicate_roles,
              invalid_roles: compCheck.invalid_roles,
              missing_required_roles: compCheck.missing_required_roles,
              fix_hint: DUPLICATE_ROLE_FIX_HINT,
            });
          }
          if (compCheck.invalid_roles.length) {
            out.push({
              ...diag(`${base}/method/components`, 'invalid_method_roles',
                `Method "${compCheck.term}" has role(s) outside its vocabulary: ${compCheck.invalid_roles.join(', ')}.`,
                `Allowed roles for "${compCheck.term}": ${[...compCheck.expected, ...compCheck.optional].join(', ')}.`),
              duplicate_roles: compCheck.duplicate_roles,
              invalid_roles: compCheck.invalid_roles,
              missing_required_roles: compCheck.missing_required_roles,
            });
          }
          if (compCheck.missing_required_roles.length) {
            out.push({
              ...diag(`${base}/method/components`, 'missing_method_roles',
                `Method "${compCheck.term}" is missing required role(s): ${compCheck.missing_required_roles.join(', ')}.`,
                `Required roles for "${compCheck.term}": ${compCheck.expected.join(', ')}.`),
              duplicate_roles: compCheck.duplicate_roles,
              invalid_roles: compCheck.invalid_roles,
              missing_required_roles: compCheck.missing_required_roles,
            });
          }
        }
      });
    } else if (input.payload.judgments !== undefined) out.push(diag('/payload/judgments', 'invalid_value', '/payload/judgments must be an array.', ''));
  }
  if (input.members !== undefined && !Array.isArray(input.members)) out.push(diag('/members', 'invalid_value', '/members must be an array.', 'Use "members": [].'));
  return out;
}

function normalizeFocusText(text) {
  return String(text || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function isProvidedDeclaration(decl) {
  return isObj(decl) && decl.state === 'provided' && decl.value !== null && decl.value !== undefined && (!Array.isArray(decl.value) || decl.value.length > 0);
}

function isCatchAllScope(text) {
  const trimmed = String(text || '').trim();
  return trimmed.length < 8 || CATCH_ALL_SCOPES.has(trimmed.toLowerCase());
}

// Structural, MP4-compliant craft advisories. Never computes a numerical score,
// never evaluates substantive truth/ideology, and never alters validity.
function computeAdvisories(input, isDraft) {
  const advisories = [];
  if (!isObj(input)) return advisories;
  if (isDraft) {
    const judgments = Array.isArray(input.judgments) ? input.judgments : [];
    const hasGlobalGuard = isText(input.boundaries);
    const focusMap = new Map();
    let omittedMethodCount = 0;
    judgments.forEach((j, i) => {
      if (!isObj(j)) return;
      const p = `judgments[${i}]`;
      const focus = isText(j.focus) ? j.focus.trim() : '';
      const stmt = isText(j.statement) ? j.statement.trim() : '';
      if (focus && stmt && focus === stmt) {
        advisories.push({ code: 'tautological_statement', path: `${p}.statement`, message: 'statement verbatim repeats focus; state the concrete decision or conclusion instead of repeating the question.' });
      }
      if (isObj(j.method) && isObj(j.method.roles) && stmt) {
        for (const [rk, rv] of Object.entries(j.method.roles)) {
          if (isText(rv) && rv.trim() === stmt) {
            advisories.push({ code: 'method_repeats_statement', path: `${p}.method.roles.${rk}`, message: `method role "${rk}" verbatim repeats statement; explain how the judgment was formed rather than restating the conclusion.` });
            break;
          }
        }
      }
      if (!isText(j.boundaries) && !hasGlobalGuard) {
        advisories.push({ code: 'unbounded_judgment', path: `${p}.boundaries`, message: 'neither this judgment nor the asset declares boundaries; consider stating where this judgment stops applying so Agents do not over-apply it.' });
      }
      if (isText(j.applies_when) && isCatchAllScope(j.applies_when)) {
        advisories.push({ code: 'overbroad_scope', path: `${p}.applies_when`, message: 'applies_when is very short or catch-all; name concrete task conditions so Agents can filter irrelevant judgments.' });
      }
      if (focus) {
        const norm = normalizeFocusText(focus);
        if (!focusMap.has(norm)) focusMap.set(norm, []);
        focusMap.get(norm).push({ index: i, path: `${p}.focus` });
      }
      if (j.method === undefined) omittedMethodCount += 1;
    });
    for (const entries of focusMap.values()) {
      if (entries.length > 1) {
        advisories.push({ code: 'duplicate_focus', path: entries[1].path, message: `judgments at ${entries.map(e => e.path).join(' and ')} ask the same focus question; split distinct sub-questions or merge them.` });
      }
    }
    if (omittedMethodCount >= 3) {
      advisories.push({ code: 'uniform_default_method', path: 'judgments', message: `${omittedMethodCount} judgments omit method (defaulting to "feeling"); consider declaring tradeoff, criteria_comparison, observation, experience, or evidence_analysis where explicit reasoning exists.` });
    }
    return advisories;
  }
  const payload = isObj(input.payload) ? input.payload : {};
  const judgments = Array.isArray(payload.judgments) ? payload.judgments : [];
  const hasGlobalGuard = isProvidedDeclaration(payload.declarations?.boundaries)
    || (Array.isArray(payload.conditions) && payload.conditions.length > 0)
    || (Array.isArray(payload.exceptions) && payload.exceptions.length > 0);
  const focusMap = new Map();
  judgments.forEach((j, i) => {
    if (!isObj(j)) return;
    const p = `/payload/judgments/${i}`;
    const focus = isText(j.focus) ? j.focus.trim() : '';
    const stmt = isText(j.core_expression?.statement) ? j.core_expression.statement.trim() : '';
    if (focus && stmt && focus === stmt) {
      advisories.push({ code: 'tautological_statement', path: `${p}/core_expression/statement`, message: 'core_expression.statement verbatim repeats focus; state the concrete conclusion instead of repeating the question.' });
    }
    if (Array.isArray(j.method?.components) && stmt) {
      for (let cIdx = 0; cIdx < j.method.components.length; cIdx++) {
        const comp = j.method.components[cIdx];
        if (isText(comp?.statement) && comp.statement.trim() === stmt) {
          advisories.push({ code: 'method_repeats_statement', path: `${p}/method/components/${cIdx}/statement`, message: `method component "${comp.role ?? cIdx}" verbatim repeats core_expression.statement; explain how the judgment was formed rather than restating the conclusion.` });
          break;
        }
      }
    }
    if (!isProvidedDeclaration(j.boundaries) && !isProvidedDeclaration(j.exceptions) && !hasGlobalGuard) {
      advisories.push({ code: 'unbounded_judgment', path: `${p}/boundaries`, message: 'judgment declares no boundaries or exceptions and the asset declares no global boundaries/conditions/exceptions; consider stating where it stops applying.' });
    }
    const scopeStmt = j.scope?.statement;
    if (isText(scopeStmt) && isCatchAllScope(scopeStmt)) {
      advisories.push({ code: 'overbroad_scope', path: `${p}/scope/statement`, message: 'scope.statement is very short or catch-all; name concrete applicability conditions so Agents can filter irrelevant judgments.' });
    }
    if (focus) {
      const norm = normalizeFocusText(focus);
      if (!focusMap.has(norm)) focusMap.set(norm, []);
      focusMap.get(norm).push({ index: i, path: `${p}/focus` });
    }
    if (j.form === 'conclusion' && j.result?.value?.kind === 'text' && isText(j.result.value.value) && stmt && j.result.value.value.trim() !== stmt) {
      advisories.push({ code: 'conclusion_result_diverges', path: `${p}/result/value/value`, message: 'result.value.value differs from core_expression.statement on this conclusion judgment; update both fields together unless the scalar result intentionally differs from the prose conclusion.' });
    }
  });
  for (const entries of focusMap.values()) {
    if (entries.length > 1) {
      advisories.push({ code: 'duplicate_focus', path: entries[1].path, message: `judgments at ${entries.map(e => e.path).join(' and ')} ask the same focus question; split distinct sub-questions or merge them.` });
    }
  }
  return advisories;
}

function isSourceEditsShape(input) {
  return isObj(input)
    && input.members === undefined
    && isObj(input.manifest)
    && isObj(input.payload)
    && SOURCE_EDITS_MANIFEST_EXTRA_KEYS.some(k => Object.hasOwn(input.manifest, k));
}

function validateInput(input, options = {}) {
  if (isObj(input) && input.status === 'source_opened' && isObj(input.edits)) {
    return {
      status: 'invalid',
      diagnostics: [diag('/', 'source_open_envelope', 'Input is a `kdna source-open` outer envelope rather than an edits or authored input document.', 'Extract `.edits` first (for example: `jq .edits opened.json > edits.json`).')],
    };
  }
  const sourceEdits = options.sourceEdits === true || isSourceEditsShape(input);
  const draft = !sourceEdits && isObj(input) && (input.format !== undefined || (input.manifest === undefined && input.payload === undefined));
  const diagnostics = draft ? validateDraft(isObj(input) ? input : {}) : validateFull(input, { sourceEdits });
  if (draft && !isObj(input)) diagnostics.unshift(diag('', 'not_an_object', 'Draft must be a JSON object.', 'Start from scaffoldDraft().'));
  if (diagnostics.length) return { status: 'invalid', diagnostics };
  const judgment_count = draft ? input.judgments.length : input.payload.judgments.length;
  return {
    status: 'valid',
    input_kind: draft ? 'draft' : (sourceEdits ? 'source_edits' : 'authored'),
    judgment_count,
    diagnostics: [],
    advisories: computeAdvisories(input, draft),
  };
}

// Ask Core itself (the authority) and translate a rejection into the same
// diagnostic shape. A draft is compiled first; compile problems come back as-is.
async function validateWithCore(input) {
  const local = validateInput(input);
  if (local.status === 'invalid') return local;
  if (local.input_kind === 'source_edits') {
    if (Array.isArray(input.payload?.resources) && input.payload.resources.length > 0) return local;
    const cleanManifest = { ...input.manifest };
    for (const k of SOURCE_EDITS_MANIFEST_EXTRA_KEYS) delete cleanManifest[k];
    input = { manifest: cleanManifest, payload: input.payload, members: [] };
  }
  const full = isObj(input) && input.format === FORMAT ? compileDraft(input) : input;
  const { admitNativeCreationRequest, createNativeCreationAuthority, createSectionAssetNode } = require('@aikdna/kdna-core/creation-sections-node');
  const binding = require('../public-contract-binding.json');
  const request = admitNativeCreationRequest({ request_id: 'draft:' + randomUUID(), tuple: binding.tuple, operation: 'create_public_asset', timeout_ms: 60000 });
  if (request.status !== 'admitted_request') return { status: 'invalid', diagnostics: [diag('', 'core_request_rejected', 'Core refused the creation request.', 'Check the installed @aikdna/kdna-core matches this CLI.')] };
  const produced = await createSectionAssetNode(full, request.request, createNativeCreationAuthority(() => true));
  if (produced.status === 'produced') return local;
  const raw = Array.isArray(produced?.core?.diagnostics) ? produced.core.diagnostics : [];
  const table = roleTable();
  const judgments = Array.isArray(full?.payload?.judgments) ? full.payload.judgments : [];
  const diagnostics = raw.map(d => {
    const field = typeof d?.field === 'string' ? d.field : '';
    const compMatch = /^\/payload\/judgments\/(\d+)\/method\/components$/.exec(field);
    if (compMatch) {
      const compCheck = inspectMethodComponents(judgments[Number(compMatch[1])], table);
      if (compCheck && compCheck.duplicate_roles.length) {
        return {
          ...diag(field, String(d?.code || d?.reason || produced.code || 'core_rejected'),
            `Core rejected ${field} (${d?.code || 'READ_CORE_INVALID'}): duplicate role(s) ${compCheck.duplicate_roles.map(x => x.role).join(', ')}.`,
            DUPLICATE_ROLE_FIX_HINT),
          duplicate_roles: compCheck.duplicate_roles,
          invalid_roles: compCheck.invalid_roles,
          missing_required_roles: compCheck.missing_required_roles,
          fix_hint: DUPLICATE_ROLE_FIX_HINT,
        };
      }
    }
    return diag(field, String(d?.code || d?.reason || produced.code || 'core_rejected'), `Core rejected ${field || 'the input'}${d?.code ? ` (${d.code})` : ''}.`, 'Compare this field with docs/authoring-field-reference.md.');
  });
  if (!diagnostics.length) diagnostics.push(diag('', String(produced.code || produced.status || 'core_rejected'), 'Core rejected the input.', 'Compare the input with docs/authoring-field-reference.md.'));
  return { status: 'invalid', diagnostics };
}

module.exports = {
  FORMAT,
  INIT_MODES,
  INIT_LANGS,
  ROLE_ALIASES_EN,
  DUPLICATE_ROLE_FIX_HINT,
  englishAliasFor,
  checkVersionPairAlignment,
  inspectMethodComponents,
  scaffoldDraft,
  compileDraft,
  validateInput,
  validateWithCore,
};
