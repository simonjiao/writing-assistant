import { ToolRegistry, executePromptProgram, ProductToolDefinition } from './product-tool';
import { productToolSchemas } from './tool-schemas';

type PromptToolSpec = {
  id: string;
  programId: string;
  inputSchema: ProductToolDefinition['inputSchema'];
  outputSchema: ProductToolDefinition['outputSchema'];
  workflowIds?: string[];
  mutatesArtifact?: boolean;
  requiresRevision?: boolean;
};

const promptTools: PromptToolSpec[] = [
  { id: 'build_task_card_draft', programId: 'task-card-builder', inputSchema: productToolSchemas.buildTaskCardDraftInput, outputSchema: productToolSchemas.buildTaskCardDraftOutput, workflowIds: ['writing-autopilot'], mutatesArtifact: true },
  { id: 'plan_outline', programId: 'outline-planner', inputSchema: productToolSchemas.planOutlineInput, outputSchema: productToolSchemas.planOutlineOutput, workflowIds: ['writing-autopilot'], mutatesArtifact: true, requiresRevision: true },
  { id: 'write_section', programId: 'section-writer', inputSchema: productToolSchemas.writeSectionInput, outputSchema: productToolSchemas.writeSectionOutput, workflowIds: ['writing-autopilot'], mutatesArtifact: true, requiresRevision: true },
  { id: 'resolve_article_comment', programId: 'article-comment-resolver', inputSchema: productToolSchemas.resolveArticleCommentInput, outputSchema: productToolSchemas.resolveArticleCommentOutput, workflowIds: ['writing-autopilot', 'article-comment'], mutatesArtifact: true, requiresRevision: true },
  { id: 'route_dialogue', programId: 'dialogue-router', inputSchema: productToolSchemas.routeDialogueInput, outputSchema: productToolSchemas.routeDialogueOutput, workflowIds: ['dialogue'] },
  { id: 'update_dialogue_brief', programId: 'dialogue-brief-updater', inputSchema: productToolSchemas.updateDialogueBriefInput, outputSchema: productToolSchemas.updateDialogueBriefOutput, workflowIds: ['dialogue', 'dialogue-brief'] },
  { id: 'create_revision_proposal', programId: 'dialogue-coordinator', inputSchema: productToolSchemas.createRevisionProposalInput, outputSchema: productToolSchemas.createRevisionProposalOutput, workflowIds: ['dialogue', 'writing-autopilot'] },
  { id: 'revise_task_card', programId: 'task-card-reviser', inputSchema: productToolSchemas.reviseTaskCardInput, outputSchema: productToolSchemas.reviseTaskCardOutput, workflowIds: ['dialogue', 'writing-autopilot'], mutatesArtifact: true, requiresRevision: true },
  { id: 'revise_outline', programId: 'outline-reviser', inputSchema: productToolSchemas.reviseOutlineInput, outputSchema: productToolSchemas.reviseOutlineOutput, workflowIds: ['dialogue', 'writing-autopilot'], mutatesArtifact: true, requiresRevision: true },
  { id: 'revise_outline_item', programId: 'outline-item-reviser', inputSchema: productToolSchemas.reviseOutlineItemInput, outputSchema: productToolSchemas.reviseOutlineItemOutput, workflowIds: ['dialogue', 'writing-autopilot'], mutatesArtifact: true, requiresRevision: true },
  { id: 'patch_block', programId: 'patch-editor', inputSchema: productToolSchemas.patchBlockInput, outputSchema: productToolSchemas.patchBlockOutput, workflowIds: ['dialogue', 'writing-autopilot'], mutatesArtifact: true, requiresRevision: true },
  { id: 'evaluate_quality', programId: 'quality-evaluator', inputSchema: productToolSchemas.evaluateQualityInput, outputSchema: productToolSchemas.evaluateQualityOutput, workflowIds: ['article-review'] },
];

export function registerDefaultTools(registry = new ToolRegistry()): ToolRegistry {
  for (const spec of promptTools) registry.register(promptTool(spec));
  return registry;
}

function promptTool(spec: PromptToolSpec): ProductToolDefinition<unknown, unknown> {
  return {
    id: spec.id,
    workflowIds: spec.workflowIds ?? ['writing-autopilot'],
    inputSchema: spec.inputSchema,
    outputSchema: spec.outputSchema,
    mutatesArtifact: spec.mutatesArtifact ?? false,
    requiresRevision: spec.requiresRevision ?? false,
    requiresHumanGate: false,
    execute(execution, env) {
      return executePromptProgram(env, execution, spec.programId);
    },
  };
}
