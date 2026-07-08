import { resolve } from 'node:path';
import { DialogueContextKind, safeJsonParse } from '@wa/core';
import { loadPromptTemplate, PromptProgram } from '@wa/runtime';

const systemPrompt = loadPromptTemplate(resolve(__dirname, '../prompts/dialogue-router.system.md'));

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
          content: systemPrompt,
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
