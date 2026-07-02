import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { AgentEvent, ArticleArtifact, ArticleBlock, RunResponse } from './types';

const userId = 'demo-user';
const terminalStatuses = new Set(['waiting', 'completed', 'failed', 'cancelled']);

export function App() {
  const [sessionId, setSessionId] = useState<string>();
  const [requirement, setRequirement] = useState('写一篇关于《红楼梦》中宝黛关系的长文，半文半白，不要太学术，重点写精神相通。');
  const [article, setArticle] = useState<ArticleArtifact>();
  const [lastRun, setLastRun] = useState<RunResponse>();
  const [selectedBlockId, setSelectedBlockId] = useState<string>();
  const [patchInstruction, setPatchInstruction] = useState('这段写得更含蓄、更有红楼梦的味道，但不要改变意思。');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [liveEvents, setLiveEvents] = useState<AgentEvent[]>([]);
  const refreshTimer = useRef<number | undefined>(undefined);

  useEffect(() => { api.createSession(userId).then((session) => setSessionId(session.id)).catch((err) => setError(String(err))); }, []);
  useEffect(() => {
    if (!lastRun?.run.id) return;
    setLiveEvents(lastRun.events ?? []);
    const close = api.streamRunEvents(lastRun.run.id, (event) => { setLiveEvents((items) => [...items.filter((item) => item.id !== event.id), event].slice(-80)); if (['workflow.waiting','workflow.completed','workflow.failed','review.required','artifact.updated','queue.dequeued','queue.completed'].includes(event.type)) scheduleRunRefresh(lastRun.run.id); }, () => scheduleRunRefresh(lastRun.run.id));
    return close;
  }, [lastRun?.run.id]);

  const selectedBlock = useMemo(() => article?.blocks.find((block) => block.id === selectedBlockId), [article, selectedBlockId]);
  const patchPreview = (lastRun?.run.state.patchResult as { patch?: { before: string; after: string; changeSummary: string[] } } | undefined)?.patch;
  const status = lastRun ? `${lastRun.run.workflowId} / ${lastRun.run.status}` : '就绪';

  function scheduleRunRefresh(runId: string) { window.clearTimeout(refreshTimer.current); refreshTimer.current = window.setTimeout(() => { void api.getRun(runId).then((response) => { setLastRun(response); if (response.article) setArticle(response.article); if (terminalStatuses.has(response.run.status)) setBusy(false); }).catch((err) => setError(err instanceof Error ? err.message : String(err))); }, 200); }
  async function execute(action: () => Promise<RunResponse>) { setBusy(true); setError(undefined); try { const response = await action(); setLastRun(response); if (response.article) setArticle(response.article); if (terminalStatuses.has(response.run.status)) setBusy(false); else scheduleRunRefresh(response.run.id); return response; } catch (err) { setError(err instanceof Error ? err.message : String(err)); setBusy(false); } }

  return (
    <div className="app-shell">
      <header className="topbar"><div><strong>Writing Assistant MVP</strong><span className="muted">Workflow · RAG · Queue · SSE/WebSocket</span></div><div className="status">{busy ? `执行中：${status}` : status}</div></header>
      {error && <div className="error">{error}</div>}
      <main className="workspace">
        <aside className="panel task-panel">
          <h2>任务卡</h2>
          {!article?.taskCard ? <div className="empty">尚未生成任务卡。</div> : <div className="task-card"><label>主题</label><div>{article.taskCard.topic}</div><label>目标</label><div>{article.taskCard.writingGoal}</div><label>读者</label><div>{article.taskCard.audience}</div><label>结构</label><div>{article.taskCard.structure.articleType} / {article.taskCard.structure.expectedLength}</div><label>风格</label><div>{article.taskCard.style.register}；{article.taskCard.style.tone}</div><label>修改策略</label><div>{article.taskCard.interactionMode.localEditFirst ? '默认局部修改' : '允许全文重写'}</div><label>状态</label><div>{article.taskCard.status}</div></div>}
          {lastRun?.run.status === 'waiting' && lastRun.run.waitingFor?.nodeId === 'wait-task-card-confirm' && <button onClick={() => execute(() => api.resume(lastRun.run.id, { decision: 'confirm' }))}>确认任务卡</button>}
          {article?.taskCard?.status === 'confirmed' && !article.outline.length && <button onClick={() => execute(() => api.startOutline(article.id, userId, sessionId))}>生成大纲</button>}
          {lastRun?.run.status === 'waiting' && lastRun.run.waitingFor?.nodeId === 'wait-outline-confirm' && <button onClick={() => execute(() => api.resume(lastRun.run.id, { decision: 'confirm' }))}>确认大纲</button>}
        </aside>
        <section className="panel editor-panel">
          <h2>文章编辑区</h2>
          <div className="input-row"><textarea value={requirement} onChange={(event) => setRequirement(event.target.value)} /><button disabled={busy || !requirement.trim()} onClick={() => execute(() => api.startTaskCard(requirement, userId, sessionId))}>生成任务卡</button></div>
          {article?.outline.length ? <div className="outline"><h3>大纲</h3>{article.outline.map((item) => <div className="outline-item" key={item.id}><div><strong>{item.title}</strong><p>{item.goal}</p><span>{item.status}</span></div><button disabled={busy} onClick={() => execute(() => api.startSection(article.id, item.id, userId, sessionId))}>生成本节</button></div>)}</div> : null}
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
