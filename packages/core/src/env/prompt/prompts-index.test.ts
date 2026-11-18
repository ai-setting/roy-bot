import { describe, it, expect } from 'vitest';
import {
  builtInPrompts,
  getBuiltInPrompt,
  getBuiltInPromptNames,
  renderDefaultPrompt,
} from './prompts-index';

describe('builtInPrompts registry integrity (Task #2164 fallback session)', () => {
  it('should include json-extract as a built-in prompt (sed over-match regression guard)', () => {
    // json-extract is REQUIRED by workflow-json-output-plugin:
    //   agentComponent.run('json-extract', '', { extraTools: [workflow_submit_output] })
    // Without this entry, the plugin cannot load the sub-agent prompt,
    // which historically caused empty output → tdd-implement FAIL.
    expect(getBuiltInPromptNames()).toContain('json-extract');
  });

  it('should expose workflow_submit_output guidance in json-extract prompt', () => {
    const prompt = getBuiltInPrompt('json-extract');
    expect(prompt).toBeDefined();
    expect(prompt).toContain('workflow_submit_output');
    expect(prompt).toContain('JSON');
  });

  it('should NOT contain workflow-agent as a built-in prompt (legacy removed by refactor)', () => {
    // workflow-agent was removed in Task #2164 (workflow-runner sub-agent refactor).
    // Its old yaml aliases are now rewritten to workflow-runner in
    // resolveEntryAgent() / handleBackgroundTask(). A re-introduction here
    // would silently bring back the primary-mediator routing layer.
    expect(getBuiltInPromptNames()).not.toContain('workflow-agent');
  });

  it('should expose workflow-extract built-in prompt (task completion → workflow generation)', () => {
    // workflow-extract is REQUIRED by task-tag-plugin at task:operation:after.create (completed).
    expect(getBuiltInPromptNames()).toContain('workflow-extract');
    const prompt = getBuiltInPrompt('workflow-extract');
    expect(prompt).toContain('workflow_validate');
  });

  it('should expose workflow-runner built-in prompt (refactor target)', () => {
    // workflow-runner is the sub-agent created by Task #2164.
    expect(getBuiltInPromptNames()).toContain('workflow-runner');
    const prompt = getBuiltInPrompt('workflow-runner');
    expect(prompt).toContain('workflow_run');
  });

  it('should expose workflow-creator built-in prompt (interactive workflow builder — Task #2194)', () => {
    // workflow-creator is the multi-turn interactive workflow construction sub-agent.
    // Created by Task #2194 as a peer of workflow-runner / workflow-extract.
    expect(getBuiltInPromptNames()).toContain('workflow-creator');
    const prompt = getBuiltInPrompt('workflow-creator');
    expect(prompt).toBeDefined();
    // Must reference its key tools
    expect(prompt).toContain('workflow_validate');
    expect(prompt).toContain('workflow_add');
    expect(prompt).toContain('workflow_tag_list');
  });

  it('should keep default prompt and render with {{agent_name}}', () => {
    expect(getBuiltInPromptNames()).toContain('default');
    expect(getBuiltInPrompt('default')).toContain('{{agent_name}}');
    const rendered = renderDefaultPrompt('Roy');
    expect(rendered).not.toContain('{{agent_name}}');
    expect(rendered).toContain('Roy');
  });

  it('default prompt mentions workflow-creator in sub-agent strategy (Task #2194)', () => {
    // The default receptionist agent must know about workflow-creator so it can
    // delegate user requests like "帮我建一个 workflow" to the right sub-agent.
    const rendered = renderDefaultPrompt('Roy');
    expect(rendered).toContain('workflow-creator');
    // Should also be referenced in 选择智能体 step and 行为规则
    expect(rendered).toMatch(/workflow-creator.*用户主动构建|用户主动构建.*workflow-creator/);
  });

  it('default prompt mentions Reuse Candidates auto-injection (Task #2389)', () => {
    // The default receptionist must tell its callers that delegate_task
    // automatically surfaces recent tasks as reuse candidates, and that
    // candidates are *suggestions* (not mandatory merges).
    const rendered = renderDefaultPrompt('Roy');
    expect(rendered).toContain('Reuse Candidates');
    expect(rendered).toContain('TaskCreationRegistry');
    // Should explicitly tell the sub-agent to prefer task_update over task_create
    expect(rendered).toMatch(/task_update.*reopen|reopen.*task_update|task_update.*completed/);
    // Should not over-promise — must include the "suggestion" qualifier
    expect(rendered).toMatch(/suggestion|candidate/);
  });

  it('default prompt surfaces the three legal reuse paths (Task #2395)', () => {
    // Task #2395 follow-up: the default agent's "Reuse Candidates auto-injected"
    // hint must call out that the sub-agent has three legal paths
    // (continuation / child / new root), not just reopen. It must also
    // promise that the injected section shows parent / children / subtree
    // summary / project / branch / worktree so the sub-agent can decide.
    const rendered = renderDefaultPrompt('Roy');

    // Three-path labels must all appear
    expect(rendered).toContain('Path A');
    expect(rendered).toContain('Path B');
    expect(rendered).toContain('Path C');
    expect(rendered).toMatch(/Continuation.*reopen|reopen.*Continuation/);
    expect(rendered).toMatch(/Child task/);
    expect(rendered).toMatch(/New root/);

    // Path B must explicitly teach task_create(parent_task_id=...)
    expect(rendered).toMatch(/task_create\(parent_task_id=/);

    // The injected section must promise parent / children / subtree / project / branch / worktree
    expect(rendered).toContain('parent');
    expect(rendered).toContain('children');
    expect(rendered).toContain('subtree');
    expect(rendered).toContain('project');
    expect(rendered).toContain('branch');
    expect(rendered).toContain('worktree');

    // Empty-reuse + suggestion qualifier must remain (backward compat with Task #2389 hint)
    expect(rendered).toMatch(/suggestion/i);
    expect(rendered).toMatch(/Empty reuse|empty reuse/i);

    // Path B/C must require an audit operation
    expect(rendered).toMatch(/task_operation_create/);
  });

  it('should expose builtInPrompts as a stable object with consistent shape', () => {
    // Snapshot-style sanity: ensure every registered prompt returns a non-empty string.
    for (const name of getBuiltInPromptNames()) {
      expect(typeof builtInPrompts[name as keyof typeof builtInPrompts]).toBe('string');
      expect((builtInPrompts[name as keyof typeof builtInPrompts] as string).length).toBeGreaterThan(0);
    }
  });

  // ============================================================================
  // task-organizer (Task #2348) — longterm-root convergence prompt
  // ============================================================================
  describe('task-organizer (Task #2348 — optimize longterm-root convergence)', () => {
    it('must be registered as a built-in prompt', () => {
      // The built-in default for the task-organizer sub-agent must live in the
      // repo (will be overridden at runtime by ~/.local/share/roy-bot/prompts/task-organizer.md
      // if present, but the bundled default must still ship the optimization rules).
      expect(getBuiltInPromptNames()).toContain('task-organizer');
      const prompt = getBuiltInPrompt('task-organizer');
      expect(prompt).toBeDefined();
      expect(prompt!.length).toBeGreaterThan(500);
    });

    it('must declare the root-task convergence target (10-20) and longterm-only-root rule', () => {
      const prompt = getBuiltInPrompt('task-organizer')!;
      // Sweet spot: 10-20 个根任务
      expect(prompt).toMatch(/10-20|10\s*[-–]\s*20/);
      // 根任务应当 100% 为 longterm
      expect(prompt).toMatch(/longterm/i);
      // 必须明确"根任务"概念
      expect(prompt).toMatch(/根任务/);
    });

    it('must prescribe reparenting non-longterm roots to longterm parents', () => {
      const prompt = getBuiltInPrompt('task-organizer')!;
      // 关键操作：re-parent / 重新挂载
      expect(prompt).toMatch(/re-?parent|重新挂载/);
      // 必须用 task_update 改 parent_task_id
      expect(prompt).toContain('parent_task_id');
      // 必须显式提到把 normal/cycle 根任务挂到 longterm 下
      expect(prompt).toMatch(/normal.*longterm|longterm.*normal/);
    });

    it('must describe the --depth parameter and task_tree multi-granular view', () => {
      const prompt = getBuiltInPrompt('task-organizer')!;
      // 关键观察工具 task_tree
      expect(prompt).toContain('task_tree');
      // 必须有 --depth / depth= 的用法说明
      expect(prompt).toMatch(/--?depth/);
      // 必须强调多颗粒度观察
      expect(prompt).toMatch(/多颗粒度|多粒度/);
    });

    it('must include the working tool set (task_list / task_get / task_update / task_batch_archive / task_batch_delete)', () => {
      const prompt = getBuiltInPrompt('task-organizer')!;
      expect(prompt).toContain('task_list');
      expect(prompt).toContain('task_get');
      expect(prompt).toContain('task_update');
      expect(prompt).toContain('task_batch_archive');
      expect(prompt).toContain('task_batch_delete');
    });

    it('must forbid creating new root tasks and forbid modifying longterm semantics', () => {
      const prompt = getBuiltInPrompt('task-organizer')!;
      // 不主动创建新根任务
      expect(prompt).toMatch(/不要.*新建.*根|不要.*创建.*根|禁止.*创建.*根/);
      // 不修改 longterm 根任务语义
      expect(prompt).toMatch(/不要.*longterm|不修改.*longterm/);
    });

    it('must allow reparenting into longterm-root descendants (any depth) — Task #2348 follow-up', () => {
      // 用户 review 后纠正：attach 目标不一定是 longterm 根，
      // 也可以是 longterm 根下的子/孙任务（语义最匹配的有意义祖先）。
      const prompt = getBuiltInPrompt('task-organizer')!;

      // ✅ 显式提到"子/孙任务"是合法 attach 目标
      expect(prompt).toMatch(/子\s*\/\s*孙任务|子或孙任务|任意深度/);

      // ✅ 强调"挂得深但语义匹配"是合法策略
      expect(prompt).toMatch(/挂得.*深|挂.*深.*匹配|深层|深度挂载/);

      // ✅ 用 task_tree --depth 找深层 attach 目标
      expect(prompt).toMatch(/task_tree.*--?depth.*3|task_tree.*depth.*3/);

      // ✅ attach 目标**不一定是 longterm 根**
      expect(prompt).toMatch(/不一定是.*longterm|不一定.*longterm.*根/);
    });

    it('must include the "avoid child overload" principle with a threshold — Task #2348 follow-up', () => {
      // 挂载前要避免单父过载，超过 20 个时优先往下一层孙任务挂
      const prompt = getBuiltInPrompt('task-organizer')!;
      expect(prompt).toMatch(/子任务过载|过载/);
      expect(prompt).toMatch(/20/);
      expect(prompt).toMatch(/超过.*20|超过\s*20/);
    });

    // ============================================================================
    // task-organizer v2 — longterm 基准 + 4 路径 + 金字塔 (Task #2348 + #4091)
    // ============================================================================
    it('v2 must establish longterm roots as the reparent baseline (Phase 0)', () => {
      const prompt = getBuiltInPrompt('task-organizer')!;
      // Phase 0 标题
      expect(prompt).toMatch(/Phase 0|阶段 0|基准/);
      // 长term 锚点概念
      expect(prompt).toMatch(/longterm.*锚点|锚点.*longterm/);
      // 用 task_list({type:"longterm"}) 拿锚点清单
      expect(prompt).toMatch(/task_list.*type.*longterm|type.*longterm.*limit/);
      // 明确"长term 永远保留为根"铁律 ③
      expect(prompt).toMatch(/长\s*term.*保留为根|longterm.*保留为根/);
    });

    it('v2 must expose the 4-path decision tree (a/b/c/d) for non-longterm roots', () => {
      const prompt = getBuiltInPrompt('task-organizer')!;
      // 4 路径标题
      expect(prompt).toMatch(/4\s*路径|四路径|路径\s*分类/);
      // 路径 (a) 保持根
      expect(prompt).toMatch(/路径\s*a|路径\(a\)|\(a\)/);
      // 路径 (b) 升级 longterm
      expect(prompt).toMatch(/路径\s*b|路径\(b\)|\(b\)/);
      // 路径 (c) reparent to longterm
      expect(prompt).toMatch(/路径\s*c|路径\(c\)|\(c\)/);
      // 路径 (d) reparent to 子/孙任务
      expect(prompt).toMatch(/路径\s*d|路径\(d\)|\(d\)/);
      // 必须解释路径 (a) 是找不到合适父的默认保守路径
      expect(prompt).toMatch(/默认路径|默认.*\(a\)|保守/);
    });

    it('v2 must define the pyramid-shaped health standard (L0 ≤ 20, L1 ≤ 400, L2 ≤ 8000, fanout ≈ 20)', () => {
      const prompt = getBuiltInPrompt('task-organizer')!;
      // 金字塔形 + fanout 概念
      expect(prompt).toMatch(/金字塔/);
      expect(prompt).toMatch(/fanout/);
      // 三层硬指标 L0/L1/L2
      expect(prompt).toMatch(/L0/);
      expect(prompt).toMatch(/L1/);
      expect(prompt).toMatch(/L2/);
      // L0 ≤ 20 / L1 ≤ 400 / L2 ≤ 8000
      expect(prompt).toMatch(/L0.*≤\s*20|L0\s*≤\s*20/);
      expect(prompt).toMatch(/L1.*400/);
      expect(prompt).toMatch(/L2.*8000/);
      // 健康度评估函数
      expect(prompt).toMatch(/health_score|健康度/);
    });

    it('v2 must enforce the 0-delete / 0-archive-default iron rule', () => {
      const prompt = getBuiltInPrompt('task-organizer')!;
      // 0 删任务 — 禁用 task_batch_delete / task_delete
      expect(prompt).toMatch(/0\s*删|绝对\s*0\s*删|0\s*删任务/);
      // 0 归档默认 — 禁用 task_batch_archive 除非用户授权
      expect(prompt).toMatch(/0\s*归档|0\s*归档默认|不调用.*task_batch_archive/);
      // 明确"仅当用户明确授权时才归档"
      expect(prompt).toMatch(/用户.*明确.*授权|用户.*授权/);
      // 禁用 task_batch_delete / task_delete 在铁律或禁止操作里
      expect(prompt).toMatch(/不调用.*task_batch_delete|task_delete.*禁用|禁用.*task_delete/);
    });

    it('v2 must include the self-task creation template (Phase 0 之前建立 #NNNN 跟踪)', () => {
      const prompt = getBuiltInPrompt('task-organizer')!;
      // 必须出现 "self-task 模板" 章节标题（强信号：真模板存在，非仅铁律一行）
      expect(prompt).toMatch(/self.task.*模板|self_task.*模板/);
      // 模板内 task_create 调用必须带 parent_task_id（强信号：完整可执行调用）
      expect(prompt).toMatch(/task_create[\s\S]*parent_task_id/);
      // 含 #NNNN 占位符（强信号：模板里真给出递增 ID 形式）
      expect(prompt).toMatch(/#<TODO>|#NNNN|#\d{4}/);
      // 强调 Phase 0 之前建立 self-task（保留宽泛正则防回归）
      expect(prompt).toMatch(/Phase 0.*之前|阶段 0.*之前|self.task.*Phase 0/);
    });

    it('v2 must declare 5-phase workflow (Phase 0 through Phase 4, 5 phases total)', () => {
      const prompt = getBuiltInPrompt('task-organizer')!;
      // 必须有 Phase 0/1/2/3/4 全部标题
      expect(prompt).toMatch(/Phase\s*0|阶段\s*0/);
      expect(prompt).toMatch(/Phase\s*1|阶段\s*1/);
      expect(prompt).toMatch(/Phase\s*2|阶段\s*2/);
      expect(prompt).toMatch(/Phase\s*3|阶段\s*3/);
      expect(prompt).toMatch(/Phase\s*4|阶段\s*4/);
    });

    it('v2 must specify report output path as /tmp/task-organization-report-v{N+1}.md', () => {
      const prompt = getBuiltInPrompt('task-organizer')!;
      // 报告路径模板
      expect(prompt).toMatch(/task-organization-report.*v\{N\+1\}|task-organization-report-v\{N\+1\}/);
      // 必须包含累计历史对比章节
      expect(prompt).toMatch(/累计.*历史对比|历史对比/);
    });
  });
});
