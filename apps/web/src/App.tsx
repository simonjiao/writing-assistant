import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { AgentEvent, ArticleArtifact, ArticleBlock, RunResponse, WritingTaskCard } from './types';

const userId = 'demo-user';
const terminalStatuses = new Set(['waiting', 'completed', 'failed', 'cancelled']);
const activeStatuses = new Set(['queued', 'running']);
const runRefreshIntervalMs = 1000;

export function App() {
  const [sessionId, setSessionId] = useState<string>();
  const [requirement, setRequirement] = useState('写一篇关于《红楼梦》中宝黛关系的长文，半文半白，不要太学术，重点写精神相通。');
  const [article, setArticle] = useState<ArticleArtifact>();
  const [lastRun, setLastRun] = useState<RunResponse>();
  const [selectedBlockId, setSelectedBlockId] = useState<string>();
  const [patchInstruction, setPatchInstruction] = useState('这段写得更含蓄、更有红楼梦的味道，但不要改变意思。');
  const [taskCardInstruction, setTaskCardInstruction] = useState('');
  const [taskCardRevisionSummary, setTaskCardRevisionSummary] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [liveEvents, setLiveEvents] = useState<AgentEvent[]>([]);
  const [editingOutline, setEditingOutline] = useState<{ id: string; title: string; goal: string }>();
  const refreshTimer = useRef<number | undefined>(undefined);
  const activeRunId = useRef<string | undefined>(undefined);

  useEffect(() => { api.createSession(userId).then((session) => setSessionId(session.id)).catch((err) => setError(String(err))); }, []);
  useEffect(() => {
    if (!lastRun?.run.id) return;
    const runId = lastRun.run.id;
    activeRunId.current = runId;
    setLiveEvents(lastRun.events ?? []);
    const close = api.streamRunEvents(runId, (event) => { setLiveEvents((items) => [...items.filter((item) => item.id !== event.id), event].slice(-80)); if (['workflow.waiting','workflow.completed','workflow.failed','review.required','artifact.updated','queue.dequeued','queue.completed'].includes(event.type)) scheduleRunRefresh(runId); }, () => scheduleRunRefresh(runId, runRefreshIntervalMs));
    if (activeStatuses.has(lastRun.run.status)) scheduleRunRefresh(runId);
    return close;
  }, [lastRun?.run.id]);

  const selectedBlock = useMemo(() => article?.blocks.find((block) => block.id === selectedBlockId), [article, selectedBlockId]);
  const patchPreview = (lastRun?.run.state.patchResult as { patch?: { before: string; after: string; changeSummary: string[] } } | undefined)?.patch;
  const status = lastRun ? `${lastRun.run.workflowId} / ${lastRun.run.status}` : '就绪';

  function applyRunResponse(response: RunResponse) {
    setLastRun(response);
    if (response.article) setArticle(response.article);
    if (terminalStatuses.has(response.run.status)) { setBusy(false); if (activeRunId.current === response.run.id) activeRunId.current = undefined; }
    else if (activeStatuses.has(response.run.status)) { activeRunId.current = response.run.id; scheduleRunRefresh(response.run.id, runRefreshIntervalMs); }
  }
  function scheduleRunRefresh(runId: string, delayMs = 200) { window.clearTimeout(refreshTimer.current); refreshTimer.current = window.setTimeout(() => { void api.getRun(runId).then((response) => { if (activeRunId.current && activeRunId.current !== runId) return; applyRunResponse(response); }).catch((err) => { setError(err instanceof Error ? err.message : String(err)); if (activeRunId.current === runId) scheduleRunRefresh(runId, 1000); }); }, delayMs); }
  async function execute(action: () => Promise<RunResponse>) { setBusy(true); setError(undefined); window.clearTimeout(refreshTimer.current); try { const response = await action(); activeRunId.current = response.run.id; applyRunResponse(response); return response; } catch (err) { setError(err instanceof Error ? err.message : String(err)); setBusy(false); activeRunId.current = undefined; } }
  async function saveOutlineEdit() {
    if (!article || !editingOutline) return;
    setBusy(true);
    setError(undefined);
    try {
      const updated = await api.updateOutlineItem(article.id, editingOutline.id, { title: editingOutline.title, goal: editingOutline.goal, userId });
      setArticle(updated);
      setEditingOutline(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
  async function reviseTaskCard() {
    if (!article?.taskCard || !taskCardInstruction.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      const response = await api.reviseTaskCard(article.id, { instruction: taskCardInstruction, userId, sessionId });
      setArticle(response.article);
      setTaskCardRevisionSummary(response.summary);
      setTaskCardInstruction('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar"><div><strong>Writing Assistant</strong><span className="muted">Workflow · RAG · Queue · SSE/WebSocket</span></div><div className="status">{busy ? `执行中：${status}` : status}</div></header>
      {error && <div className="error">{error}</div>}
      <main className="workspace">
        <aside className="panel task-panel">
          <h2>任务卡</h2>
          {!article?.taskCard ? <div className="empty">尚未生成任务卡。</div> : <TaskCardView taskCard={article.taskCard} />}
          {article?.taskCard && <div className="task-card-reviser"><h3>修改任务卡</h3><textarea value={taskCardInstruction} onChange={(event) => setTaskCardInstruction(event.target.value)} placeholder="例如：字数改到 800 字，风格更自然，主题不要扩大。" /><button disabled={busy || !taskCardInstruction.trim()} onClick={() => void reviseTaskCard()}>更新任务卡</button>{taskCardRevisionSummary && <div className="revision-summary">{taskCardRevisionSummary}</div>}</div>}
          {lastRun?.run.status === 'waiting' && lastRun.run.waitingFor?.nodeId === 'wait-task-card-confirm' && <button disabled={busy} onClick={() => execute(() => api.resume(lastRun.run.id, { decision: 'confirm' }))}>确认任务卡</button>}
          {article?.taskCard?.status === 'confirmed' && !article.outline.length && <button disabled={busy} onClick={() => execute(() => api.startOutline(article.id, userId, sessionId))}>生成大纲</button>}
          {lastRun?.run.status === 'waiting' && lastRun.run.waitingFor?.nodeId === 'wait-outline-confirm' && <button disabled={busy} onClick={() => execute(() => api.resume(lastRun.run.id, { decision: 'confirm' }))}>确认大纲</button>}
        </aside>
        <section className="panel editor-panel">
          <h2>文章编辑区</h2>
          <div className="input-row"><textarea value={requirement} onChange={(event) => setRequirement(event.target.value)} /><button disabled={busy || !requirement.trim()} onClick={() => execute(() => api.startTaskCard(requirement, userId, sessionId))}>生成任务卡</button></div>
          {article?.outline.length ? <div className="outline"><h3>大纲</h3>{article.outline.map((item) => {
            const isEditing = editingOutline?.id === item.id;
            return <div className="outline-item" key={item.id}>{isEditing ? <div className="outline-edit"><input value={editingOutline.title} onChange={(event) => setEditingOutline({ ...editingOutline, title: event.target.value })} /><textarea value={editingOutline.goal} onChange={(event) => setEditingOutline({ ...editingOutline, goal: event.target.value })} /></div> : <div><strong>{item.title}</strong><p>{item.goal}</p><span>{outlineStatusLabel(item.status)}</span></div>}<div className="outline-actions">{isEditing ? <><button disabled={busy || !editingOutline.title.trim() || !editingOutline.goal.trim()} onClick={() => void saveOutlineEdit()}>保存</button><button disabled={busy} onClick={() => setEditingOutline(undefined)}>取消</button></> : <><button disabled={busy} onClick={() => setEditingOutline({ id: item.id, title: item.title, goal: item.goal })}>编辑</button><button disabled={busy} onClick={() => execute(() => api.startSection(article.id, item.id, userId, sessionId))}>生成本节</button></>}</div></div>;
          })}</div> : null}
          <div className="article-blocks">{article?.blocks.map((block) => <ArticleBlockView key={block.id} block={block} selected={block.id === selectedBlockId} onSelect={() => setSelectedBlockId(block.id)} />)}</div>
        </section>
        <aside className="panel side-panel">
          <h2>知识 / 引用 / 标签</h2>
          {selectedBlock ? <div><h3>当前段落</h3><p className="mono">{selectedBlock.id}</p><h3>引用来源</h3>{selectedBlock.sourceRefs.length ? selectedBlock.sourceRefs.map((ref) => <span className="tag" key={ref}>{ref}</span>) : <div className="empty">暂无引用绑定</div>}<h3>主题标签</h3>{selectedBlock.themeTags.map((tag) => <span className="tag" key={tag}>{tag}</span>)}</div> : <div className="empty">选择一个段落后显示对应来源和标签。</div>}
          <h3>版本</h3><div className="versions">{article?.versions.slice().reverse().slice(0, 6).map((version) => <div key={version.id} className="version-item"><strong>{version.reason}</strong><span>{new Date(version.createdAt).toLocaleString()}</span></div>)}</div>
          <h3>实时事件</h3><div className="event-list">{liveEvents.slice().reverse().slice(0, 10).map((event) => <div key={event.id} className="event-item"><strong>{event.type}</strong><span>{new Date(event.createdAt).toLocaleTimeString()}</span></div>)}</div>
        </aside>
      </main>
      <footer className="chatbar"><div className="patch-box"><strong>局部修改</strong><input value={patchInstruction} onChange={(event) => setPatchInstruction(event.target.value)} placeholder="选中段落后输入修改意见" /><button disabled={!article || !selectedBlockId || busy} onClick={() => article && selectedBlockId && execute(() => api.startPatch(article.id, selectedBlockId, patchInstruction, userId, sessionId))}>生成 Patch</button>{lastRun?.run.status === 'waiting' && lastRun.run.waitingFor?.nodeId === 'wait-patch-confirm' && <button onClick={() => execute(() => api.resume(lastRun.run.id, { decision: 'accept' }))}>应用 Patch</button>}</div>{patchPreview && <div className="patch-preview"><strong>Patch 预览</strong><div className="diff-grid"><pre>{patchPreview.before}</pre><pre>{patchPreview.after}</pre></div><ul>{patchPreview.changeSummary.map((item) => <li key={item}>{item}</li>)}</ul></div>}</footer>
    </div>
  );
}
function ArticleBlockView(props: { block: ArticleBlock; selected: boolean; onSelect: () => void }) { return <article className={props.selected ? 'block selected' : 'block'} onClick={props.onSelect}><h3>{props.block.title}</h3><pre>{props.block.text}</pre></article>; }

function TaskCardView(props: { taskCard: WritingTaskCard }) {
  const card = props.taskCard;
  return (
    <div className="task-card">
      <label>主题</label><div>{card.topic}</div>
      <label>目标</label><div>{card.writingGoal}</div>
      <label>读者</label><div>{card.audience}</div>
      <label>范围</label><div>{displayScope(card)}</div>
      <label>结构</label><div>{displayStructure(card)}</div>
      <label>风格</label><div>{displayStyle(card)}</div>
      <label>约束</label><div>{displayConstraints(card)}</div>
    </div>
  );
}

function displayScope(card: WritingTaskCard): string {
  const parts = [
    joinList(card.scope.characters),
    joinList(card.scope.themes),
    joinList(card.scope.chapters),
    joinList(card.scope.editions),
  ].filter(Boolean);
  return parts.join('；');
}

function displayStructure(card: WritingTaskCard): string {
  return [articleTypeLabel(card.structure.articleType), card.structure.expectedLength, card.structure.outlinePreference].filter(Boolean).join('；');
}

function displayStyle(card: WritingTaskCard): string {
  return [card.style.register, card.style.tone, card.style.characterVoice].filter((item) => item?.trim()).join('；');
}

function displayConstraints(card: WritingTaskCard): string {
  const include = joinList(card.constraints.mustInclude);
  const avoid = joinList(card.constraints.mustAvoid);
  const citation = card.constraints.citationRequired ? '需要可追溯引用' : '';
  return [
    include ? `要包含：${include}` : '',
    avoid ? `避免：${avoid}` : '',
    citation,
    card.constraints.sourcePolicy,
  ].filter(Boolean).join('；');
}

function articleTypeLabel(value: string): string {
  const labels: Record<string, string> = { essay: '随笔', analysis: '赏析/分析', commentary: '评论', speech: '演讲稿', longform: '长文' };
  return labels[value] ?? value;
}

function outlineStatusLabel(value: string): string {
  const labels: Record<string, string> = { draft: '待确认', confirmed: '已确认', written: '已写作' };
  return labels[value] ?? value;
}

function joinList(items?: string[]): string {
  return (items ?? []).filter((item) => item.trim().length > 0).join('、');
}
