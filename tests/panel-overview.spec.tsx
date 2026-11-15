// @vitest-environment jsdom
// The overview.
import { expect, it } from 'vitest'
import { en, zh } from '../src/client/locales.ts'
import { usePanel, mount, remount, all, find, tab, click, text } from './fixtures/panel.tsx'
import { server, droppedReply, threadSummary } from './fixtures/panel-server.ts'

usePanel()
it('leads the overview with the pending Tickets, then problems, the last day, the cost and the Executor, each linking to its stage', async () => {
  await mount()
  expect(tab(zh['tab.overview']).getAttribute('aria-selected')).toBe('true')
  expect(all('[role="tab"]').map(tab => tab.textContent)).toEqual(['概览', '来源', '触发', '评估', '执行', '设置'])
  expect(all('.dt-section-title').map(title => title.textContent)).toEqual(['待处理工单2', '系统问题2', '过去 24 小时详情 ›', '成本',
    '例行任务0', '待批准的操作0', '执行器详情 ›'])
  expect(all('.dt-cards .dt-ticket-stage').map(item => item.textContent)).toEqual(['待回答', '待处理失败'])
  expect(all('.dt-cards .dt-att-what').map(item => item.textContent)).toEqual(['飞书 来源异常', '评估未完成：这个文案好奇怪'])
  // Actions sit below the title and Threads, apart from the stage, each with its icon.
  expect(all('.dt-ticket').every(row => row.querySelector('.dt-ticket-stage button, .dt-ticket-stage a') === null
    && [...row.querySelectorAll('.dt-ticket-actions button, .dt-ticket-actions a')].every(action => action.querySelector('svg')))).toBe(true)
  expect(text()).toContain('来源会在每次轮询时自动重试')
  expect(text()).toContain('需要确认按钮颜色')
  expect(all('.dt-stat').map(stat => stat.textContent)).toEqual(['到达12', '被过滤2', '已评估5', '接单或续做1', '今日 token0',
    '缓存命中率0.0%', '估算花费¥0.0000', '执行中2 / 3', '排队0', '等待新触发1'])
  expect(all('.dt-chip').map(chip => chip.textContent)[0]).toBe('GitHub#42CI 失败1')
  expect(document.querySelector('.dt-chip-problem')?.textContent).toBe('CI 失败1')
  expect(document.querySelector<HTMLAnchorElement>('a.dt-chip-link')?.href).toBe('https://github.com/acme/widgets/pull/42')
  await click(all('.dt-more-link').at(-1)!)
  expect(tab(zh['tab.execution']).getAttribute('aria-selected')).toBe('true')
})

it('shows the commands stuck behind an approval card, with the rule and when the question lapses', async () => {
  server.approvals = [{ id: 'approval-1', ticketId: 'ticket-1', rule: 'force_push', command: 'git push --force origin main',
    state: 'pending', askedAt: '2026-11-15T03:00:00.000Z', expiresAt: '2026-11-15T03:10:00.000Z' }]
  await mount()
  const section = all('.dt-section').find(item => item.querySelector('.dt-section-title')?.textContent === '待批准的操作1')!
  expect(section.querySelector('.dt-row-meta.dt-mono')?.textContent).toBe('git push --force origin main')
  expect(section.textContent).toContain('规则：force_push')
  expect(section.textContent).toContain('有效期至')
})

it('shows how the closed questions ended, so a person can see that approvals are being answered, not only what waits', async () => {
  server.approvals = [
    { id: 'approval-1', ticketId: 'ticket-1', rule: 'force_push', command: 'git push --force origin main',
      state: 'pending', askedAt: '2026-11-15T03:00:00.000Z', expiresAt: '2026-11-15T03:10:00.000Z' },
    { id: 'approval-2', ticketId: 'ticket-2', rule: 'repo_delete', command: 'gh repo delete acme/widgets --yes',
      state: 'rejected', askedAt: '2026-11-15T02:00:00.000Z', expiresAt: '2026-11-15T02:10:00.000Z',
      decidedAt: '2026-11-15T02:01:00.000Z', decidedBy: 'ou_actor' },
    { id: 'approval-3', ticketId: 'ticket-3', rule: 'force_push', command: 'git push --force origin main',
      state: 'expired', askedAt: '2026-11-15T01:00:00.000Z', expiresAt: '2026-11-15T01:10:00.000Z' },
  ]
  await mount()
  const section = all('.dt-section').find(item => item.querySelector('.dt-section-name')?.textContent === '待批准的操作')!
  expect(section.textContent).toContain('已拒绝 1')
  expect(section.textContent).toContain('已过期 1')
})

it('answers a waiting approval from the panel, so a person without Feishu can still let the retry through', async () => {
  server.approvals = [{ id: 'approval-1', ticketId: 'ticket-1', rule: 'force_push', command: 'git push --force origin main',
    state: 'pending', askedAt: '2026-11-15T03:00:00.000Z', expiresAt: '2026-11-15T03:10:00.000Z' }]
  await mount()
  await click(zh.approve)
  expect(server.requests).toContainEqual({ path: 'approvals/approval-1/decide', method: 'POST', body: { answer: 'approve' } })
  expect(server.approvals?.[0]?.state).toBe('approved')
  // Answered questions are no longer waiting, so the section drops back to its empty state.
  expect(all('.dt-section-title').map(title => title.textContent)).toContain(`${zh.approvals}0`)
})

it('re-evaluates or dismisses an unjudged Eval from the problem list', async () => {
  await mount()
  await click(zh.requeue)
  expect(server.requests.some(request => request.path === 'triggers/e3/requeue' && request.method === 'POST')).toBe(true)
  await click(zh.dismiss)
  expect(server.requests.some(request => request.path === 'decisions/u1/dismiss' && request.method === 'POST')).toBe(true)
  expect(server.requests.filter(request => request.path === 'overview').length).toBeGreaterThan(2)
})

it('opens the Thread of an unjudged Eval at its Trigger from the problem list', async () => {
  await mount()
  await click('评估未完成：这个文案好奇怪')
  expect(server.requests.some(request => request.path.startsWith('threads/feishu:oc_1:om_root'))).toBe(true)
  expect(document.querySelector('.dt-highlight')?.textContent).toContain('message e3')
})

it('follows the last day\'s counts to the status of each stage', async () => {
  await mount()
  // Arrived Triggers include filtered ones, which have no Thread, so no list has that count to link to.
  expect(all('.dt-stat button').map(button => button.textContent)).toEqual(['2', '1'])
  await click(all('.dt-stat button')[0]!)
  expect(tab(zh['tab.source']).getAttribute('aria-selected')).toBe('true')
  await click(zh.sourceFilteredTitle)
  expect(text()).toContain('looks wrong')
  expect(text()).toContain(zh['reason.source_disabled'])
})

it('offers each Ticket that needs a person its actions on the overview: answer in its Channel, retry or open a failed worker, and stop',
  async () => {
  await mount()
  expect(all('.dt-ticket-actions a').map(link => [link.textContent, link.getAttribute('href')])).toEqual([['去飞书回答',
    'https://applink.feishu.cn/client/chat/open?openChatId=oc_1']])
  expect(all('.dt-ticket-note').map(note => note.textContent)).toContain('LlmError: no adapter registered for provider "provider-a"')
  await click(zh.retry)
  await click(zh.confirm)
  expect(server.requests.some(request => request.path === 'tickets/t4/retry' && request.method === 'POST')).toBe(true)
  await click(all('.dt-ticket-actions button').find(button => button.textContent === '打开 Session')!)
  expect(server.opened).toEqual(['worker-t4'])
  await click(all('.dt-ticket-actions button').filter(button => button.textContent === '停止').at(-1)!)
  await click(zh.confirm)
  expect(server.requests.some(request => request.path === 'tickets/t4/stop' && request.method === 'POST')).toBe(true)
  expect(text()).not.toContain('截图工具')
})

it('shows paused processing as a system problem with its resume action, and says so on the Policy records', async () => {
  server.settings = { ...server.settings, paused: true }
  await mount()
  expect(text()).toContain(zh.problemPaused)
  await click(zh['tab.eval'])
  expect(text()).toContain(zh.evalRecordsPaused)
  await click(zh.resumeWhere)
  expect(tab(zh['tab.execution']).getAttribute('aria-selected')).toBe('true')
  await click(zh['tab.overview'])
  await click(find(zh.resumeProcessing, '.dt-att button'))
  await click(zh.confirm)
  expect(server.requests.find(request => request.path === 'executor/pause')).toMatchObject({ method: 'POST', body: { paused: false } })
})

it('offers the step that fixes a settings problem as a button on the overview', async () => {
  server.settings = { ...server.settings, policy: { ...server.settings.policy, sources: { feishu: { allowed: [], admission: {} },
    github: { allowed: [], admission: {} } } } }
  await mount()
  expect(text()).toContain(zh.problemNoAllowed)
  await click(zh.actionAddAllowed)
  expect(tab(zh['tab.settings']).getAttribute('aria-selected')).toBe('true')
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(zh['term.eval'])
})

it('counts the messages not sent in the last day, linking to the Source status, and shows nothing when there are none', async () => {
  await mount()
  expect(all('.dt-stat-label').map(label => label.textContent)).not.toContain(zh.flowDroppedLabel)
  server.dropped = [droppedReply('m2', 1, 'feishu', 'channelGone'), droppedReply('m1', 2, 'github', 'channelIgnored'), droppedReply('m0',
    30, 'feishu', 'channelGone')]
  await remount()
  const stat = all('.dt-stat').find(item => item.querySelector('.dt-stat-label')?.textContent === zh.flowDroppedLabel)!
  expect(stat.textContent).toBe(`${zh.flowDroppedLabel}2`)
  await click(stat.querySelector('button')!)
  expect(tab(zh['tab.source'])?.getAttribute('aria-selected')).toBe('true')
})

it('reports the tokens today, the cache share and estimated cost, and says why the cache is not paying off', async () => {
  const today = { calls: 8, inputTokens: 100418, outputTokens: 21, cacheReadTokens: 43648, cacheWriteTokens: 0, reasoningTokens: 0,
    cacheHitRate: 0.3029, estimatedYuan: 0.604825 }
  const alert = '6.8% of prompt tokens came from cache over 8 requests: check that the prompt prefix stays stable.'
  const worker = { calls: 6, inputTokens: 90000, outputTokens: 21, cacheReadTokens: 40000, cacheWriteTokens: 0, reasoningTokens: 0,
    cacheHitRate: 0.3077, estimatedYuan: 0.594825 }
  server.usage = { today, last24Hours: today, alert, bySession: [{ sessionId: 'worker-abcdef123456', role: 'worker', totals: worker }] }
  await mount()
  const stat = (label: string) => all('.dt-stat').find(item => item.querySelector('.dt-stat-label')?.textContent === label)
  expect(stat(zh.costTokens)?.textContent).toBe(`${zh.costTokens}100,439`)
  expect(stat(zh.costHitRate)?.textContent).toBe(`${zh.costHitRate}30.3%`)
  expect(stat(zh.costEstimate)?.textContent).toBe(`${zh.costEstimate}¥0.6048`)
  expect(text()).toContain(alert)
  // The cost panel names the Session the money went to, not only the total it left.
  expect(text()).toContain(`${zh.costBySession} · worker-abcd`)
  expect(text()).toContain(zh.costSessionRow.replace('{role}', zh.costRoleWorker).replace('{calls}', '6')
    .replace('{hit}', '30.8%').replace('{yuan}', '0.5948'))
})

it('names a failing part of dsh-superagent itself by its label', async () => {
  server.health = { launch: { state: 'error', detail: 'spawn failed' }, relay: { state: 'ready', detail: 'Nothing waiting' } }
  await mount()
  expect(all('.dt-cards .dt-att-what').map(item => item.textContent)).toContain(zh.problemRuntime.replace('{name}', zh['health.launch']))
  expect(text()).toContain('spawn failed')
})

it('words a refused retry in the interface language by its code', async () => {
  await mount()
  // Simulate another user retrying the ticket after the overview loaded.
  server.person = server.person.map(ticket => ticket.id === 't4' ? { ...ticket, actions: { ...ticket.actions, retry: false } } : ticket)
  await click(find(zh.retry, '.dt-ticket-actions button'))
  await click(zh.confirm)
  expect(document.querySelector('.dt-toast')?.textContent).toBe(zh['userError.notRetryable'])
  expect(text()).not.toContain('Only an open ticket can be retried, and only when its worker last reported failed or blocked and no person has sent a message since, or when delivering an Input to its worker failed')
})

it('shows the overview in English', async () => {
  await mount(en)
  expect(all('.dt-section-title').map(title => title.textContent)).toEqual([`${en.pendingTickets}2`, `${en.problems}2`,
    `${en.lastDay}${en.details}`, en.cost, `${en.routines}0`, `${en.approvals}0`, `${en['term.executor']}${en.details}`])
  expect(all('.dt-cards .dt-ticket-stage').map(item => item.textContent)).toEqual([en['stage.answer'], en['stage.failed']])
  expect(all('.dt-stat-label').map(label => label.textContent)).toEqual([en.flowReceivedLabel, en.flowFilteredLabel, en.flowJudgedLabel,
    en.flowAcceptedLabel, en.costTokens, en.costHitRate, en.costEstimate, en.executingLabel, en.queuedLabel, en.idleLabel])
})

it('lists the unavailable Evals one by one, without the health entry that counts them as a failure of dsh-superagent', async () => {
  server.health.evals = { state: 'error', detail: '1 Eval(s) unavailable in the last hour without a later judgement' }
  await mount()
  expect(all('.dt-cards .dt-att-what').map(item => item.textContent)).toEqual(['飞书 来源异常', '评估未完成：这个文案好奇怪'])
  expect(text()).not.toContain(zh['health.evals'])
})

it('says when no Source is on, an Eval is past its deadline or a message keeps failing, each with the way to it', async () => {
  for (const kind of ['feishu', 'github']) server.settings.sources[kind] = { ...server.settings.sources[kind]!, enabled: false }
  server.threads = [threadSummary({ key: 'github:9', title: '#9 迟迟未决', stage: 'evaluating',
    evaluating: { id: 'v9', triggers: 1, strength: 'inferred', startedAt: '2026-08-31T23:58:00Z', deadline: '2026-09-01T00:00:00Z' } })]
  server.failing = [{ id: 'm1', channel: { source: 'github', thread: 'github:42', address: { number: '42' } },
    text: '已修复', attempts: 4,
    error: 'HTTP 502 from GitHub' }]
  await mount()
  const titles = () => all('.dt-cards .dt-att-what').map(item => item.textContent)
  // The Feishu Source is off, so its error is no problem any more.
  expect(titles()).toEqual([zh.problemNoSource, '评估超时未决定：#9 迟迟未决', '评估未完成：这个文案好奇怪', 'GitHub 回复发送失败（已重试 4 次）'])
  expect(text()).toContain('HTTP 502 from GitHub')
  await click(zh.actionOpenSources)
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(zh['settingsGroup.source'])
  await click(tab(zh['tab.overview']))
  await click('评估超时未决定：#9 迟迟未决')
  expect(server.requests.some(request => request.path.startsWith('threads/github:9'))).toBe(true)
})
