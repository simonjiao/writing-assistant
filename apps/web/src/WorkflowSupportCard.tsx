import type { HumanGate, ReviewArtifact, RunResponse, WorkflowOperation } from './types';

type WorkflowSupportCardProps = {
  runResponse?: RunResponse;
  busy: boolean;
  onResolveHumanGate: (gate: HumanGate, decision: 'accept' | 'reject') => void | Promise<void>;
};

type AllowedActionView = {
  type?: string;
  reason?: string;
};

export function WorkflowSupportCard(props: WorkflowSupportCardProps) {
  const run = props.runResponse?.run;
  if (!run) return null;
  const pendingGates = (props.runResponse?.humanGates ?? []).filter((gate) => gate.status === 'pending');
  const operations = (props.runResponse?.operations ?? []).slice(0, 5);
  const reviewArtifacts = (props.runResponse?.reviewArtifacts ?? []).slice(0, 3);
  const nextAction = pendingGates.length ? undefined : readAllowedActions(run.state)[0];
  return (
    <section className="support-card workflow-support-card">
      <div className="workflow-card-head"><h3>流程</h3><span>{workflowRunStatusLabel(run.status)}</span></div>
      <WorkflowNextStep pendingGates={pendingGates} nextAction={nextAction} runStatus={run.status} />
      {pendingGates.length ? <WorkflowGateList gates={pendingGates} busy={props.busy} onResolve={props.onResolveHumanGate} /> : null}
      {reviewArtifacts.length ? <WorkflowReviewList artifacts={reviewArtifacts} /> : null}
      {operations.length ? <WorkflowOperationList operations={operations} /> : null}
    </section>
  );
}

function WorkflowNextStep(props: { pendingGates: HumanGate[]; nextAction?: AllowedActionView; runStatus: string }) {
  if (props.pendingGates.length) {
    return <div className="workflow-next-step"><span>下一步</span><strong>等待确认</strong><p>{props.pendingGates[0].question}</p></div>;
  }
  if (props.nextAction) {
    return <div className="workflow-next-step"><span>下一步</span><strong>{workflowActionLabel(props.nextAction.type)}</strong><p>{props.nextAction.reason ?? '继续推进当前写作流程。'}</p></div>;
  }
  return <div className="workflow-next-step"><span>下一步</span><strong>{workflowTerminalLabel(props.runStatus)}</strong></div>;
}

function WorkflowGateList(props: { gates: HumanGate[]; busy: boolean; onResolve: (gate: HumanGate, decision: 'accept' | 'reject') => void | Promise<void> }) {
  return (
    <div className="workflow-section">
      <h4>待确认</h4>
      {props.gates.map((gate) => <div className="workflow-gate" key={gate.id}>
        <p>{gate.question}</p>
        <div className="workflow-gate-options">{gate.options.slice(0, 3).map((option) => <span key={option.id}>{option.label}</span>)}</div>
        <div className="workflow-gate-actions">
          <button type="button" className="secondary-button compact" disabled={props.busy} onClick={() => void props.onResolve(gate, 'reject')}>保留</button>
          <button type="button" className="compact" disabled={props.busy} onClick={() => void props.onResolve(gate, 'accept')}>确认</button>
        </div>
      </div>)}
    </div>
  );
}

function WorkflowReviewList(props: { artifacts: ReviewArtifact[] }) {
  const findings = props.artifacts.flatMap((artifact) => artifact.findings.map((finding) => ({ ...finding, type: artifact.type }))).slice(0, 5);
  const suggestions = props.artifacts.flatMap((artifact) => artifact.suggestions.map((suggestion) => ({ ...suggestion, type: artifact.type }))).slice(0, 4);
  return (
    <div className="workflow-section">
      <h4>检查建议</h4>
      {findings.length ? <div className="workflow-findings">{findings.map((finding, index) => <div className={`workflow-finding severity-${finding.severity}`} key={`${finding.type}-${finding.targetId ?? index}-${finding.message}`}><span>{reviewSeverityLabel(finding.severity)}</span>{finding.message}</div>)}</div> : <div className="empty">暂无检查问题。</div>}
      {suggestions.length ? <div className="workflow-suggestions">{suggestions.map((suggestion) => <div className="workflow-suggestion" key={suggestion.id}>{suggestion.summary}</div>)}</div> : null}
    </div>
  );
}

function WorkflowOperationList(props: { operations: WorkflowOperation[] }) {
  return (
    <div className="workflow-section">
      <h4>执行记录</h4>
      <div className="workflow-operations">{props.operations.map((operation) => <div className={`workflow-operation status-${operation.status}`} key={operation.operationId}><strong>{workflowActionLabel(operation.toolName)}</strong><span>{operationStatusLabel(operation.status)}</span></div>)}</div>
    </div>
  );
}

function readAllowedActions(state: Record<string, unknown>): AllowedActionView[] {
  const value = state.allowedActions;
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => item && typeof item === 'object' ? item as Record<string, unknown> : undefined)
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map((item) => ({
      type: typeof item.type === 'string' ? item.type : undefined,
      reason: typeof item.reason === 'string' ? item.reason : undefined,
    }));
}

function workflowActionLabel(type?: string): string {
  const labels: Record<string, string> = {
    create_task_card_draft: '创建任务卡草稿',
    ask_followup: '确认任务卡',
    plan_outline: '生成大纲',
    review_task_card_outline_consistency: '检查任务卡与大纲',
    write_next_section: '生成下一节',
    write_section: '生成当前节',
    generate_polish_report: '生成统稿建议',
    request_human_gate: '请求确认',
  };
  return type ? labels[type] ?? '执行工具' : '继续处理';
}

function workflowRunStatusLabel(status: string): string {
  const labels: Record<string, string> = { queued: '等待处理', running: '处理中', waiting: '等待确认', completed: '已完成', failed: '失败', cancelled: '已取消', idle: '就绪' };
  return labels[status] ?? status;
}

function workflowTerminalLabel(status: string): string {
  if (status === 'completed') return '流程已完成';
  if (status === 'failed') return '需要处理失败';
  if (status === 'cancelled') return '已取消';
  return '暂无待执行动作';
}

function operationStatusLabel(status: WorkflowOperation['status']): string {
  const labels: Record<WorkflowOperation['status'], string> = { running: '进行中', completed: '完成', failed: '失败' };
  return labels[status];
}

function reviewSeverityLabel(severity: ReviewArtifact['findings'][number]['severity']): string {
  const labels: Record<ReviewArtifact['findings'][number]['severity'], string> = { info: '提示', warning: '建议', blocking: '阻断' };
  return labels[severity];
}
