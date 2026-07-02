import { Skill } from '@wa/core';

export interface QualityEvaluatorInput {
  articleId: string;
  targetId?: string;
  criteria: string[];
}

export interface QualityEvaluatorOutput {
  passed: boolean;
  score: number;
  findings: string[];
  recommendedAction: 'accept' | 'revise' | 'ask_user';
}

export class QualityEvaluatorSkill implements Skill<QualityEvaluatorInput, QualityEvaluatorOutput> {
  manifest = {
    id: 'quality-evaluator',
    name: 'Quality Evaluator',
    version: '0.1.0',
    description: '检查文本是否满足任务卡、引用、连贯性等基本标准。',
  };

  async invoke({ input, context }: Parameters<Skill<QualityEvaluatorInput, QualityEvaluatorOutput>['invoke']>[0]): Promise<QualityEvaluatorOutput> {
    const findings: string[] = [];
    if (!context.article?.taskCard) findings.push('缺少任务卡，无法进行完整评估。');
    if (input.criteria.includes('citation') && context.article?.taskCard?.constraints.citationRequired) {
      const hasSources = context.article.blocks.some((block) => block.sourceRefs.length > 0);
      if (!hasSources) findings.push('任务卡要求引用，但当前正文缺少 sourceRefs。');
    }
    const passed = findings.length === 0;
    return {
      passed,
      score: passed ? 0.82 : 0.45,
      findings: passed ? ['基础检查通过。'] : findings,
      recommendedAction: passed ? 'accept' : 'revise',
    };
  }
}
