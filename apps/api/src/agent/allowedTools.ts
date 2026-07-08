import { DialogueContextKind } from '@wa/core';

export type NonWorkflowToolName =
  | 'answer'
  | 'ask_clarifying_question'
  | 'create_revision_proposal'
  | 'revise_task_card'
  | 'revise_outline'
  | 'revise_outline_item'
  | 'patch_block'
  | 'search_knowledge'
  | 'answer_with_knowledge'
  | 'update_dialogue_brief'
  | 'resolve_article_comment';

export function allowedDialogueTools(input: {
  contextKind: DialogueContextKind;
  intent: 'answer' | 'discuss' | 'proposal' | 'rag' | 'brief';
}): NonWorkflowToolName[] {
  if (input.intent === 'rag') return ['search_knowledge', 'answer_with_knowledge', 'update_dialogue_brief'];
  if (input.intent === 'answer' || input.intent === 'discuss') return ['answer', 'ask_clarifying_question', 'update_dialogue_brief'];
  if (input.intent === 'brief') return ['update_dialogue_brief'];
  if (input.contextKind === 'task-card') return ['create_revision_proposal', 'revise_task_card', 'ask_clarifying_question', 'update_dialogue_brief'];
  if (input.contextKind === 'outline') return ['create_revision_proposal', 'revise_outline', 'ask_clarifying_question', 'update_dialogue_brief'];
  if (input.contextKind === 'outline-item') return ['create_revision_proposal', 'revise_outline_item', 'ask_clarifying_question', 'update_dialogue_brief'];
  return ['create_revision_proposal', 'patch_block', 'ask_clarifying_question', 'update_dialogue_brief'];
}

export function assertAllowedTool(toolName: string, allowedTools: readonly string[]): void {
  if (!allowedTools.includes(toolName)) throw new Error(`Unauthorized non-workflow agent tool: ${toolName}`);
}
