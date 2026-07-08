import { z } from 'zod';

const stringArraySchema = z.array(z.string());
const jsonRecordSchema = z.record(z.string(), z.unknown());

const followUpPromptSchema = z.object({
  id: z.string(),
  question: z.string(),
  options: stringArraySchema,
  allowCustom: z.boolean(),
}).passthrough();

export const writingTaskCardSchema = z.object({
  id: z.string(),
  topic: z.string().min(1),
  writingGoal: z.string().min(1),
  audience: z.string().min(1),
  topRules: z.object({
    languageEra: z.string().optional(),
    summary: z.string().optional(),
    writingStandards: stringArraySchema,
    replacementHints: z.array(z.object({ avoid: z.string(), prefer: z.string() }).passthrough()).optional(),
  }).passthrough().optional(),
  scope: z.object({
    editions: stringArraySchema.optional(),
    chapters: stringArraySchema.optional(),
    characters: stringArraySchema.optional(),
    themes: stringArraySchema.optional(),
  }).passthrough(),
  structure: z.object({
    articleType: z.enum(['essay', 'analysis', 'commentary', 'speech', 'longform']),
    expectedLength: z.string().min(1),
    outlinePreference: z.string().optional(),
  }).passthrough(),
  style: z.object({
    register: z.string().min(1),
    tone: z.string().min(1),
    classicalFlavor: z.boolean(),
    characterVoice: z.string().optional(),
  }).passthrough(),
  constraints: z.object({
    mustInclude: stringArraySchema,
    mustAvoid: stringArraySchema,
    citationRequired: z.boolean(),
    sourcePolicy: z.string().min(1),
  }).passthrough(),
  interactionMode: z.object({
    askBeforeWriting: z.boolean(),
    localEditFirst: z.boolean(),
    followUpQuestions: stringArraySchema.optional(),
    followUpPrompts: z.array(followUpPromptSchema).optional(),
  }).passthrough(),
  status: z.enum(['draft', 'confirmed']),
  createdAt: z.string(),
  updatedAt: z.string(),
}).passthrough();

export const outlineItemSchema = z.object({
  id: z.string(),
  title: z.string().min(1),
  goal: z.string().min(1),
  order: z.number(),
  expectedBlocks: z.number().positive(),
  rhetoricalRole: z.enum(['opening', 'development', 'turn', 'conclusion']).optional(),
  keySection: z.boolean().optional(),
  specialHandling: stringArraySchema.optional(),
  sourceHints: stringArraySchema,
  themeTags: stringArraySchema,
  status: z.enum(['draft', 'confirmed', 'written']),
}).passthrough();

export const articleBlockSchema = z.object({
  id: z.string(),
  type: z.enum(['title', 'section', 'paragraph', 'quote', 'note']),
  sectionId: z.string().optional(),
  title: z.string().optional(),
  text: z.string(),
  sourceRefs: stringArraySchema,
  themeTags: stringArraySchema,
  status: z.enum(['draft', 'reviewed', 'needs_revision']),
  createdAt: z.string(),
  updatedAt: z.string(),
}).passthrough();

const commentReplySchema = z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string(),
  createdAt: z.string(),
}).passthrough();

export const articleCommentSchema = z.object({
  id: z.string(),
  articleId: z.string(),
  blockId: z.string(),
  selectedText: z.string(),
  comment: z.string(),
  selectionStart: z.number().optional(),
  selectionEnd: z.number().optional(),
  status: z.enum(['open', 'resolved', 'needs_input']),
  resolutionKind: z.enum(['revision', 'explanation', 'question']).optional(),
  response: z.string().optional(),
  replacementText: z.string().optional(),
  replies: z.array(commentReplySchema).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  resolvedAt: z.string().optional(),
}).passthrough();

const dialogueContextKindSchema = z.enum(['task-card', 'outline', 'outline-item', 'block']);

const revisionOperationSchema = z.union([
  z.object({ type: z.literal('revise-task-card'), instruction: z.string().min(1) }).passthrough(),
  z.object({ type: z.literal('revise-outline'), instruction: z.string().min(1) }).passthrough(),
  z.object({ type: z.literal('revise-outline-item'), outlineItemId: z.string().min(1), instruction: z.string().min(1) }).passthrough(),
  z.object({ type: z.literal('patch-block'), blockId: z.string().min(1), instruction: z.string().min(1) }).passthrough(),
]);

const dialogueBriefSchema = z.object({
  id: z.string(),
  articleId: z.string(),
  userId: z.string(),
  activeRequirements: z.array(jsonRecordSchema),
  evidenceNotes: z.array(jsonRecordSchema),
  recentUserIntents: z.array(jsonRecordSchema),
  unresolvedConflicts: z.array(jsonRecordSchema),
  supersededRequirements: z.array(jsonRecordSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
}).passthrough();

const taskCardDomainContextSchema = z.object({
  profileId: z.string(),
  label: z.string(),
  editions: stringArraySchema,
  themes: stringArraySchema,
  mustInclude: stringArraySchema,
  mustAvoid: stringArraySchema,
  sourcePolicies: stringArraySchema,
}).passthrough();

const writingStandardSchema = z.object({
  id: z.string(),
  label: z.string(),
  languageEra: z.object({ id: z.string(), label: z.string() }).passthrough(),
  summary: z.string(),
  topRules: stringArraySchema,
  mustInclude: stringArraySchema,
  mustAvoid: stringArraySchema,
  replacementHints: z.array(z.object({ avoid: z.string(), prefer: z.string() }).passthrough()),
  sourcePolicies: stringArraySchema,
}).passthrough();

export const productToolSchemas = {
  buildTaskCardDraftInput: z.object({
    rawRequirement: z.string().min(1),
    userId: z.string().min(1),
    sessionId: z.string().optional(),
    domainContext: taskCardDomainContextSchema.optional(),
    writingStandard: writingStandardSchema.optional(),
  }).passthrough(),
  buildTaskCardDraftOutput: z.object({
    taskCard: writingTaskCardSchema,
    missingQuestions: stringArraySchema,
    followUpPrompts: z.array(followUpPromptSchema).optional(),
    summary: z.string().min(1),
    confidence: z.number().min(0).max(1),
  }).passthrough(),

  planOutlineInput: z.object({ articleId: z.string().min(1), taskCard: writingTaskCardSchema }).passthrough(),
  planOutlineOutput: z.object({ outline: z.array(outlineItemSchema).min(1), summary: z.string().min(1) }).passthrough(),

  writeSectionInput: z.object({ articleId: z.string().min(1), section: outlineItemSchema, taskCard: writingTaskCardSchema }).passthrough(),
  writeSectionOutput: z.object({
    block: articleBlockSchema.optional(),
    blocks: z.array(articleBlockSchema).optional(),
    candidateSources: stringArraySchema,
    summary: z.string().min(1),
  }).passthrough().refine((value) => Boolean(value.block) || Boolean(value.blocks?.length), 'write_section must return block or blocks.'),

  resolveArticleCommentInput: z.object({
    articleId: z.string().min(1),
    comment: articleCommentSchema,
    block: articleBlockSchema,
    taskCard: writingTaskCardSchema.optional(),
    adjacentBlocks: z.array(articleBlockSchema.pick({ id: true, title: true, text: true }).passthrough()).optional(),
  }).passthrough(),
  resolveArticleCommentOutput: z.object({
    action: z.enum(['revise', 'explain', 'ask']),
    response: z.string().min(1),
    replacementText: z.string().optional(),
  }).passthrough(),

  routeDialogueInput: z.object({
    message: z.string().min(1),
    skipKnowledge: z.boolean().optional(),
    hasPendingProposal: z.boolean(),
    context: z.object({ kind: dialogueContextKindSchema, title: z.string() }).passthrough(),
  }).passthrough(),
  routeDialogueOutput: z.object({
    route: z.enum(['answer', 'clarify', 'discuss', 'propose', 'needs-rag']),
    message: z.string().optional(),
  }).passthrough(),

  updateDialogueBriefInput: z.object({
    message: z.string().min(1),
    context: z.object({ kind: z.string(), title: z.string() }).passthrough(),
    currentBrief: dialogueBriefSchema.optional(),
    skipKnowledge: z.boolean().optional(),
  }).passthrough(),
  updateDialogueBriefOutput: z.object({
    activeRequirements: z.array(z.object({ kind: z.string(), text: z.string() }).passthrough()),
    evidenceNotes: stringArraySchema,
    recentUserIntents: stringArraySchema,
    supersededRequirements: stringArraySchema,
    conflicts: z.array(z.object({ text: z.string(), requirements: stringArraySchema }).passthrough()),
  }).passthrough(),

  createRevisionProposalInput: z.object({
    articleId: z.string().min(1),
    message: z.string().min(1),
    skipKnowledge: z.boolean().optional(),
    conversation: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string(), proposalId: z.string().optional(), createdAt: z.string() }).passthrough()).optional(),
    conversationBrief: dialogueBriefSchema.optional(),
    pendingProposal: z.object({ id: z.string(), summary: z.string(), message: z.string(), operations: z.array(revisionOperationSchema), warnings: stringArraySchema }).passthrough().optional(),
    context: z.object({ kind: dialogueContextKindSchema, title: z.string(), detail: z.string().optional(), outlineItemId: z.string().optional(), blockId: z.string().optional() }).passthrough(),
    taskCard: writingTaskCardSchema.optional(),
    outline: z.array(outlineItemSchema),
    selectedOutlineItem: outlineItemSchema.optional(),
    selectedBlock: articleBlockSchema.optional(),
  }).passthrough(),
  createRevisionProposalOutput: z.object({
    mode: z.enum(['answer', 'clarify', 'proposal']),
    message: z.string().min(1),
    summary: z.string().optional(),
    operations: z.array(revisionOperationSchema),
    warnings: stringArraySchema,
  }).passthrough(),

  reviseTaskCardInput: z.object({ articleId: z.string().min(1), instruction: z.string().min(1), currentTaskCard: writingTaskCardSchema, skipKnowledge: z.boolean().optional() }).passthrough(),
  reviseTaskCardOutput: z.object({ taskCard: writingTaskCardSchema, summary: z.string().min(1), missingQuestions: stringArraySchema.optional(), followUpPrompts: z.array(followUpPromptSchema).optional(), changedFields: stringArraySchema }).passthrough(),

  reviseOutlineInput: z.object({ articleId: z.string().min(1), instruction: z.string().min(1), taskCard: writingTaskCardSchema.optional(), currentOutline: z.array(outlineItemSchema), writtenSectionIds: stringArraySchema.optional() }).passthrough(),
  reviseOutlineOutput: z.object({ outline: z.array(outlineItemSchema).min(1), summary: z.string().min(1), changedFields: stringArraySchema, warnings: stringArraySchema }).passthrough(),

  reviseOutlineItemInput: z.object({ articleId: z.string().min(1), instruction: z.string().min(1), currentOutlineItem: outlineItemSchema, taskCard: writingTaskCardSchema.optional(), articleOutline: z.array(outlineItemSchema).optional() }).passthrough(),
  reviseOutlineItemOutput: z.object({ outlineItem: outlineItemSchema, summary: z.string().min(1), changedFields: stringArraySchema }).passthrough(),

  patchBlockInput: z.object({ articleId: z.string().min(1), blockId: z.string().min(1), instruction: z.string().min(1) }).passthrough(),
  patchBlockOutput: z.object({
    patch: z.object({
      id: z.string(),
      articleId: z.string(),
      blockId: z.string(),
      before: z.string(),
      after: z.string(),
      instruction: z.string(),
      affectedBlockIds: stringArraySchema,
      requiresScopeExpansion: z.boolean(),
      changeSummary: stringArraySchema,
      createdAt: z.string(),
    }).passthrough(),
    evaluation: z.object({
      preservesMeaning: z.boolean(),
      needsUserApprovalForScopeExpansion: z.boolean(),
      notes: stringArraySchema,
    }).passthrough(),
  }).passthrough(),

  evaluateQualityInput: z.object({ articleId: z.string().min(1), targetId: z.string().optional(), criteria: stringArraySchema }).passthrough(),
  evaluateQualityOutput: z.object({ passed: z.boolean(), score: z.number(), findings: stringArraySchema, recommendedAction: z.enum(['accept', 'revise', 'ask_user']) }).passthrough(),
} as const;
