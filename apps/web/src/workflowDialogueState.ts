import { DialogueMessage, DialogueResponse, RevisionProposal, RunResponse } from './types';

export interface WorkflowDialogueState {
  pendingProposals: RevisionProposal[];
  dialogueMessages: DialogueMessage[];
  dialogueResponse?: DialogueResponse;
  proposalDirty: boolean;
}

export function activeWorkflowDialogueProposal(state: WorkflowDialogueState): RevisionProposal | undefined {
  return state.dialogueResponse?.proposal?.status === 'pending'
    ? state.dialogueResponse.proposal
    : state.pendingProposals[0];
}

export function applyRunResponseToDialogueState(state: WorkflowDialogueState, response: RunResponse): WorkflowDialogueState {
  const next: WorkflowDialogueState = { ...state };
  if (response.revisionProposals) {
    next.pendingProposals = response.revisionProposals;
    if (!response.revisionProposals.length) next.proposalDirty = false;
  }
  if (response.messages) next.dialogueMessages = response.messages;
  return next;
}

export function applyDialogueResponseToDialogueState(state: WorkflowDialogueState, response: DialogueResponse): WorkflowDialogueState {
  let next: WorkflowDialogueState = { ...state };
  const activeProposal = activeWorkflowDialogueProposal(state);
  if (response.messages) next.dialogueMessages = response.messages;
  if (response.mode === 'discuss' && activeProposal) next.proposalDirty = true;
  if (response.mode === 'proposal' || response.mode === 'applied') next.proposalDirty = false;
  next.dialogueResponse = isTransientDialogueResponse(response) ? undefined : response;
  if (response.run && response.events) {
    next = applyRunResponseToDialogueState(next, {
      run: response.run,
      article: response.article,
      events: response.events,
      humanGates: response.humanGates,
      operations: response.operations,
      reviewArtifacts: response.reviewArtifacts,
      revisionProposals: response.revisionProposals,
      messages: response.messages,
    });
  }
  return next;
}

function isTransientDialogueResponse(response: DialogueResponse): boolean {
  return response.mode === 'answer' || response.mode === 'clarify' || response.mode === 'discuss';
}
