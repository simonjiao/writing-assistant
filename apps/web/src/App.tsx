import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { AgentEvent, ArticleArtifact, ArticleBlock, ArticleSummary, DomainProfileRecommendation, DomainProfileSelection, DomainProfileSummary, RunResponse, TaskCardFollowUpPrompt, WorkflowRun, WritingStandardSelection, WritingStandardSummary, WritingTaskCard, WritingWorkspace } from './types';

const userId = 'demo-user';
const terminalStatuses = new Set(['waiting', 'completed', 'failed', 'cancelled']);
const activeStatuses = new Set(['queued', 'running']);
const runRefreshIntervalMs = 1000;
const navigationCollapsedStorageKey = 'writing-assistant.navigation-collapsed';
const supportColumnCollapsedStorageKey = 'writing-assistant.support-column-collapsed';
type SectionGenerationState = { sectionId: string; runId?: string; status: WorkflowRun['status'] | 'starting'; error?: string };
type TaskCardTarget = 'current' | 'new';
type DialogContext = { kind: 'new-task' | 'task-card' | 'outline' | 'paragraph'; label: string; title: string; detail: string; contextText: string };

export function App() {
  const [sessionId, setSessionId] = useState<string>();
  const [currentTaskMessage, setCurrentTaskMessage] = useState('');
  const [newTaskMessage, setNewTaskMessage] = useState('');
  const [taskCardTarget, setTaskCardTarget] = useState<TaskCardTarget>('new');
  const [article, setArticle] = useState<ArticleArtifact>();
  const [articleSummaries, setArticleSummaries] = useState<ArticleSummary[]>([]);
  const [workspaces, setWorkspaces] = useState<WritingWorkspace[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>();
  const [newWorkspaceName, setNewWorkspaceName] = useState('');
  const [newWorkspaceMembers, setNewWorkspaceMembers] = useState('');
  const [workspaceModalOpen, setWorkspaceModalOpen] = useState(false);
  const [navigationCollapsed, setNavigationCollapsed] = useState(() => readNavigationCollapsedPreference());
  const [supportColumnCollapsed, setSupportColumnCollapsed] = useState(() => readSupportColumnCollapsedPreference());
  const [domainProfiles, setDomainProfiles] = useState<DomainProfileSummary[]>([]);
  const [domainProfileRecommendations, setDomainProfileRecommendations] = useState<DomainProfileRecommendation[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<string>();
  const [profileSelections, setProfileSelections] = useState<Record<string, string | string[]>>({});
  const [writingStandard, setWritingStandard] = useState<WritingStandardSummary>();
  const [selectedLanguageEra, setSelectedLanguageEra] = useState('');
  const [extraForbiddenTerms, setExtraForbiddenTerms] = useState('');
  const [lastRun, setLastRun] = useState<RunResponse>();
  const [selectedBlockId, setSelectedBlockId] = useState<string>();
  const [patchInstruction, setPatchInstruction] = useState('这段写得更含蓄、更有红楼梦的味道，但不要改变意思。');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [liveEvents, setLiveEvents] = useState<AgentEvent[]>([]);
  const [progressVisible, setProgressVisible] = useState(false);
  const [editingOutline, setEditingOutline] = useState<{ id: string; title: string; goal: string }>();
  const [selectedOutlineId, setSelectedOutlineId] = useState<string>();
  const [collapsedOutlineIds, setCollapsedOutlineIds] = useState<string[]>([]);
  const [collapsedBlockIds, setCollapsedBlockIds] = useState<string[]>([]);
  const [sectionGeneration, setSectionGeneration] = useState<SectionGenerationState>();
  const refreshTimer = useRef<number | undefined>(undefined);
  const progressDismissTimer = useRef<number | undefined>(undefined);
  const activeRunId = useRef<string | undefined>(undefined);
  const taskCardDialogTarget: TaskCardTarget = article?.taskCard && taskCardTarget === 'current' ? 'current' : 'new';
  const visibleArticle = taskCardDialogTarget === 'new' ? undefined : article;
  const activeTaskCardMessage = taskCardDialogTarget === 'new' ? newTaskMessage : currentTaskMessage;
  const setActiveTaskCardMessage = taskCardDialogTarget === 'new' ? setNewTaskMessage : setCurrentTaskMessage;
  const domainRecommendationText = taskCardDialogTarget === 'new' ? newTaskMessage : '';

  async function refreshArticleSummaries(workspaceId = selectedWorkspaceId) {
    if (!workspaceId) {
      setArticleSummaries([]);
      return;
    }
    const summaries = await api.listArticles(userId, workspaceId);
    setArticleSummaries(summaries);
  }

  useEffect(() => {
    void Promise.all([api.createSession(userId), api.listWorkspaces(userId), api.listDomainProfiles(), api.listWritingStandards()])
      .then(async ([session, workspaceList, profiles, standards]) => {
        setSessionId(session.id);
        setWorkspaces(workspaceList);
        const workspaceId = session.currentWorkspaceId ?? workspaceList[0]?.id;
        setSelectedWorkspaceId(workspaceId);
        if (workspaceId) {
          const summaries = await api.listArticles(userId, workspaceId);
          setArticleSummaries(summaries);
          const firstArticleId = summaries[0]?.id;
          if (firstArticleId) setArticle(await api.getArticle(firstArticleId, userId));
        }
        setDomainProfiles(profiles);
        setWritingStandard(standards);
        setSelectedLanguageEra(standards.defaultOptionId);
      })
      .catch((err) => setError(String(err)));
  }, []);
  useEffect(() => {
    if (!lastRun?.run.id) return;
    const runId = lastRun.run.id;
    activeRunId.current = runId;
    setLiveEvents(lastRun.events ?? []);
    const close = api.streamRunEvents(runId, (event) => { setLiveEvents((items) => [...items.filter((item) => item.id !== event.id), event].slice(-80)); if (['workflow.waiting','workflow.completed','workflow.failed','review.required','artifact.updated','queue.dequeued','queue.completed'].includes(event.type)) scheduleRunRefresh(runId); }, () => scheduleRunRefresh(runId, runRefreshIntervalMs));
    if (activeStatuses.has(lastRun.run.status)) scheduleRunRefresh(runId);
    return close;
  }, [lastRun?.run.id]);
  useEffect(() => {
    if (!domainProfiles.length || !domainRecommendationText.trim()) {
      setDomainProfileRecommendations([]);
      return;
    }
    const rawRequirement = domainRecommendationText.trim();
    const timer = window.setTimeout(() => {
      void api.recommendDomainProfiles(rawRequirement).then(setDomainProfileRecommendations).catch(() => setDomainProfileRecommendations([]));
    }, 300);
    return () => window.clearTimeout(timer);
  }, [domainProfiles.length, domainRecommendationText]);
  useEffect(() => {
    setCollapsedOutlineIds([]);
    setCollapsedBlockIds([]);
    setSelectedOutlineId(undefined);
    setSectionGeneration(undefined);
    setTaskCardTarget(article?.taskCard ? 'current' : 'new');
    setCurrentTaskMessage('');
    setNewTaskMessage('');
  }, [article?.id]);
  useEffect(() => () => window.clearTimeout(progressDismissTimer.current), []);

  const selectedBlock = useMemo(() => visibleArticle?.blocks.find((block) => block.id === selectedBlockId), [visibleArticle, selectedBlockId]);
  const selectedOutline = useMemo(() => visibleArticle?.outline.find((item) => item.id === selectedOutlineId), [visibleArticle, selectedOutlineId]);
  const unassignedBlocks = useMemo(() => {
    if (visibleArticle?.outline.length) return [];
    const outlineIds = new Set(visibleArticle?.outline.map((item) => item.id) ?? []);
    return visibleArticle?.blocks.filter((block) => !block.sectionId || !outlineIds.has(block.sectionId)) ?? [];
  }, [visibleArticle]);
  const selectedWorkspace = useMemo(() => workspaces.find((workspace) => workspace.id === selectedWorkspaceId), [selectedWorkspaceId, workspaces]);
  const selectedProfile = useMemo(() => domainProfiles.find((profile) => profile.id === selectedProfileId), [domainProfiles, selectedProfileId]);
  const patchPreview = (lastRun?.run.state.patchResult as { patch?: { before: string; after: string; changeSummary: string[] } } | undefined)?.patch;
  const status = lastRun ? runStatusLabel(lastRun.run, liveEvents) : '就绪';
  const canGenerateOutline = visibleArticle?.taskCard?.status === 'confirmed';
  const taskCardConfirmed = visibleArticle?.taskCard?.status === 'confirmed';
  const taskCardDraft = visibleArticle?.taskCard?.status === 'draft';
  const taskCardConfirmationRunId = lastRun?.run.status === 'waiting' && lastRun.run.waitingFor?.nodeId === 'wait-task-card-confirm' ? lastRun.run.id : undefined;
  const outlineConfirmationRunId = lastRun?.run.status === 'waiting' && lastRun.run.waitingFor?.nodeId === 'wait-outline-confirm' ? lastRun.run.id : undefined;
  const canConfirmOutline = Boolean(visibleArticle?.outline.length && visibleArticle.outline.some((item) => item.status !== 'confirmed'));
  const canDeleteWorkspace = Boolean(selectedWorkspace && !selectedWorkspace.isDefault && selectedWorkspace.userId === userId);
  const canSubmitTaskCardMessage = Boolean(activeTaskCardMessage.trim() && (taskCardDialogTarget === 'current' || selectedWorkspaceId));
  const taskCardFollowUpPrompts = useMemo(() => visibleArticle?.taskCard?.status === 'draft' ? taskCardPrompts(visibleArticle.taskCard) : [], [visibleArticle?.taskCard]);
  const hasWritingBlocks = Boolean(visibleArticle?.blocks.length);
  const outlineGenerated = Boolean(visibleArticle?.outline.length);
  const dialogContext = useMemo(() => buildDialogContext(taskCardDialogTarget, visibleArticle, selectedOutline, selectedBlock), [taskCardDialogTarget, visibleArticle, selectedOutline, selectedBlock]);

  function applyRunResponse(response: RunResponse) {
    setLastRun(response);
    setProgressVisible(true);
    window.clearTimeout(progressDismissTimer.current);
    if (response.article) {
      setArticle(response.article);
      setSelectedWorkspaceId(response.article.workspaceId);
      void refreshArticleSummaries(response.article.workspaceId).catch((err) => setError(err instanceof Error ? err.message : String(err)));
    }
    if (response.run.workflowId === 'section-writing-workflow') {
      setSectionGeneration((current) => current ? { ...current, runId: response.run.id, status: response.run.status, error: response.run.error } : current);
    }
    if (terminalStatuses.has(response.run.status)) {
      setBusy(false);
      if (response.run.status === 'failed' && response.run.error) setError(userFacingRunError(response.run.error));
      if (activeRunId.current === response.run.id) activeRunId.current = undefined;
      scheduleProgressDismiss(response.run);
    }
    else if (activeStatuses.has(response.run.status)) { activeRunId.current = response.run.id; scheduleRunRefresh(response.run.id, runRefreshIntervalMs); }
  }
  function scheduleRunRefresh(runId: string, delayMs = 200) { window.clearTimeout(refreshTimer.current); refreshTimer.current = window.setTimeout(() => { void api.getRun(runId).then((response) => { if (activeRunId.current && activeRunId.current !== runId) return; applyRunResponse(response); }).catch((err) => { setError(err instanceof Error ? err.message : String(err)); if (activeRunId.current === runId) scheduleRunRefresh(runId, 1000); }); }, delayMs); }
  function scheduleProgressDismiss(run: WorkflowRun) {
    if (run.status !== 'completed' && run.status !== 'failed' && run.status !== 'cancelled' && run.status !== 'waiting') return;
    const delayMs = run.status === 'failed' ? 5000 : 2000;
    progressDismissTimer.current = window.setTimeout(() => {
      setProgressVisible(false);
      setSectionGeneration((current) => current?.runId === run.id ? undefined : current);
    }, delayMs);
  }
  async function execute(action: () => Promise<RunResponse>) { setBusy(true); setError(undefined); setProgressVisible(true); window.clearTimeout(refreshTimer.current); window.clearTimeout(progressDismissTimer.current); try { const response = await action(); activeRunId.current = response.run.id; applyRunResponse(response); return response; } catch (err) { setError(err instanceof Error ? err.message : String(err)); setBusy(false); activeRunId.current = undefined; progressDismissTimer.current = window.setTimeout(() => setProgressVisible(false), 5000); } }
  async function openArticle(articleId: string) {
    setBusy(true);
    setError(undefined);
    try {
      const loaded = await api.getArticle(articleId, userId);
      setArticle(loaded);
      setTaskCardTarget('current');
      setSelectedWorkspaceId(loaded.workspaceId);
      setLastRun(undefined);
      setSelectedBlockId(undefined);
      setSelectedOutlineId(undefined);
      setLiveEvents([]);
      setProgressVisible(false);
      setCurrentTaskMessage('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
  async function deleteArticle(articleId: string) {
    const target = articleSummaries.find((item) => item.id === articleId);
    if (!window.confirm(`删除任务「${target?.title ?? articleId}」？`)) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.deleteArticle(articleId, userId);
      await refreshArticleSummaries();
      if (article?.id === articleId) {
        setArticle(undefined);
        setLastRun(undefined);
        setSelectedBlockId(undefined);
        setSelectedOutlineId(undefined);
        setLiveEvents([]);
        setProgressVisible(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
  function currentDomainProfileSelection(): DomainProfileSelection | undefined {
    return selectedProfile ? { id: selectedProfile.id, selections: profileSelections } : undefined;
  }
  function selectProfile(profileId: string) {
    const profile = domainProfiles.find((item) => item.id === profileId);
    setSelectedProfileId(profile?.id);
    setProfileSelections(profile ? defaultProfileSelections(profile) : {});
  }
  function updateProfileGroup(groupId: string, value: string | string[]) {
    setProfileSelections((current) => ({ ...current, [groupId]: value }));
  }
  function currentWritingStandardSelection(): WritingStandardSelection | undefined {
    if (!writingStandard || !selectedLanguageEra) return undefined;
    return { languageEra: selectedLanguageEra, extraForbiddenTerms: parseForbiddenTerms(extraForbiddenTerms) };
  }
  function toggleOutlineCollapsed(outlineId: string) {
    setCollapsedOutlineIds((current) => toggleId(current, outlineId));
  }
  function toggleBlockCollapsed(blockId: string) {
    setCollapsedBlockIds((current) => toggleId(current, blockId));
  }
  function openNewTaskPage() {
    setTaskCardTarget('new');
    setSelectedBlockId(undefined);
    setSelectedOutlineId(undefined);
    setEditingOutline(undefined);
    setNewTaskMessage('');
    setLastRun(undefined);
    setLiveEvents([]);
    setProgressVisible(false);
  }
  async function startSectionGeneration(sectionId: string) {
    if (!article) return;
    setCollapsedOutlineIds((current) => current.filter((id) => id !== sectionId));
    setSectionGeneration({ sectionId, status: 'starting' });
    const response = await execute(() => api.startSection(article.id, sectionId, userId, sessionId));
    if (!response) {
      setSectionGeneration((current) => current?.sectionId === sectionId ? { ...current, status: 'failed' } : current);
      return;
    }
    setSectionGeneration((current) => current?.sectionId === sectionId ? { ...current, runId: response.run.id, status: response.run.status, error: response.run.error } : current);
  }
  function updateNavigationCollapsed(collapsed: boolean) {
    setNavigationCollapsed(collapsed);
    try {
      window.localStorage.setItem(navigationCollapsedStorageKey, collapsed ? 'true' : 'false');
    } catch {
      // Local storage can be unavailable in restricted browser modes; in-memory state still works.
    }
  }

  function updateSupportColumnCollapsed(collapsed: boolean) {
    setSupportColumnCollapsed(collapsed);
    try {
      window.localStorage.setItem(supportColumnCollapsedStorageKey, collapsed ? 'true' : 'false');
    } catch {
      // Local storage can be unavailable in restricted browser modes; in-memory state still works.
    }
  }
  async function selectWorkspace(workspaceId: string) {
    setSelectedWorkspaceId(workspaceId);
    setArticle(undefined);
    setLastRun(undefined);
    setSelectedBlockId(undefined);
    setSelectedOutlineId(undefined);
    setLiveEvents([]);
    setProgressVisible(false);
    await refreshArticleSummaries(workspaceId);
  }
  async function createWorkspace() {
    const name = newWorkspaceName.trim();
    if (!name) return;
    setBusy(true);
    setError(undefined);
    try {
      const workspace = await api.createWorkspace({ userId, name, memberUserIds: parseMemberUserIds(newWorkspaceMembers) });
      const workspaceList = await api.listWorkspaces(userId);
      setWorkspaces(workspaceList);
      setSelectedWorkspaceId(workspace.id);
      setNewWorkspaceName('');
      setNewWorkspaceMembers('');
      setWorkspaceModalOpen(false);
      setArticle(undefined);
      setLastRun(undefined);
      setSelectedBlockId(undefined);
      setSelectedOutlineId(undefined);
      setLiveEvents([]);
      setProgressVisible(false);
      setArticleSummaries([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
  async function deleteWorkspace() {
    if (!selectedWorkspace || !canDeleteWorkspace) return;
    if (!window.confirm(`删除工作台「${selectedWorkspace.name}」？`)) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.deleteWorkspace(selectedWorkspace.id, userId);
      const workspaceList = await api.listWorkspaces(userId);
      const nextWorkspace = workspaceList.find((workspace) => workspace.isDefault) ?? workspaceList[0];
      setWorkspaces(workspaceList);
      setSelectedWorkspaceId(nextWorkspace?.id);
      setArticle(undefined);
      setLastRun(undefined);
      setSelectedBlockId(undefined);
      setSelectedOutlineId(undefined);
      setLiveEvents([]);
      setProgressVisible(false);
      if (nextWorkspace) await refreshArticleSummaries(nextWorkspace.id);
      else setArticleSummaries([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
  function openWorkspaceModal() {
    setNewWorkspaceName('');
    setNewWorkspaceMembers('');
    setWorkspaceModalOpen(true);
  }
  async function saveOutlineEdit() {
    if (!visibleArticle || !editingOutline) return;
    setBusy(true);
    setError(undefined);
    try {
      const updated = await api.updateOutlineItem(visibleArticle.id, editingOutline.id, { title: editingOutline.title, goal: editingOutline.goal, userId });
      setArticle(updated);
      setEditingOutline(undefined);
      await refreshArticleSummaries();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
  async function submitTaskCardMessage() {
    const message = activeTaskCardMessage.trim();
    if (!message) return;
    if (!article?.taskCard || taskCardDialogTarget === 'new') {
      const response = await execute(() => api.startTaskCard(message, userId, sessionId, selectedWorkspaceId, currentDomainProfileSelection(), currentWritingStandardSelection()));
      if (response?.article) {
        setNewTaskMessage('');
        setCurrentTaskMessage('');
        setTaskCardTarget('current');
      }
      return;
    }
    if (visibleArticle && selectedBlock) {
      const response = await execute(() => api.startPatch(visibleArticle.id, selectedBlock.id, contextualizeDialogInstruction(message, dialogContext), userId, sessionId));
      if (response) setCurrentTaskMessage('');
      return;
    }
    if (visibleArticle && selectedOutline) {
      await reviseOutlineItem(contextualizeDialogInstruction(message, dialogContext));
      return;
    }
    await reviseTaskCard(contextualizeDialogInstruction(message, dialogContext));
  }
  function submitTaskCardMessageWithKeyboard(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.nativeEvent.isComposing || busy || !canSubmitTaskCardMessage) return;
    event.preventDefault();
    void submitTaskCardMessage();
  }
  function chooseTaskCardPromptOption(prompt: TaskCardFollowUpPrompt, option: string) {
    setCurrentTaskMessage((current) => appendPromptAnswer(current, prompt.question, option));
  }
  async function reviseTaskCard(instruction: string) {
    if (!article?.taskCard || !instruction.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      const response = await api.reviseTaskCard(article.id, { instruction, userId, sessionId });
      setArticle(response.article);
      setCurrentTaskMessage('');
      if (response.article.taskCard?.status === 'confirmed') setLastRun(undefined);
      await refreshArticleSummaries();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
  async function reviseOutlineItem(instruction: string) {
    if (!visibleArticle || !selectedOutline || !instruction.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      const response = await api.reviseOutlineItem(visibleArticle.id, selectedOutline.id, { instruction, userId, sessionId });
      setArticle(response.article);
      setCurrentTaskMessage('');
      await refreshArticleSummaries(response.article.workspaceId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
  async function confirmTaskCard() {
    if (!visibleArticle?.taskCard) return;
    if (taskCardConfirmationRunId) {
      await execute(() => api.resume(taskCardConfirmationRunId, { decision: 'confirm' }));
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const updated = await api.confirmTaskCard(visibleArticle.id, { userId, sessionId });
      setArticle(updated);
      setLastRun(undefined);
      await refreshArticleSummaries(updated.workspaceId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
  async function confirmOutline() {
    if (!visibleArticle?.outline.length) return;
    if (outlineConfirmationRunId) {
      await execute(() => api.resume(outlineConfirmationRunId, { decision: 'confirm' }));
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const updated = await api.confirmOutline(visibleArticle.id, { userId, sessionId });
      setArticle(updated);
      setLastRun(undefined);
      await refreshArticleSummaries(updated.workspaceId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar"><div><strong>Writing Assistant</strong><span className="muted">任务卡 · 大纲 · 正文 · 局部修改</span></div><div className="status">{busy ? `执行中：${status}` : status}</div></header>
      {error && <div className="error">{error}</div>}
      <main className={['workspace', navigationCollapsed ? 'nav-collapsed' : '', taskCardConfirmed ? '' : 'task-card-column-hidden', outlineGenerated ? 'support-column-visible' : '', outlineGenerated && supportColumnCollapsed ? 'support-column-collapsed' : ''].filter(Boolean).join(' ')}>
        <aside className={navigationCollapsed ? 'panel navigation-panel collapsed' : 'panel navigation-panel'} role={navigationCollapsed ? 'button' : undefined} tabIndex={navigationCollapsed && !busy ? 0 : undefined} aria-label={navigationCollapsed ? '展开左栏' : undefined} aria-disabled={navigationCollapsed && busy ? true : undefined} onClick={navigationCollapsed && !busy ? () => updateNavigationCollapsed(false) : undefined} onKeyDown={navigationCollapsed ? (event) => { if (!busy && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); updateNavigationCollapsed(false); } } : undefined}>
          {navigationCollapsed ? <span className="column-collapse-handle" aria-hidden="true">{'>'}</span> : <>
            <div className="workspace-head">
              <h2>工作台</h2>
              <div className="workspace-actions">
                <button aria-label="新建工作台" className="icon-button" disabled={busy} title="新建工作台" onClick={openWorkspaceModal}>+</button>
                <button aria-label="删除当前工作台" className="icon-button danger" disabled={busy || !canDeleteWorkspace} title={selectedWorkspace?.isDefault ? '默认工作台不可删除' : '删除当前工作台'} onClick={() => void deleteWorkspace()}>×</button>
              </div>
            </div>
            <div className="workspace-controls">
              <select value={selectedWorkspaceId ?? ''} disabled={busy || !workspaces.length} onChange={(event) => void selectWorkspace(event.target.value)}>{workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select>
              {selectedWorkspace && <div className="workspace-meta">{selectedWorkspace.isDefault ? '默认工作台' : '自定义工作台'} · {selectedWorkspace.userId === userId ? '拥有者' : '协作者'} · {selectedWorkspace.memberUserIds.length} 个协作者</div>}
              <button aria-label="收起左栏" className="column-collapse-handle" disabled={busy} title="收起左栏" onClick={() => updateNavigationCollapsed(true)}>&lt;</button>
            </div>
            <div className="task-list-head">
              <h2>任务</h2>
              <button aria-label="创建新任务" className="icon-button task-create-button" disabled={busy || !selectedWorkspaceId} title="创建新任务" onClick={openNewTaskPage}>+</button>
            </div>
            <div className="history-list">{articleSummaries.length ? articleSummaries.map((item) => <div className={visibleArticle?.id === item.id ? 'history-row active' : 'history-row'} key={item.id}><button className="history-item" disabled={busy} onClick={() => void openArticle(item.id)}><strong>{item.title}</strong><span>{taskStatusLabel(item.taskStatus)} · {item.outlineCount}纲 · {item.blockCount}节</span><span>{new Date(item.updatedAt).toLocaleString()}</span></button><button aria-label={`删除 ${item.title}`} className="history-delete" disabled={busy} title="删除任务" onClick={() => void deleteArticle(item.id)}>×</button></div>) : <div className="empty">当前工作台暂无任务。</div>}</div>
          </>}
        </aside>
        {taskCardConfirmed ? <aside className={dialogContext.kind === 'task-card' ? 'panel task-card-panel selected' : 'panel task-card-panel'} onClick={() => { setTaskCardTarget('current'); setSelectedBlockId(undefined); setSelectedOutlineId(undefined); }}>
          <h2>任务卡</h2>
          {visibleArticle.taskCard ? <TaskCardView taskCard={visibleArticle.taskCard} /> : null}
          {visibleArticle && canGenerateOutline && <button disabled={busy} onClick={() => execute(() => api.startOutline(visibleArticle.id, userId, sessionId))}>{visibleArticle.outline.length ? '重新生成大纲' : '生成大纲'}</button>}
          {canConfirmOutline ? <button disabled={busy} onClick={() => void confirmOutline()}>确认大纲</button> : null}
        </aside> : null}
        <section className="panel editor-panel">
          <div className="editor-scroll-content">
          {taskCardDraft && visibleArticle?.taskCard ? <section className="draft-task-card-main"><div className="draft-task-card-head"><h2>任务卡草稿</h2><button disabled={busy} onClick={() => void confirmTaskCard()}>确认任务卡</button></div><TaskCardView taskCard={visibleArticle.taskCard} /></section> : null}
          {visibleArticle?.outline.length ? <div className="outline"><h3>大纲</h3>{visibleArticle.outline.map((item) => {
            const isEditing = editingOutline?.id === item.id;
            const sectionBlocks = visibleArticle.blocks.filter((block) => block.sectionId === item.id);
            const outlineCollapsed = !isEditing && collapsedOutlineIds.includes(item.id);
            const outlineSelected = selectedOutlineId === item.id || isEditing;
            return (
              <div className={['outline-item', outlineCollapsed ? 'collapsed' : '', outlineSelected ? 'selected' : ''].filter(Boolean).join(' ')} key={item.id} onClick={() => { setSelectedOutlineId(item.id); setSelectedBlockId(undefined); }}>
                {isEditing ? <div className="outline-edit"><input value={editingOutline.title} onChange={(event) => setEditingOutline({ ...editingOutline, title: event.target.value })} /><textarea value={editingOutline.goal} onChange={(event) => setEditingOutline({ ...editingOutline, goal: event.target.value })} /></div> : <div className="outline-main"><div className="outline-heading"><button type="button" className="collapse-button" aria-label={outlineCollapsed ? `展开 ${item.title}` : `折叠 ${item.title}`} title={outlineCollapsed ? '展开' : '折叠'} onClick={(event) => { event.stopPropagation(); setSelectedOutlineId(item.id); toggleOutlineCollapsed(item.id); }}>{outlineCollapsed ? '>' : 'v'}</button><div className="outline-title"><strong>{item.title}</strong><span>{outlineStatusLabel(item.status)}{sectionBlocks.length ? ` · ${sectionBlocks.length} 段正文` : ''}</span></div></div>{outlineCollapsed ? null : <p>{item.goal}</p>}</div>}
                <OutlineActionBar isEditing={isEditing} busy={busy} canSave={Boolean(editingOutline?.title.trim() && editingOutline.goal.trim())} hasSectionBlocks={Boolean(sectionBlocks.length)} onSave={() => void saveOutlineEdit()} onCancel={() => setEditingOutline(undefined)} onEdit={() => { setSelectedOutlineId(item.id); setEditingOutline({ id: item.id, title: item.title, goal: item.goal }); }} onGenerate={() => void startSectionGeneration(item.id)} />
                {!outlineCollapsed && progressVisible && sectionGeneration?.sectionId === item.id ? <GenerationProgressView progress={sectionGeneration} events={liveEvents} /> : null}
                {!outlineCollapsed && sectionBlocks.length ? <SectionBlocksView blocks={sectionBlocks} selectedBlockId={selectedBlockId} collapsedBlockIds={collapsedBlockIds} onSelectBlock={(blockId) => { setSelectedBlockId(blockId); setSelectedOutlineId(undefined); }} onToggleBlockCollapse={toggleBlockCollapsed} /> : null}
              </div>
            );
          })}</div> : null}
          <div className="article-blocks">{unassignedBlocks.map((block) => <ArticleBlockView key={block.id} block={block} selected={block.id === selectedBlockId} collapsed={collapsedBlockIds.includes(block.id)} onSelect={() => { setSelectedBlockId(block.id); setSelectedOutlineId(undefined); }} onToggleCollapse={() => toggleBlockCollapsed(block.id)} />)}</div>
          {!outlineGenerated ? <div className="editor-support">
            {hasWritingBlocks ? <KnowledgeTagsCard selectedBlock={selectedBlock} /> : null}
            <RevisionLogCard article={visibleArticle} />
            {visibleArticle && progressVisible ? <section className="support-card"><h3>执行进度</h3><ProgressTimeline events={liveEvents} run={lastRun?.run} /></section> : null}
          </div> : null}
          {outlineGenerated && visibleArticle && progressVisible ? <div className="editor-progress-support"><section className="support-card"><h3>执行进度</h3><ProgressTimeline events={liveEvents} run={lastRun?.run} /></section></div> : null}
          </div>
          <div className="task-dialog-panel">
            {taskCardDialogTarget === 'current' && taskCardFollowUpPrompts.length ? <TaskCardGuidance prompts={taskCardFollowUpPrompts} onChooseOption={chooseTaskCardPromptOption} /> : null}
            {taskCardDialogTarget === 'new' ? <NewTaskGuidance writingStandard={writingStandard} selectedLanguageEra={selectedLanguageEra} onSelectLanguageEra={setSelectedLanguageEra} domainProfiles={domainProfiles} recommendations={domainProfileRecommendations} selectedProfileId={selectedProfileId} selections={profileSelections} onSelectProfile={selectProfile} onUpdateGroup={updateProfileGroup} /> : null}
            <DialogContextView context={dialogContext} />
            <div className="task-dialog-input-row">
              <textarea value={activeTaskCardMessage} onChange={(event) => setActiveTaskCardMessage(event.target.value)} onKeyDown={submitTaskCardMessageWithKeyboard} placeholder={dialogPlaceholder(dialogContext)} />
              <button className={busy ? 'send-button processing' : 'send-button'} aria-label={busy ? '处理中' : '发送'} aria-busy={busy ? true : undefined} title={busy ? '处理中' : '发送'} disabled={busy || !canSubmitTaskCardMessage} onClick={() => void submitTaskCardMessage()}>↑</button>
            </div>
          </div>
        </section>
        {outlineGenerated ? <aside className={supportColumnCollapsed ? 'panel right-support-panel collapsed' : 'panel right-support-panel'} role={supportColumnCollapsed ? 'button' : undefined} tabIndex={supportColumnCollapsed && !busy ? 0 : undefined} aria-label={supportColumnCollapsed ? '展开辅助列' : undefined} aria-disabled={supportColumnCollapsed && busy ? true : undefined} onClick={supportColumnCollapsed && !busy ? () => updateSupportColumnCollapsed(false) : undefined} onKeyDown={supportColumnCollapsed ? (event) => { if (!busy && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); updateSupportColumnCollapsed(false); } } : undefined}>
          {supportColumnCollapsed ? <span className="right-column-collapse-handle" aria-hidden="true">{'<'}</span> : <>
            <div className="right-support-head">
              <h2>辅助</h2>
              <button aria-label="收起辅助列" className="right-column-collapse-handle" disabled={busy} title="收起辅助列" onClick={() => updateSupportColumnCollapsed(true)}>&gt;</button>
            </div>
            <div className="right-support-content">
              {hasWritingBlocks ? <KnowledgeTagsCard selectedBlock={selectedBlock} /> : null}
              <RevisionLogCard article={visibleArticle} />
            </div>
          </>}
        </aside> : null}
      </main>
      {visibleArticle && selectedBlockId ? <footer className="chatbar"><div className="patch-box"><strong>局部修改</strong><input value={patchInstruction} onChange={(event) => setPatchInstruction(event.target.value)} placeholder="输入对选中段落的修改意见" /><button disabled={busy} onClick={() => execute(() => api.startPatch(visibleArticle.id, selectedBlockId, patchInstruction, userId, sessionId))}>生成 Patch</button>{lastRun?.run.status === 'waiting' && lastRun.run.waitingFor?.nodeId === 'wait-patch-confirm' && <button onClick={() => execute(() => api.resume(lastRun.run.id, { decision: 'accept' }))}>应用 Patch</button>}</div>{patchPreview && <div className="patch-preview"><strong>Patch 预览</strong><div className="diff-grid"><pre>{patchPreview.before}</pre><pre>{patchPreview.after}</pre></div><ul>{patchPreview.changeSummary.map((item) => <li key={item}>{item}</li>)}</ul></div>}</footer> : null}
      {workspaceModalOpen && <div className="modal-backdrop" role="presentation"><div className="modal" role="dialog" aria-modal="true" aria-labelledby="workspace-modal-title"><div className="modal-head"><h2 id="workspace-modal-title">新建工作台</h2><button aria-label="关闭" className="icon-button" disabled={busy} onClick={() => setWorkspaceModalOpen(false)}>×</button></div><div className="modal-body"><label>名称</label><input value={newWorkspaceName} autoFocus onChange={(event) => setNewWorkspaceName(event.target.value)} placeholder="新工作台名称" /><label>协作者</label><input value={newWorkspaceMembers} onChange={(event) => setNewWorkspaceMembers(event.target.value)} placeholder="协作者 userId，用逗号分隔" /></div><div className="modal-actions"><button className="secondary-button" disabled={busy} onClick={() => setWorkspaceModalOpen(false)}>取消</button><button disabled={busy || !newWorkspaceName.trim()} onClick={() => void createWorkspace()}>创建</button></div></div></div>}
    </div>
  );
}
function ArticleBlockView(props: { block: ArticleBlock; selected: boolean; collapsed: boolean; onSelect: () => void; onToggleCollapse: () => void }) {
  return <article className={['block', props.selected ? 'selected' : '', props.collapsed ? 'collapsed' : ''].filter(Boolean).join(' ')} onClick={props.onSelect}><div className="block-head"><button type="button" className="collapse-button" aria-label={props.collapsed ? `展开 ${props.block.title}` : `折叠 ${props.block.title}`} title={props.collapsed ? '展开' : '折叠'} onClick={(event) => { event.stopPropagation(); props.onToggleCollapse(); }}>{props.collapsed ? '>' : 'v'}</button><h3>{props.block.title}</h3><span>{props.block.text.length} 字</span></div>{props.collapsed ? null : <pre>{props.block.text}</pre>}</article>;
}

function SectionBlocksView(props: { blocks: ArticleBlock[]; selectedBlockId?: string; collapsedBlockIds: string[]; onSelectBlock: (blockId: string) => void; onToggleBlockCollapse: (blockId: string) => void }) {
  const totalLength = props.blocks.reduce((sum, block) => sum + block.text.length, 0);
  return (
    <div className="section-blocks">
      <div className="section-blocks-head"><span>{props.blocks.length} 段正文</span><span>{totalLength} 字</span></div>
      {props.blocks.map((block, index) => {
        const collapsed = props.collapsedBlockIds.includes(block.id);
        return <article className={['section-paragraph', props.selectedBlockId === block.id ? 'selected' : '', collapsed ? 'collapsed' : ''].filter(Boolean).join(' ')} key={block.id} onClick={() => props.onSelectBlock(block.id)}><div className="paragraph-head"><button type="button" className="collapse-button" aria-label={collapsed ? `展开第 ${index + 1} 段` : `折叠第 ${index + 1} 段`} title={collapsed ? '展开' : '折叠'} onClick={(event) => { event.stopPropagation(); props.onToggleBlockCollapse(block.id); }}>{collapsed ? '>' : 'v'}</button><span>第 {index + 1} 段</span><span>{block.text.length} 字</span></div>{collapsed ? null : <pre>{block.text}</pre>}</article>;
      })}
    </div>
  );
}

function TaskCardGuidance(props: { prompts: TaskCardFollowUpPrompt[]; onChooseOption: (prompt: TaskCardFollowUpPrompt, option: string) => void }) {
  return (
    <div className="task-guidance">
      <div className="task-guidance-head"><strong>待确认项</strong><span>{props.prompts.length} 项</span></div>
      {props.prompts.map((prompt) => <div className="task-guidance-item" key={prompt.id}>
        <div className="task-guidance-question">{prompt.question}</div>
        {prompt.options.length ? <div className="task-guidance-options">{prompt.options.map((option) => <button type="button" className="task-guidance-option" key={option} onClick={() => props.onChooseOption(prompt, option)}>{option}</button>)}</div> : null}
      </div>)}
    </div>
  );
}

function DialogContextView(props: { context: DialogContext }) {
  return (
    <div className={`dialog-context context-${props.context.kind}`}>
      <span>{props.context.label}</span>
      <strong>{props.context.title}</strong>
    </div>
  );
}

function NewTaskGuidance(props: {
  writingStandard?: WritingStandardSummary;
  selectedLanguageEra: string;
  onSelectLanguageEra: (languageEra: string) => void;
  domainProfiles: DomainProfileSummary[];
  recommendations: DomainProfileRecommendation[];
  selectedProfileId?: string;
  selections: Record<string, string | string[]>;
  onSelectProfile: (profileId: string) => void;
  onUpdateGroup: (groupId: string, value: string | string[]) => void;
}) {
  if (!props.writingStandard && !props.domainProfiles.length) return null;
  return (
    <div className="task-guidance task-settings-guidance">
      <div className="task-guidance-head"><strong>待确认项</strong><span>新任务设置</span></div>
      {props.writingStandard ? <div className="task-guidance-item"><WritingStandardControls standard={props.writingStandard} selectedLanguageEra={props.selectedLanguageEra} onSelectLanguageEra={props.onSelectLanguageEra} /></div> : null}
      {props.domainProfiles.length ? <div className="task-guidance-item"><DomainProfileControls profiles={props.domainProfiles} recommendations={props.recommendations} selectedProfileId={props.selectedProfileId} selections={props.selections} onSelectProfile={props.onSelectProfile} onUpdateGroup={props.onUpdateGroup} /></div> : null}
    </div>
  );
}

function OutlineActionBar(props: { isEditing: boolean; busy: boolean; canSave: boolean; hasSectionBlocks: boolean; onSave: () => void; onCancel: () => void; onEdit: () => void; onGenerate: () => void }) {
  if (props.isEditing) {
    return (
      <div className="outline-toolbar editing" onClick={(event) => event.stopPropagation()}>
        <button type="button" className="outline-tool primary" disabled={props.busy || !props.canSave} onClick={props.onSave}><span aria-hidden="true">✓</span>保存</button>
        <button type="button" className="outline-tool" disabled={props.busy} onClick={props.onCancel}><span aria-hidden="true">×</span>取消</button>
      </div>
    );
  }
  return (
    <div className="outline-toolbar" onClick={(event) => event.stopPropagation()}>
      <button type="button" className="outline-tool" disabled={props.busy} onClick={props.onEdit}><span aria-hidden="true">✎</span>修改</button>
      <button type="button" className="outline-tool" disabled title="需要接入大纲扩写流程"><span aria-hidden="true">↗</span>扩写</button>
      <button type="button" className="outline-tool" disabled title="需要接入大纲压缩流程"><span aria-hidden="true">▣</span>压缩</button>
      <button type="button" className="outline-tool" disabled title="需要接入解释流程"><span aria-hidden="true">＋</span>解释</button>
      <button type="button" className="outline-tool" disabled={props.busy || !props.hasSectionBlocks} title={props.hasSectionBlocks ? '重新生成本节' : '本节生成后可重写'} onClick={props.onGenerate}><span aria-hidden="true">↻</span>重写</button>
      <button type="button" className="outline-tool" disabled={props.busy || props.hasSectionBlocks} title={props.hasSectionBlocks ? '续写流程尚未接入' : '生成本节'} onClick={props.onGenerate}><span aria-hidden="true">▷</span>{props.hasSectionBlocks ? '继续' : '生成'}</button>
      <button type="button" className="outline-tool" disabled title="更多操作稍后接入"><span aria-hidden="true">…</span>更多</button>
    </div>
  );
}

function GenerationProgressView(props: { progress: SectionGenerationState; events: AgentEvent[] }) {
  const stage = sectionGenerationStage(props.progress, props.events);
  return (
    <div className={`generation-progress ${stage.tone}`}>
      <div className="generation-progress-head">
        <strong>{stage.title}</strong>
        <span>{stage.detail}</span>
      </div>
      <div className="generation-progress-bar" aria-hidden="true"><span style={{ width: `${stage.percent}%` }} /></div>
    </div>
  );
}

function RevisionLogView(props: { article?: ArticleArtifact }) {
  const versions = props.article?.versions.slice().reverse().slice(0, 6) ?? [];
  if (!versions.length) return <div className="empty">暂无修订记录。</div>;
  return (
    <div className="versions">
      {versions.map((version) => <div className="version-item" key={version.id}><strong>{revisionReasonLabel(version.reason, props.article)}</strong><span>{revisionAuthorLabel(version.author)} · {new Date(version.createdAt).toLocaleString()}</span></div>)}
    </div>
  );
}

function KnowledgeTagsCard(props: { selectedBlock?: ArticleBlock }) {
  return (
    <section className="support-card">
      <h3>知识 / 引用 / 标签</h3>
      {props.selectedBlock ? <div>
        <p className="mono">{props.selectedBlock.id}</p>
        <h4>引用来源</h4>
        {props.selectedBlock.sourceRefs.length ? props.selectedBlock.sourceRefs.map((ref) => <span className="tag" key={ref}>{ref}</span>) : <div className="empty">暂无引用绑定</div>}
        <h4>主题标签</h4>
        {props.selectedBlock.themeTags.length ? props.selectedBlock.themeTags.map((tag) => <span className="tag" key={tag}>{tag}</span>) : <div className="empty">暂无主题标签。</div>}
      </div> : <div className="empty">选择一个段落后显示对应来源和标签。</div>}
    </section>
  );
}

function RevisionLogCard(props: { article?: ArticleArtifact }) {
  return <section className="support-card"><h3>修订日志</h3><RevisionLogView article={props.article} /></section>;
}

function ProgressTimeline(props: { events: AgentEvent[]; run?: WorkflowRun }) {
  const items = friendlyProgressEvents(props.events, props.run);
  if (!items.length) return <div className="empty">暂无执行进度。</div>;
  return (
    <div className="progress-timeline">
      {items.map((item) => <div className="progress-item" key={item.id}><strong>{item.label}</strong><span>{new Date(item.createdAt).toLocaleTimeString()}</span></div>)}
    </div>
  );
}

function WritingStandardControls(props: { standard: WritingStandardSummary; selectedLanguageEra: string; onSelectLanguageEra: (languageEra: string) => void }) {
  return (
    <div className="writing-standard-controls">
      <div className="profile-header"><strong>写作标准</strong><span className="rule-count">已应用</span></div>
      <div className="writing-standard-label">{props.standard.label}</div>
      <div className="language-era-segmented" role="radiogroup" aria-label={props.standard.label}>
        {props.standard.options.map((option) => {
          const selected = props.selectedLanguageEra === option.id;
          return <button type="button" role="radio" aria-checked={selected} className={selected ? 'language-era-option active' : 'language-era-option'} key={option.id} onClick={() => props.onSelectLanguageEra(option.id)}><strong>{option.label}</strong><small>{option.description}</small></button>;
        })}
      </div>
    </div>
  );
}

function DomainProfileControls(props: { profiles: DomainProfileSummary[]; recommendations: DomainProfileRecommendation[]; selectedProfileId?: string; selections: Record<string, string | string[]>; onSelectProfile: (profileId: string) => void; onUpdateGroup: (groupId: string, value: string | string[]) => void }) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const profile = props.profiles.find((item) => item.id === props.selectedProfileId);
  const recommendation = props.recommendations.find((item) => item.id !== props.selectedProfileId);
  const showPicker = pickerOpen || (!profile && !recommendation);
  function chooseProfile(profileId: string) {
    props.onSelectProfile(profileId);
    setPickerOpen(false);
  }
  return (
    <div className="profile-controls">
      <div className="profile-header"><strong>题材标准</strong><div className="profile-summary">{profile ? <span className="profile-pill active">{profile.label}</span> : recommendation ? <button type="button" className="profile-recommendation" onClick={() => chooseProfile(recommendation.id)}>推荐：{recommendation.label}</button> : <span className="profile-pill">未应用</span>}<button type="button" className="secondary-button compact" onClick={() => setPickerOpen((current) => !current)}>{pickerOpen ? '收起' : '更换'}</button></div></div>
      {showPicker ? <select className="profile-select" value={props.selectedProfileId ?? ''} onChange={(event) => chooseProfile(event.target.value)}><option value="">不使用题材标准</option>{props.profiles.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select> : null}
      {profile?.groups.map((group) => <div className="profile-group" key={group.id}><span>{group.label}</span>{group.type === 'single' ? <select value={singleSelection(props.selections[group.id])} onChange={(event) => props.onUpdateGroup(group.id, event.target.value)}>{group.options.map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}</select> : <div className="profile-options">{group.options.map((option) => {
        const checked = multiSelection(props.selections[group.id]).includes(option.id);
        return <label key={option.id}><input type="checkbox" checked={checked} onChange={(event) => props.onUpdateGroup(group.id, toggleSelection(multiSelection(props.selections[group.id]), option.id, event.target.checked))} />{option.label}</label>;
      })}</div>}</div>)}
    </div>
  );
}

function TaskCardView(props: { taskCard: WritingTaskCard }) {
  const card = props.taskCard;
  return (
    <div className="task-card">
      <TaskCardField label="主题" value={card.topic} />
      <TaskCardField label="目标" value={card.writingGoal} />
      <WritingStandardTaskCardView taskCard={card} />
      <TaskCardField label="读者" value={card.audience} />
      <TaskCardField label="范围" value={displayScope(card)} />
      <TaskCardField label="结构" value={displayStructure(card)} />
      <TaskCardField label="风格" value={displayStyle(card)} />
      <div className="task-card-section">
        <div className="task-card-label">约束</div>
        <TaskCardList title="必须包含" items={card.constraints.mustInclude} />
        <TaskCardList title="避免" items={card.constraints.mustAvoid} />
        <TaskCardField label="引用" value={card.constraints.citationRequired ? '需要可追溯引用' : '不强制引用'} compact />
        <TaskCardField label="来源策略" value={card.constraints.sourcePolicy} compact />
      </div>
    </div>
  );
}

function TaskCardField(props: { label: string; value?: string; compact?: boolean }) {
  if (!props.value?.trim()) return null;
  return <div className={props.compact ? 'task-card-field compact' : 'task-card-field'}><div className="task-card-label">{props.label}</div><div className="task-card-value">{props.value}</div></div>;
}

function TaskCardList(props: { title: string; items: string[] }) {
  const items = props.items.filter((item) => item.trim());
  if (!items.length) return null;
  return <div className="task-card-list"><div className="task-card-subtitle">{props.title}</div><ul>{items.map((item) => <li key={item}>{item}</li>)}</ul></div>;
}

function WritingStandardTaskCardView(props: { taskCard: WritingTaskCard }) {
  const languageEra = props.taskCard.topRules?.languageEra?.trim();
  const summary = props.taskCard.topRules?.summary?.trim();
  if (!languageEra && !summary) return null;
  return <TaskCardField label="写作标准" value={[languageEra, summary].filter(Boolean).join('：')} />;
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

function articleTypeLabel(value: string): string {
  const labels: Record<string, string> = { essay: '随笔', analysis: '赏析/分析', commentary: '评论', speech: '演讲稿', longform: '长文' };
  return labels[value] ?? value;
}

function outlineStatusLabel(value: string): string {
  const labels: Record<string, string> = { draft: '待确认', confirmed: '已确认', written: '已写作' };
  return labels[value] ?? value;
}

function taskStatusLabel(value?: string): string {
  const labels: Record<string, string> = { draft: '任务卡草稿', confirmed: '任务卡已确认' };
  return value ? labels[value] ?? value : '未生成任务卡';
}

function runStatusLabel(run: WorkflowRun, events: AgentEvent[]): string {
  if (run.status === 'failed') return '处理失败';
  if (run.status === 'waiting') return '等待确认';
  if (run.status === 'completed') return '处理完成';
  if (run.status === 'queued') return '等待处理';
  const latest = friendlyProgressEvents(events, run).at(-1);
  return latest?.label ?? '处理中';
}

function sectionGenerationStage(progress: SectionGenerationState, events: AgentEvent[]): { title: string; detail: string; percent: number; tone: 'active' | 'done' | 'failed' } {
  if (progress.status === 'failed') return { title: '生成未保存', detail: userFacingRunError(progress.error), percent: 100, tone: 'failed' };
  if (progress.status === 'completed') return { title: '已保存本节', detail: '正文已经写入当前章节。', percent: 100, tone: 'done' };
  if (progress.status === 'queued') return { title: '等待开始', detail: '请求已提交，正在等待处理。', percent: 18, tone: 'active' };
  if (progress.status === 'starting') return { title: '准备生成', detail: '正在提交生成请求。', percent: 12, tone: 'active' };
  if (hasFriendlyEvent(events, 'artifact.updated', 'section-written')) return { title: '正在保存', detail: '正文已生成，正在写入文章。', percent: 92, tone: 'active' };
  if (hasFriendlyEvent(events, 'skill.completed', 'section-writer')) return { title: '正在整理', detail: '正文草稿已生成，正在整理结果。', percent: 76, tone: 'active' };
  if (hasFriendlyEvent(events, 'skill.started', 'section-writer')) return { title: '正在生成', detail: '正在根据任务卡、大纲和资料写作。', percent: 48, tone: 'active' };
  if (hasFriendlyEvent(events, 'rag.http.completed')) return { title: '正在生成', detail: '资料已准备，正在组织正文。', percent: 42, tone: 'active' };
  if (hasFriendlyEvent(events, 'rag.http.started')) return { title: '正在准备资料', detail: '正在查找可用资料。', percent: 30, tone: 'active' };
  return { title: '正在处理', detail: '正在推进生成流程。', percent: 24, tone: 'active' };
}

function friendlyProgressEvents(events: AgentEvent[], run?: WorkflowRun): Array<{ id: string; label: string; createdAt: string }> {
  const items = events
    .map((event) => ({ id: event.id, label: friendlyEventLabel(event), createdAt: event.createdAt }))
    .filter((item): item is { id: string; label: string; createdAt: string } => Boolean(item.label));
  if (!items.length && run) return [{ id: run.id, label: runStatusLabelFromStatus(run.status), createdAt: new Date().toISOString() }];
  return items.filter((item, index) => index === 0 || item.label !== items[index - 1].label).slice(-6);
}

function friendlyEventLabel(event: AgentEvent): string | undefined {
  const reason = typeof event.payload?.reason === 'string' ? event.payload.reason : undefined;
  const skillId = typeof event.payload?.skillId === 'string' ? event.payload.skillId : undefined;
  if (event.type === 'workflow.started') return '已收到请求';
  if (event.type === 'workflow.queued' || event.type === 'queue.enqueued') return '等待处理';
  if (event.type === 'queue.dequeued') return '开始处理';
  if (event.type === 'rag.http.started') return '正在查找资料';
  if (event.type === 'rag.http.completed') return '资料已准备';
  if (event.type === 'rag.http.failed') return '资料查找失败';
  if (event.type === 'skill.started') return skillProgressLabel(skillId, 'started');
  if (event.type === 'skill.completed') return skillProgressLabel(skillId, 'completed');
  if (event.type === 'artifact.updated') return artifactProgressLabel(reason);
  if (event.type === 'workflow.waiting' || event.type === 'review.required') return '等待确认';
  if (event.type === 'workflow.completed' || event.type === 'queue.completed') return '处理完成';
  if (event.type === 'workflow.failed' || event.type === 'queue.failed') return '处理失败';
  return undefined;
}

function skillProgressLabel(skillId: string | undefined, phase: 'started' | 'completed'): string {
  const labels: Record<string, [string, string]> = {
    'task-card-builder': ['正在整理任务卡', '任务卡草稿已生成'],
    'task-card-reviser': ['正在更新任务卡', '任务卡已更新'],
    'outline-planner': ['正在规划大纲', '大纲草稿已生成'],
    'section-writer': ['正在生成正文', '正文草稿已生成'],
    'patch-editor': ['正在准备修改', '修改建议已生成'],
  };
  const label = labels[skillId ?? ''];
  return label ? label[phase === 'started' ? 0 : 1] : (phase === 'started' ? '正在处理' : '处理已完成');
}

function artifactProgressLabel(reason: string | undefined): string {
  const labels: Record<string, string> = {
    'task-card-draft-created': '任务卡草稿已生成',
    'task-card-confirmed': '任务卡已确认',
    'task-card-revised': '任务卡已更新',
    'outline-draft-created': '大纲草稿已生成',
    'outline-section-edited': '大纲已更新',
    'section-written': '正文已保存',
    'patch-applied': '修改已应用',
    'article-deleted': '任务已删除',
  };
  return labels[reason ?? ''] ?? '内容已更新';
}

function runStatusLabelFromStatus(status: WorkflowRun['status']): string {
  const labels: Record<WorkflowRun['status'], string> = { idle: '就绪', queued: '等待处理', running: '处理中', waiting: '等待确认', completed: '处理完成', failed: '处理失败', cancelled: '已取消' };
  return labels[status];
}

function hasFriendlyEvent(events: AgentEvent[], type: string, marker?: string): boolean {
  return events.some((event) => {
    if (event.type !== type) return false;
    if (!marker) return true;
    return event.payload?.reason === marker || event.payload?.skillId === marker;
  });
}

function userFacingRunError(message?: string): string {
  if (!message) return '生成失败，请调整后重试。';
  const avoided = message.match(/avoided terms:\s*([^.]*)/i);
  if (avoided?.[1]) return `生成内容包含任务卡中需要避免的词语（${avoided[1].trim()}），已阻止保存。`;
  if (message.includes('exceeded current section length budget')) return '生成内容超出本节字数限制，已阻止保存。';
  if (message.includes('quote-heavy prose')) return '生成内容引用比例过高，已阻止保存。';
  if (message.includes('reused too much source text')) return '生成内容过多复用了资料原文，已阻止保存。';
  return '生成失败，请调整任务卡或稍后重试。';
}

function readNavigationCollapsedPreference(): boolean {
  try {
    return window.localStorage.getItem(navigationCollapsedStorageKey) === 'true';
  } catch {
    return false;
  }
}

function readSupportColumnCollapsedPreference(): boolean {
  try {
    return window.localStorage.getItem(supportColumnCollapsedStorageKey) === 'true';
  } catch {
    return false;
  }
}

function revisionReasonLabel(reason: string, article?: ArticleArtifact): string {
  const sectionMatch = reason.match(/^生成章节[：:](.+)$/);
  if (sectionMatch) {
    const rawTarget = sectionMatch[1].trim();
    const sectionTitle = article?.outline.find((item) => item.id === rawTarget)?.title;
    const target = stripInternalIds(sectionTitle ?? rawTarget);
    return target ? `生成章节正文：${target}` : '生成章节正文';
  }
  return stripInternalIds(reason) || '更新文章';
}

function revisionAuthorLabel(value: string): string {
  const labels: Record<string, string> = { user: '用户', agent: '助手', system: '系统' };
  return labels[value] ?? '系统';
}

function stripInternalIds(value: string): string {
  return value
    .replace(/\b(?:sec|block|blk|art|task|ver|run|evt|wsp)[_-][a-z0-9_-]+\b/gi, '')
    .replace(/\s+/g, ' ')
    .replace(/[：:]\s*$/g, '')
    .trim();
}

function joinList(items?: string[]): string {
  return (items ?? []).filter((item) => item.trim().length > 0).join('、');
}

function defaultProfileSelections(profile: DomainProfileSummary): Record<string, string | string[]> {
  return Object.fromEntries(profile.groups.map((group) => {
    const defaults = group.options.filter((option) => option.defaultSelected).map((option) => option.id);
    if (group.type === 'single') return [group.id, defaults[0] ?? group.options[0]?.id ?? ''];
    return [group.id, defaults];
  }));
}

function taskCardPrompts(taskCard: WritingTaskCard): TaskCardFollowUpPrompt[] {
  const prompts = taskCard.interactionMode.followUpPrompts?.filter((prompt) => prompt.question.trim()) ?? [];
  if (prompts.length) return prompts;
  return (taskCard.interactionMode.followUpQuestions ?? []).filter((question) => question.trim()).slice(0, 3).map((question, index) => ({ id: `question-${index + 1}`, question, options: [], allowCustom: true }));
}

function buildDialogContext(target: TaskCardTarget, article?: ArticleArtifact, outline?: ArticleArtifact['outline'][number], block?: ArticleBlock): DialogContext {
  if (target === 'new' || !article?.taskCard) return { kind: 'new-task', label: '当前位置', title: '新任务', detail: '当前输入会用于创建新的任务卡。', contextText: '' };
  if (block) {
    return {
      kind: 'paragraph',
      label: '当前段落',
      title: block.title || block.id,
      detail: summarizeText(block.text, 90),
      contextText: formatParagraphContext(block),
    };
  }
  if (outline) {
    return {
      kind: 'outline',
      label: '当前大纲',
      title: outline.title,
      detail: summarizeText(outline.goal, 90),
      contextText: formatOutlineContext(outline),
    };
  }
  return {
    kind: 'task-card',
    label: '当前任务卡',
    title: article.taskCard.topic,
    detail: summarizeText(article.taskCard.writingGoal, 90),
    contextText: formatTaskCardContext(article.taskCard),
  };
}

function contextualizeDialogInstruction(instruction: string, context: DialogContext): string {
  if (context.kind === 'new-task') return instruction;
  return [`当前对话上下文：${context.label}`, `标题：${context.title}`, '完整上下文：', context.contextText || context.detail, '', `用户意见：${instruction}`].join('\n');
}

function appendPromptAnswer(current: string, question: string, answer: string): string {
  const line = `${question}：${answer}`;
  return current.trim() ? `${current.trim()}\n${line}` : line;
}

function dialogPlaceholder(context: DialogContext): string {
  if (context.kind === 'new-task') return '输入写作需求，创建新的任务卡。';
  if (context.kind === 'paragraph') return '对当前段落的修改意见';
  if (context.kind === 'outline') return '围绕当前大纲提出修改意见';
  return '对当前任务卡的修改意见';
}

function summarizeText(value: string, maxLength: number): string {
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) return '暂无摘要。';
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function formatTaskCardContext(taskCard: WritingTaskCard): string {
  return [
    `主题：${taskCard.topic}`,
    `写作目标：${taskCard.writingGoal}`,
    `读者：${taskCard.audience}`,
    `写作标准：${taskCard.topRules?.summary || joinList(taskCard.topRules?.writingStandards) || '未指定'}`,
    `范围：版本 ${joinList(taskCard.scope.editions) || '未指定'}；章节 ${joinList(taskCard.scope.chapters) || '未指定'}；人物 ${joinList(taskCard.scope.characters) || '未指定'}；主题 ${joinList(taskCard.scope.themes) || '未指定'}`,
    `结构：${taskCard.structure.articleType}；${taskCard.structure.expectedLength}${taskCard.structure.outlinePreference ? `；${taskCard.structure.outlinePreference}` : ''}`,
    `风格：${taskCard.style.register}；${taskCard.style.tone}${taskCard.style.characterVoice ? `；${taskCard.style.characterVoice}` : ''}`,
    `必须包含：${joinList(taskCard.constraints.mustInclude) || '无'}`,
    `必须避免：${joinList(taskCard.constraints.mustAvoid) || '无'}`,
    `来源策略：${taskCard.constraints.sourcePolicy}`,
  ].join('\n');
}

function formatOutlineContext(outline: ArticleArtifact['outline'][number]): string {
  return [
    `大纲标题：${outline.title}`,
    `写作目标：${outline.goal}`,
    `预计正文块数：${outline.expectedBlocks}`,
    `来源线索：${joinList(outline.sourceHints) || '无'}`,
    `主题标签：${joinList(outline.themeTags) || '无'}`,
    `状态：${outline.status}`,
  ].join('\n');
}

function formatParagraphContext(block: ArticleBlock): string {
  return [
    `段落标题：${block.title || block.id}`,
    `段落正文：${block.text}`,
    `引用来源：${joinList(block.sourceRefs) || '无'}`,
    `主题标签：${joinList(block.themeTags) || '无'}`,
    `状态：${block.status}`,
  ].join('\n');
}

function singleSelection(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function multiSelection(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

function toggleSelection(values: string[], value: string, checked: boolean): string[] {
  return checked ? [...new Set([...values, value])] : values.filter((item) => item !== value);
}

function toggleId(values: string[], value: string): string[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

function parseMemberUserIds(value: string): string[] {
  return [...new Set(value.split(/[,\s，、]+/).map((item) => item.trim()).filter(Boolean))];
}

function parseForbiddenTerms(value: string): string[] {
  return [...new Set(value.split(/[,\s，、/／;；]+/).map((item) => item.trim()).filter(Boolean))];
}
