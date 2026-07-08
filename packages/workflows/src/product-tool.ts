import { z } from 'zod';
import { ContextBuilder, ExternalStores, JsonValue, LLMProvider, newId, nowIso } from '@wa/core';
import { PromptProgramRegistry } from './prompt-program';

export const ProductCommandSchema = z.object({
  commandType: z.string().min(1),
  userId: z.string().min(1),
  workspaceId: z.string().optional(),
  articleId: z.string().optional(),
  sessionId: z.string().optional(),
  baseRevision: z.number().int().optional(),
  payload: z.record(z.string(), z.unknown()).default({}),
});

export type ProductCommand = z.infer<typeof ProductCommandSchema>;

export interface ProductToolExecution<I> {
  input: I;
  userId: string;
  sessionId?: string;
  runId?: string;
  workflowId?: string;
  agentSessionId?: string;
  articleId?: string;
  blockId?: string;
}

export interface ProductToolEnvironment {
  stores: ExternalStores;
  llm: LLMProvider;
  contextBuilder: ContextBuilder;
  promptPrograms: PromptProgramRegistry;
}

export interface ProductToolDefinition<I = unknown, O = unknown> {
  id: string;
  workflowIds: string[];
  inputSchema: z.ZodType<I>;
  outputSchema: z.ZodType<O>;
  mutatesArtifact: boolean;
  requiresRevision: boolean;
  requiresHumanGate: boolean;
  execute(input: ProductToolExecution<I>, env: ProductToolEnvironment): Promise<O>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ProductToolDefinition<unknown, unknown>>();

  register<I, O>(tool: ProductToolDefinition<I, O>): void {
    this.tools.set(tool.id, tool as ProductToolDefinition<unknown, unknown>);
  }

  get<I, O>(toolId: string): ProductToolDefinition<I, O> {
    const tool = this.tools.get(toolId);
    if (!tool) throw new Error(`Product tool not found: ${toolId}`);
    return tool as ProductToolDefinition<I, O>;
  }

  list(workflowId?: string): ProductToolDefinition<unknown, unknown>[] {
    const tools = [...this.tools.values()];
    return workflowId ? tools.filter((tool) => tool.workflowIds.includes(workflowId)) : tools;
  }
}

export async function executePromptProgram<I, O>(
  env: ProductToolEnvironment,
  execution: ProductToolExecution<I>,
  programId: string,
): Promise<O> {
  const program = env.promptPrograms.get<I, O>(programId);
  await env.stores.eventTraceStore.append({
    id: newId('evt'),
    runId: execution.runId,
    type: 'prompt_program.started',
    payload: { programId, workflowId: execution.workflowId, agentSessionId: execution.agentSessionId },
    createdAt: nowIso(),
  });
  const context = await env.contextBuilder.build({
    userId: execution.userId,
    sessionId: execution.sessionId,
    runId: execution.runId,
    promptProgramId: programId,
    input: execution.input,
    articleId: execution.articleId,
    blockId: execution.blockId,
  });
  try {
    const output = await program.invoke({ input: execution.input, context, llm: env.llm });
    await env.stores.eventTraceStore.append({
      id: newId('evt'),
      runId: execution.runId,
      type: 'prompt_program.completed',
      payload: { programId, workflowId: execution.workflowId, agentSessionId: execution.agentSessionId },
      createdAt: nowIso(),
    });
    return output;
  } catch (error) {
    await env.stores.eventTraceStore.append({
      id: newId('evt'),
      runId: execution.runId,
      type: 'prompt_program.failed',
      payload: { programId, workflowId: execution.workflowId, agentSessionId: execution.agentSessionId, error: error instanceof Error ? error.message : String(error) },
      createdAt: nowIso(),
    });
    throw error;
  }
}

export function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
}
