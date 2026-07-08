import { describe, expect, it } from 'vitest';
import { AgentEvent, DialogueMessage, DialogueResponse, RevisionProposal, RunResponse, WorkflowRun } from './types';
import { WorkflowDialogueState, activeWorkflowDialogueProposal, applyDialogueResponseToDialogueState, applyRunResponseToDialogueState } from './workflowDialogueState';

const createdAt = '2026-01-01T00:00:00.000Z';

function state(overrides: Partial<WorkflowDialogueState> = {}): WorkflowDialogueState {
  return { pendingProposals: [], dialogueMessages: [], proposalDirty: false, ...overrides };
}

function proposal(id: string, status: RevisionProposal['status'] = 'pending'): RevisionProposal {
  return {
    id,
    articleId: 'art_1',
    userId: 'user_1',
    runId: 'run_1',
    contextKind: 'outline',
    summary: `方案 ${id}`,
    message: `准备应用方案 ${id}`,
    operations: [{ type: 'revise-outline', instruction: `更新 ${id}` }],
    warnings: [],
    status,
    createdAt,
    updatedAt: createdAt,
  };
}

function message(id: string, role: DialogueMessage['role'], proposalId?: string): DialogueMessage {
  return {
    id,
    articleId: 'art_1',
    userId: 'user_1',
    contextKind: 'outline',
    role,
    content: `${role} message ${id}`,
    proposalId,
    createdAt,
  };
}

function run(status: WorkflowRun['status'] = 'waiting'): WorkflowRun {
  return {
    id: 'run_1',
    workflowId: 'writing-autopilot',
    status,
    waitingFor: status === 'waiting' ? { nodeId: 'revision-proposal', reason: '等待修改方案确认' } : undefined,
    state: {},
  };
}

function event(id = 'evt_1'): AgentEvent {
  return { id, runId: 'run_1', type: 'revision_proposal.created', payload: {}, createdAt };
}

function runResponse(overrides: Partial<RunResponse> = {}): RunResponse {
  return { run: run(), events: [event()], ...overrides };
}

describe('workflow dialogue UI state', () => {
  it('prefers the pending proposal from the visible dialogue response', () => {
    const oldProposal = proposal('old');
    const freshProposal = proposal('fresh');
    const appliedProposal = proposal('applied', 'applied');

    expect(activeWorkflowDialogueProposal(state({
      pendingProposals: [oldProposal],
      dialogueResponse: { mode: 'proposal', message: '已生成新方案', proposal: freshProposal },
    }))?.id).toBe('fresh');

    expect(activeWorkflowDialogueProposal(state({
      pendingProposals: [oldProposal],
      dialogueResponse: { mode: 'applied', message: '已应用', proposal: appliedProposal },
    }))?.id).toBe('old');
  });

  it('applies workflow run messages and pending proposals without dropping unsynced local discussion', () => {
    const result = applyRunResponseToDialogueState(state({
      pendingProposals: [proposal('old')],
      dialogueMessages: [message('old-user', 'user')],
      proposalDirty: true,
    }), runResponse({
      revisionProposals: [proposal('workflow')],
      messages: [message('user-1', 'user', 'workflow'), message('assistant-1', 'assistant', 'workflow')],
    }));

    expect(result.pendingProposals.map((item) => item.id)).toEqual(['workflow']);
    expect(result.dialogueMessages.map((item) => item.id)).toEqual(['user-1', 'assistant-1']);
    expect(result.proposalDirty).toBe(true);
  });

  it('clears dirty proposal state when the workflow confirms there is no pending proposal', () => {
    const result = applyRunResponseToDialogueState(state({
      pendingProposals: [proposal('old')],
      proposalDirty: true,
    }), runResponse({ revisionProposals: [] }));

    expect(result.pendingProposals).toEqual([]);
    expect(result.proposalDirty).toBe(false);
  });

  it('marks a pending proposal dirty when the user continues discussing it', () => {
    const result = applyDialogueResponseToDialogueState(state({
      pendingProposals: [proposal('old')],
      proposalDirty: false,
    }), {
      mode: 'discuss',
      message: '已记录这条意见。',
      messages: [message('user-1', 'user', 'old'), message('assistant-1', 'assistant', 'old')],
    });

    expect(result.pendingProposals.map((item) => item.id)).toEqual(['old']);
    expect(result.dialogueMessages.map((item) => item.id)).toEqual(['user-1', 'assistant-1']);
    expect(result.dialogueResponse).toBeUndefined();
    expect(result.proposalDirty).toBe(true);
  });

  it('keeps a refreshed proposal visible and clears dirty state', () => {
    const refreshedProposal = proposal('refreshed');
    const response: DialogueResponse = {
      mode: 'proposal',
      message: '已更新方案。',
      proposal: refreshedProposal,
      messages: [message('user-1', 'user', 'old'), message('assistant-1', 'assistant', 'refreshed')],
    };

    const result = applyDialogueResponseToDialogueState(state({
      pendingProposals: [proposal('old')],
      proposalDirty: true,
    }), response);

    expect(activeWorkflowDialogueProposal(result)?.id).toBe('refreshed');
    expect(result.dialogueResponse?.proposal?.id).toBe('refreshed');
    expect(result.proposalDirty).toBe(false);
  });

  it('clears pending workflow proposals after an applied dialogue response returns an updated run', () => {
    const appliedProposal = proposal('applied', 'applied');
    const result = applyDialogueResponseToDialogueState(state({
      pendingProposals: [proposal('old')],
      proposalDirty: true,
    }), {
      mode: 'applied',
      message: '已应用修改。',
      proposal: appliedProposal,
      run: run('waiting'),
      events: [event()],
      revisionProposals: [],
      messages: [message('assistant-1', 'assistant', 'applied')],
    });

    expect(result.pendingProposals).toEqual([]);
    expect(result.dialogueMessages.map((item) => item.id)).toEqual(['assistant-1']);
    expect(result.dialogueResponse?.mode).toBe('applied');
    expect(result.proposalDirty).toBe(false);
  });
});
