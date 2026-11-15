/** Overview page: pending Tickets requiring human action, active system problems, 24-hour flow counts, and Executor load. */
import type { ReactNode } from 'react'
import { usePoll, type Problem } from './api.ts'
import { Button, Icon } from './controls.tsx'
import { useAction, usePanel, usePanelData } from './provider.tsx'
import { setupPage, settingsRoute, type Route } from './route.ts'
import { TicketLine } from './rows.tsx'
import { healthText, localized, reasonLabel, valueLabel, readableMarkers, when } from './text.ts'
import { CheckSetupButton, ConfirmButton, Hint, LoadState, Section, SetupMessage, When } from './widgets.tsx'

function ProblemLine({ problem, onChanged }: { problem: Problem; onChanged: () => Promise<void> }) {
  const { t, call, navigate } = usePanel()
  const { setup } = usePanelData()
  const post = useAction((request: () => Promise<unknown>) => request(), { reload: onChanged })
  const row = (title: string, detail: ReactNode, route: Route | undefined, hint?: string, actions?: ReactNode) => <li
    className="dt-row dt-link dt-att dt-att-error">
    <div className="dt-row-main">
      <div className="dt-att-what">{route ? <button type="button" className="dt-open dt-open-wrap"
        onClick={() => navigate(route)}>{title}</button> : title}</div>
      {detail}{hint && <Hint>{hint}</Hint>}{actions && <div className="dt-row-meta dt-row-buttons">{actions}</div>}
    </div>
  </li>
  const go = (label: string, route: Route) => <Button variant="outline" size="sm" icon={<Icon name="settings"
    size={14} />} onClick={() => navigate(route)}>{label}</Button>
  const raw = (text: string | undefined) => text && <p className="dt-error dt-clamp dt-mono">{text}</p>
  const worded = (text: string) => <p className="dt-error">{text}</p>
  switch (problem.kind) {
    // A failed Feishu bot check pauses only the Feishu Source; other setup problems halt the entire service.
    // A rearm the runtime scheduled itself says the wait ends without a person, so the hint names when instead of asking for a fix.
    case 'setup': return row(t(problem.place === 'feishu' ? 'problemSetupFeishu' : 'problemSetup'), <p className="dt-error"><SetupMessage
      problem={problem} /></p>, setupPage(problem.place), setup?.rearm ? t('problemSetupHeal', { when: when(setup.rearm.dueAt, t('lang')) })
      : t(`problemSetupFix.${problem.place}`), <CheckSetupButton />)
    case 'no-source': return row(t('problemNoSource'), undefined, settingsRoute('source'), undefined, go(t('actionOpenSources'),
      settingsRoute('source')))
    case 'no-allowed': return row(t('problemNoAllowed'), undefined, settingsRoute('eval'), undefined, go(t('actionAddAllowed'),
      settingsRoute('eval')))
    case 'executor-paused': return row(t('problemPaused'), undefined, { page: 'execution' }, undefined,
      <ConfirmButton variant="outline" icon="play" label={t('resumeProcessing')} title={t('resumeProcessing')}
        message={t('resumeProcessingConfirm')}
        onConfirm={async () => { await call('POST executor/pause', { body: { paused: false } }); await onChanged() }} />)
    case 'runtime-error': return row(t('problemRuntime', { name: valueLabel(t, 'health', problem.name) }), raw(problem.detail), undefined)
    case 'source-error': {
      const health = problem.source.health
      return row(t('sourceError', { source: localized(t, problem.source.title) }), health.code ? worded(healthText(t, health))
        : raw(health.detail), { page: 'source' }, t('sourceErrorHint'))
    }
    case 'eval-overdue': return row(t('problemEvalOverdue', { thread: readableMarkers(t, problem.thread.title) }), undefined, { page: 'trigger',
      id: problem.thread.key })
    case 'eval-unavailable': return row(t('problemEvalUnavailable', { thread: readableMarkers(t, problem.thread.title) }), raw(reasonLabel(t,
      problem.reason)),
      { page: 'trigger', id: problem.thread.key, query: { trigger: problem.triggerId } }, undefined, <>
        <Button variant="outline" size="sm" icon={<Icon name="refresh" size={14} />} disabled={post.busy}
          onClick={() => { void post.run(() => call('POST triggers/:id/requeue', { id: problem.triggerId })) }}>{t('requeue')}</Button>
        <Button variant="outline" size="sm" icon={<Icon name="dismiss" size={14} />} disabled={post.busy}
          onClick={() => { void post.run(() => call('POST decisions/:id/dismiss', { id: problem.decisionId })) }}>{t('dismiss')}</Button>
      </>)
    case 'outgoing': return row(t('problemReply', { source: valueLabel(t, 'source', problem.outgoing.channel.source),
      attempts: problem.outgoing.attempts }),
      raw(problem.outgoing.error), undefined)
  }
}

export function OverviewPage() {
  const { t, call, navigate } = usePanel()
  const { setup } = usePanelData()
  const { data, error, reload } = usePoll(() => call('GET overview'), [])
  // The cost panel reads its own totals, so a slow usage log never holds up the queue view.
  const usage = usePoll(() => call('GET usage'), [])
  // Routines are the agent's own schedule; the panel only shows when each one fires next, so saving sits in Settings.
  const routines = usePoll(() => call('GET routines'), [])
  // A command stuck behind a card is work that looks idle, so the panel names the ones still open and when they lapse.
  const approvals = usePoll(() => call('GET approvals'), [])
  const open = approvals.data?.approvals.filter(item => item.state === 'pending') ?? []
  // How the closed questions ended says whether people are answering at all; the open ones alone cannot.
  const tally = approvals.data?.tally
  const answered = tally === undefined ? 0 : tally.approved + tally.rejected + tally.expired + tally.used
  // Answering here walks the same path a card tap walks: the grant is spent by the one retry it lets through.
  const answer = async (id: string, value: 'approve' | 'reject') => {
    await call('POST approvals/:id/decide', { id, body: { answer: value } })
    await approvals.reload()
  }
  if (!data) return <LoadState error={error} loading />
  const stat = (label: string, value: ReactNode, route?: Route) => <span className="dt-stat">
    <span className="dt-stat-label">{label}</span>
    {route ? <button type="button" className="dt-textlink dt-stat-value" onClick={() => navigate(route)}>{value}</button> : <span
      className="dt-stat-value">{value}</span>}
  </span>
  const more = (route: Route) => <button type="button" className="dt-textlink dt-more-link"
    onClick={() => navigate(route)}>{t('details')}</button>
  return <>
    {error && <LoadState error={error} loading={false} />}
    <Section title={t('pendingTickets')} count={data.person.length}>
      {data.person.length ? <ul className="dt-list dt-cards">{data.person.map(ticket => <TicketLine key={ticket.id} ticket={ticket} question
        onChanged={reload} />)}</ul>
        : <Hint>{t('needsYouNone')}</Hint>}
    </Section>
    {data.problems.length > 0 && <Section title={t('problems')} count={data.problems.length}>
      <ul className="dt-list dt-cards">{data.problems.map((problem, index) => <ProblemLine key={index} problem={problem}
        onChanged={reload} />)}</ul>
    </Section>}
    <Section title={t('lastDay')} action={more({ page: 'trigger', query: { filter: 'recent' } })}>
      {/* Received and evaluated counts operate on Triggers rather than Threads or Decisions, so they do not link to filtered views. */}
      <div className="dt-stats">
        {stat(t('flowReceivedLabel'), data.flow.received)}
        {stat(t('flowFilteredLabel'), data.flow.filtered, data.flow.filtered ? { page: 'source' } : undefined)}
        {stat(t('flowJudgedLabel'), data.flow.judged)}
        {stat(t('flowAcceptedLabel'), data.flow.accepted, { page: 'eval', query: { window: '24h' } })}
        {data.flow.dropped > 0 && stat(t('flowDroppedLabel'), data.flow.dropped, { page: 'source' })}
      </div>
    </Section>
    <Section title={t('cost')}>
      {usage.data ? <>
        <div className="dt-stats">
          {stat(t('costTokens'), `${(usage.data.today.inputTokens + usage.data.today.outputTokens).toLocaleString()}`)}
          {stat(t('costHitRate'), `${(usage.data.today.cacheHitRate * 100).toFixed(1)}%`)}
          {stat(t('costEstimate'), `¥${usage.data.today.estimatedYuan.toFixed(4)}`)}
        </div>
        {usage.data.alert && <Hint>{usage.data.alert}</Hint>}
        {usage.data.bySession.length > 0 && <ul className="dt-list">{usage.data.bySession.map(group => <li
          key={`${group.role}:${group.sessionId}`} className="dt-row">
          <div className="dt-row-main">
            <div className="dt-att-what">{t('costBySession')} · <span className="dt-mono">{group.sessionId.slice(0, 12)}</span></div>
            <p className="dt-row-meta">{t('costSessionRow', {
              role: group.role === 'main' ? t('costRoleMain') : t('costRoleWorker'),
              calls: group.totals.calls,
              hit: `${(group.totals.cacheHitRate * 100).toFixed(1)}%`,
              yuan: group.totals.estimatedYuan.toFixed(4),
            })}</p>
          </div>
        </li>)}</ul>}
      </> : <LoadState error={usage.error} loading={usage.data === undefined} />}
    </Section>
    <Section title={t('routines')} count={routines.data?.routines.length}>
      {routines.data ? (routines.data.routines.length ? <ul className="dt-list">{routines.data.routines.map(routine => <li
        key={routine.id} className="dt-row">
        <div className="dt-row-main">
          <div className="dt-att-what">{routine.name}</div>
          <p className="dt-row-meta dt-mono">{routine.cron}</p>
          <p className="dt-row-meta">{routine.enabled ? t('routineNext') : t('routinePaused')}
            <When at={routine.enabled ? routine.nextAt : routine.lastAt} /></p>
        </div>
      </li>)}</ul> : <Hint>{t('routinesNone')}</Hint>) : <LoadState error={routines.error} loading />}
    </Section>
    <Section title={t('approvals')} count={open.length}>
      {answered > 0 && <p className="dt-row-meta">{t('approvalTally', { approved: tally!.approved, rejected: tally!.rejected, expired: tally!.expired, used: tally!.used })}</p>}
      {approvals.data ? (open.length ? <ul className="dt-list">{open.map(item => <li key={item.id} className="dt-row">
        <div className="dt-row-main">
          <div className="dt-att-what">{t('approvalRule', { rule: item.rule })}</div>
          <p className="dt-row-meta dt-mono">{item.command}</p>
          <p className="dt-row-meta">{t('approvalExpires')}<When at={item.expiresAt} /></p>
        </div>
        <div className="dt-row-actions">
          <Button variant="outline" size="sm" onClick={() => { void answer(item.id, 'approve') }}>{t('approve')}</Button>
          <Button variant="outline" size="sm" onClick={() => { void answer(item.id, 'reject') }}>{t('reject')}</Button>
        </div>
      </li>)}</ul> : <Hint>{t('approvalsNone')}</Hint>) : <LoadState error={approvals.error} loading />}
    </Section>
    <Section title={t('term.executor')} action={more({ page: 'execution' })}>
      {/* Pauses surface in `problems` above, so Executor counts render the same in both states; while setup waits, nothing runs. */}
      {setup?.problem ? <Hint>{t('executorWaitingSetup')}</Hint> : <div className="dt-stats">
        {stat(t('executingLabel'), `${data.executor.running} / ${data.executor.maxWorkers}`)}
        {stat(t('queuedLabel'), data.executor.queued)}
        {stat(t('idleLabel'), data.executor.idle)}
      </div>}
    </Section>
  </>
}
