import { AllowedAction, ArticleArtifact, WorkflowPolicy, WorkflowRun } from './types';

export interface WorkflowActionExecutionInput {
  policy: WorkflowPolicy;
  run: WorkflowRun;
  action: AllowedAction;
}

export interface WorkflowActionExecutionResult {
  run?: WorkflowRun;
  article?: ArticleArtifact;
  summary: string;
}

export interface WorkflowActionExecutor {
  execute(input: WorkflowActionExecutionInput): Promise<WorkflowActionExecutionResult>;
}
