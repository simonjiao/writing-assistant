import { defineProductWorkflowModule } from '@wa/runtime';
import { resolve } from 'node:path';

export const WRITING_AUTOPILOT_POLICY = {
  id: 'writing-autopilot',
  goal: '自主推进写作任务，从任务卡到大纲、正文、一致性审阅和统稿报告。',
  allowedActionPolicy: 'runner 每轮由产品 workflow planner 生成 allowedActions；agent 只能选择其中一个 action，不能自造 action 或 operationId。',
  humanGatePolicy: '覆盖已有大纲、正文或需要用户裁决时必须创建 HumanGate 并暂停 run。',
  completionPolicy: '任务卡、大纲、正文全部完成且统稿报告生成后，run 才能 completed。',
};

export default defineProductWorkflowModule({
  id: WRITING_AUTOPILOT_POLICY.id,
  workflowPath: resolve(__dirname, 'workflow.md'),
  policy: WRITING_AUTOPILOT_POLICY,
  skillIds: [
    'create-task-card',
    'plan-outline',
    'evaluate-quality',
    'create-revision-proposal',
    'write-section',
    'resolve-article-comment',
  ],
});
