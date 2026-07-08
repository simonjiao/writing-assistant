import { newId, nowIso } from '@wa/core';
import { ToolRegistry, executePromptProgram, ProductToolDefinition } from './product-tool';
import { productToolSchemas } from './tool-schemas';
import { registerDefaultProductSkills } from './product-skill';

type PromptToolSpec = {
  id: string;
  skillId: string;
  programId: string;
  inputSchema: ProductToolDefinition['inputSchema'];
  outputSchema: ProductToolDefinition['outputSchema'];
  workflowIds?: string[];
  mutatesArtifact?: boolean;
  requiresRevision?: boolean;
};

const promptTools: PromptToolSpec[] = [
  { id: 'refine_task_card', skillId: 'create-task-card', programId: 'task-card-builder', inputSchema: productToolSchemas.refineTaskCardInput, outputSchema: productToolSchemas.refineTaskCardOutput, workflowIds: ['writing-autopilot'], mutatesArtifact: true },
  { id: 'plan_outline', skillId: 'plan-outline', programId: 'outline-planner', inputSchema: productToolSchemas.planOutlineInput, outputSchema: productToolSchemas.planOutlineOutput, workflowIds: ['writing-autopilot'], mutatesArtifact: true, requiresRevision: true },
  { id: 'write_section', skillId: 'write-section', programId: 'section-writer', inputSchema: productToolSchemas.writeSectionInput, outputSchema: productToolSchemas.writeSectionOutput, workflowIds: ['writing-autopilot'], mutatesArtifact: true, requiresRevision: true },
  { id: 'resolve_article_comment', skillId: 'resolve-article-comment', programId: 'article-comment-resolver', inputSchema: productToolSchemas.resolveArticleCommentInput, outputSchema: productToolSchemas.resolveArticleCommentOutput, workflowIds: ['writing-autopilot', 'article-comment'], mutatesArtifact: true, requiresRevision: true },
  { id: 'route_dialogue', skillId: 'dialogue-route', programId: 'dialogue-router', inputSchema: productToolSchemas.routeDialogueInput, outputSchema: productToolSchemas.routeDialogueOutput, workflowIds: ['dialogue'] },
  { id: 'update_dialogue_brief', skillId: 'update-dialogue-brief', programId: 'dialogue-brief-updater', inputSchema: productToolSchemas.updateDialogueBriefInput, outputSchema: productToolSchemas.updateDialogueBriefOutput, workflowIds: ['dialogue', 'dialogue-brief'] },
  { id: 'create_revision_proposal', skillId: 'create-revision-proposal', programId: 'dialogue-coordinator', inputSchema: productToolSchemas.createRevisionProposalInput, outputSchema: productToolSchemas.createRevisionProposalOutput, workflowIds: ['dialogue', 'writing-autopilot'] },
  { id: 'revise_task_card', skillId: 'revise-task-card', programId: 'task-card-reviser', inputSchema: productToolSchemas.reviseTaskCardInput, outputSchema: productToolSchemas.reviseTaskCardOutput, workflowIds: ['dialogue', 'writing-autopilot'], mutatesArtifact: true, requiresRevision: true },
  { id: 'revise_outline', skillId: 'plan-outline', programId: 'outline-reviser', inputSchema: productToolSchemas.reviseOutlineInput, outputSchema: productToolSchemas.reviseOutlineOutput, workflowIds: ['dialogue', 'writing-autopilot'], mutatesArtifact: true, requiresRevision: true },
  { id: 'revise_outline_item', skillId: 'plan-outline', programId: 'outline-item-reviser', inputSchema: productToolSchemas.reviseOutlineItemInput, outputSchema: productToolSchemas.reviseOutlineItemOutput, workflowIds: ['dialogue', 'writing-autopilot'], mutatesArtifact: true, requiresRevision: true },
  { id: 'patch_block', skillId: 'patch-block', programId: 'patch-editor', inputSchema: productToolSchemas.patchBlockInput, outputSchema: productToolSchemas.patchBlockOutput, workflowIds: ['dialogue', 'writing-autopilot'], mutatesArtifact: true, requiresRevision: true },
  { id: 'evaluate_quality', skillId: 'evaluate-quality', programId: 'quality-evaluator', inputSchema: productToolSchemas.evaluateQualityInput, outputSchema: productToolSchemas.evaluateQualityOutput, workflowIds: ['article-review'] },
];

export function registerDefaultTools(registry = new ToolRegistry()): ToolRegistry {
  registry.register(createTaskIntakeTool());
  for (const spec of promptTools) registry.register(promptTool(spec));
  return registry;
}

function promptTool(spec: PromptToolSpec): ProductToolDefinition<unknown, unknown> {
  const skill = registerDefaultProductSkills().get(spec.skillId);
  return {
    id: spec.id,
    skill,
    workflowIds: spec.workflowIds ?? ['writing-autopilot'],
    inputSchema: spec.inputSchema,
    outputSchema: spec.outputSchema,
    mutatesArtifact: spec.mutatesArtifact ?? false,
    requiresRevision: spec.requiresRevision ?? false,
    requiresHumanGate: false,
    execute(execution, env) {
      return executePromptProgram(env, execution, spec.programId, skill);
    },
  };
}

function createTaskIntakeTool(): ProductToolDefinition<unknown, unknown> {
  const skill = registerDefaultProductSkills().get('create-task-card');
  return {
    id: 'create_task_intake',
    skill,
    workflowIds: ['writing-autopilot'],
    inputSchema: productToolSchemas.createTaskIntakeInput,
    outputSchema: productToolSchemas.createTaskIntakeOutput,
    mutatesArtifact: true,
    requiresRevision: false,
    requiresHumanGate: false,
    async execute(execution, env) {
      const input = productToolSchemas.createTaskIntakeInput.parse(execution.input);
      const workspace = await env.stores.workspaceStore.getWorkspace(input.workspaceId);
      if (!workspace || workspace.deletedAt) throw new Error(`Workspace not found: ${input.workspaceId}`);
      if (workspace.userId !== input.userId && !workspace.memberUserIds.includes(input.userId)) throw new Error('create_task_intake requires workspace access.');
      const existing = await env.stores.artifactStore.getArticle(input.articleId);
      const title = existing?.title ?? deriveTaskIntakeTitle(input.rawRequirement);
      const article = existing ?? await env.stores.artifactStore.createArticle({ id: input.articleId, userId: input.userId, workspaceId: input.workspaceId, title });
      await env.stores.eventTraceStore.append({ id: newId('evt'), runId: execution.runId, type: 'artifact.updated', payload: { articleId: article.id, workspaceId: article.workspaceId, reason: 'task-intake-created', userId: input.userId }, createdAt: nowIso() });
      return { articleId: article.id, workspaceId: article.workspaceId, title: article.title, summary: '已保存写作任务，正在整理任务卡。' };
    },
  };
}

function deriveTaskIntakeTitle(rawRequirement: string): string {
  const text = rawRequirement.replace(/\s+/g, ' ').trim();
  const topic = text.match(/(?:关于|围绕|写一篇关于)([^，,。.!！?？]{2,32})/)?.[1]?.trim();
  return (topic || text).slice(0, 24) || '新写作任务';
}
