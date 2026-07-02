import { newId, nowIso, safeJsonParse, Skill, WritingTaskCard } from '@wa/core';

export interface TaskCardBuilderInput {
  rawRequirement: string;
  userId: string;
  sessionId?: string;
}

export interface TaskCardBuilderOutput {
  taskCard: WritingTaskCard;
  missingQuestions: string[];
  summary: string;
  confidence: number;
}

export class TaskCardBuilderSkill implements Skill<TaskCardBuilderInput, TaskCardBuilderOutput> {
  manifest = {
    id: 'task-card-builder',
    name: 'Task Card Builder',
    version: '0.1.0',
    description: '把用户的自然语言写作需求转成结构化任务卡。',
    policies: {
      askOnlyNecessaryQuestions: true,
      doNotStartWritingBeforeConfirmation: true,
    },
  };

  async invoke({ input, context, llm }: Parameters<Skill<TaskCardBuilderInput, TaskCardBuilderOutput>['invoke']>[0]): Promise<TaskCardBuilderOutput> {
    const system = [
      '你是写作助手的任务卡规划器。',
      '你必须输出 JSON，不要输出 Markdown。',
      '任务卡要适合后续大纲、章节写作、局部修改和引用检查。',
    ].join('\n');

    const user = JSON.stringify({
      rawRequirement: input.rawRequirement,
      userPreferences: context.memory,
      outputShape: {
        taskCard: 'WritingTaskCard',
        missingQuestions: 'string[]',
        summary: 'string',
        confidence: 'number',
      },
    });

    try {
      const response = await llm.chat({
        jsonMode: true,
        temperature: 0.2,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      });
      const parsed = safeJsonParse<Partial<TaskCardBuilderOutput>>(response.content);
      if (parsed?.taskCard) {
        return normalizeOutput(parsed, input.rawRequirement);
      }
    } catch {
      // Fall through to deterministic MVP behavior.
    }

    return buildHeuristicTaskCard(input.rawRequirement);
  }
}

function normalizeOutput(output: Partial<TaskCardBuilderOutput>, rawRequirement: string): TaskCardBuilderOutput {
  const fallback = buildHeuristicTaskCard(rawRequirement);
  const now = nowIso();
  const taskCard: WritingTaskCard = {
    ...fallback.taskCard,
    ...output.taskCard,
    id: output.taskCard?.id ?? fallback.taskCard.id,
    status: 'draft',
    createdAt: output.taskCard?.createdAt ?? now,
    updatedAt: now,
    constraints: {
      ...fallback.taskCard.constraints,
      ...output.taskCard?.constraints,
      mustInclude: output.taskCard?.constraints?.mustInclude ?? fallback.taskCard.constraints.mustInclude,
      mustAvoid: output.taskCard?.constraints?.mustAvoid ?? fallback.taskCard.constraints.mustAvoid,
    },
    interactionMode: {
      ...fallback.taskCard.interactionMode,
      ...output.taskCard?.interactionMode,
      askBeforeWriting: true,
      localEditFirst: true,
    },
  };
  return {
    taskCard,
    missingQuestions: output.missingQuestions ?? [],
    summary: output.summary ?? fallback.summary,
    confidence: output.confidence ?? 0.72,
  };
}

export function buildHeuristicTaskCard(rawRequirement: string): TaskCardBuilderOutput {
  const lower = rawRequirement.toLowerCase();
  const hasClassicalFlavor = /半文半白|古典|红楼梦|文雅|含蓄/.test(rawRequirement);
  const isLong = /长文|深入|完整|系统/.test(rawRequirement);
  const citationRequired = /引用|原文|依据|资料|出处|版本|脂批/.test(rawRequirement);
  const topic = rawRequirement.replace(/[。.!！?？].*$/s, '').trim().slice(0, 80) || '未命名写作任务';
  const themes = [...new Set((rawRequirement.match(/宝黛|礼教|知己|悲剧|人物|关系|主题|版本|脂批/g) ?? []).map(String))];
  const characters = [...new Set((rawRequirement.match(/贾宝玉|林黛玉|薛宝钗|王熙凤|宝玉|黛玉|宝钗/g) ?? []).map(String))];
  const now = nowIso();

  const taskCard: WritingTaskCard = {
    id: newId('task'),
    topic,
    writingGoal: rawRequirement,
    audience: /学术|论文|研究/.test(rawRequirement) ? '文学研究读者' : '普通中文读者',
    scope: {
      editions: [],
      chapters: [],
      characters,
      themes,
    },
    structure: {
      articleType: isLong ? 'longform' : 'analysis',
      expectedLength: isLong ? '2500-4000字' : '1200-2000字',
      outlinePreference: '先立论，再分节展开，最后收束观点。',
    },
    style: {
      register: /学术|论文|研究/.test(rawRequirement) ? '分析型书面语' : '清晰、有文学感的中文',
      tone: /不要太学术|随笔|轻松/.test(rawRequirement) ? '温和、可读、不过度学术化' : '稳健、清楚、有判断',
      classicalFlavor: hasClassicalFlavor,
      characterVoice: /王熙凤/.test(rawRequirement) ? '王熙凤式机锋与爽利' : undefined,
    },
    constraints: {
      mustInclude: themes,
      mustAvoid: /不要/.test(rawRequirement) ? [rawRequirement.match(/不要[^，。,.!?！？]*/)?.[0] ?? '避免偏离用户限制'] : [],
      citationRequired,
      sourcePolicy: citationRequired ? '涉及事实、版本、原文情节时需要可追溯依据。' : '优先基于任务卡和用户给出的材料，必要时提示需要补充来源。',
    },
    interactionMode: {
      askBeforeWriting: true,
      localEditFirst: true,
    },
    status: 'draft',
    createdAt: now,
    updatedAt: now,
  };

  return {
    taskCard,
    missingQuestions: citationRequired ? ['是否有指定版本或引用来源？'] : [],
    summary: `已将需求整理为任务卡：${topic}`,
    confidence: 0.72,
  };
}
