import { DialogueContextKind, safeJsonParse } from '@wa/core';
import { PromptProgram } from '@wa/runtime';

export type DialogueRouteDecision = 'answer' | 'clarify' | 'discuss' | 'propose' | 'needs-rag';

export interface DialogueRouterInput {
  message: string;
  skipKnowledge?: boolean;
  hasPendingProposal: boolean;
  context: { kind: DialogueContextKind; title: string };
}

export interface DialogueRouterOutput {
  route: DialogueRouteDecision;
  message?: string;
}

export class DialogueRouterProgram implements PromptProgram<DialogueRouterInput, DialogueRouterOutput> {
  manifest = {
    id: 'dialogue-router',
    name: 'Dialogue Router',
    version: '0.1.0',
    description: '轻量判断用户对话下一步应进入解释、讨论、澄清、检索或方案生成。',
    policies: {
      readOnlyByDefault: true,
      requiresExplicitApply: false,
      noArtifactMutation: true,
    },
  };

  async invoke({ input, llm }: Parameters<PromptProgram<DialogueRouterInput, DialogueRouterOutput>['invoke']>[0]): Promise<DialogueRouterOutput> {
    const response = await llm.chat({
      jsonMode: true,
      temperature: 0,
      maxTokens: 120,
      messages: [
        {
          role: 'system',
          content: [
            '你是写作助手的轻量路由器，只返回 JSON。',
            '只判断用户这句话下一步走哪条流程，不生成修改方案，不查资料。',
            'route 只能是 answer、clarify、discuss、propose、needs-rag。',
            '只有用户明确要求查找、检索、列出资料、找出处、找原文、找脂批或证据时 route=needs-rag。',
            '用户说写作中需要包含、纳入、保留、不要漏掉某材料，是修改写作约束，不是 needs-rag。',
            '用户明确要求改写、修改、调整、添加、删除、压缩、扩写、补充、包含、避免时 route=propose。',
            '用户只是在表达想法、偏好、补充意见，且已有 pending proposal 时 route=discuss。',
            '判断不清时 route=clarify。',
          ].join('\n'),
        },
        {
          role: 'user',
          content: JSON.stringify({
            message: input.message,
            hasPendingProposal: input.hasPendingProposal,
            context: input.context,
            requiredOutputShape: { route: 'answer | clarify | discuss | propose | needs-rag', message: 'optional short reason' },
          }),
        },
      ],
    });
    const parsed = safeJsonParse<Partial<DialogueRouterOutput>>(response.content);
    if (!parsed) throw new Error(`Dialogue router did not return valid JSON: ${response.content.slice(0, 300)}`);
    return { route: normalizeRoute(parsed.route), message: typeof parsed.message === 'string' ? parsed.message.trim() : undefined };
  }
}

function normalizeRoute(value: unknown): DialogueRouteDecision {
  if (value === 'answer' || value === 'clarify' || value === 'discuss' || value === 'propose' || value === 'needs-rag') return value;
  throw new Error(`Dialogue router returned invalid route: ${String(value)}`);
}
