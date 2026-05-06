import { useState, useCallback, useEffect } from 'react'
import { useAppState, useAppDispatch } from '../store'
import { apiFetch } from '../api'
import { dark, light } from '../theme'

interface Task { text: string; done: boolean; carriedOver?: boolean }
interface AgendaEvent { title: string; time: string; location?: string | null; allDay?: boolean }
interface AgendaDay { date: string; label: string; shortLabel: string; events: AgendaEvent[] }
interface DeviceCode { user_code: string; verification_url: string }

const ACCENT = '#42A5F5'

function todayKey(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}

function formatLabel(dateKey: string): string {
  try {
    const [y, m, d] = dateKey.split('-').map(Number)
    return new Date(y, m-1, d).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })
  } catch { return dateKey }
}

function extractHaiku(content: string): string {
  return content.split('\n').map(l => l.trim())
    .filter(l => l && !l.startsWith('#') && !l.startsWith('- ['))
    .slice(0, 3).join('\n')
}

function extractTasks(content: string): Task[] {
  const lines = content.split('\n')
  const taskStart = lines.findIndex(l => l.trim() === '## Tasks')
  if (taskStart === -1) return []
  return lines.slice(taskStart + 1)
    .filter(l => /^- \[[ x]\]/.test(l.trim()))
    .map(l => ({ text: l.replace(/^- \[[ x]\]\s*/, '').trim(), done: l.includes('- [x]') }))
}

function extractInboxTasks(content: string): Task[] {
  return content.split('\n')
    .filter(l => /^- \[[ x]\]/.test(l.trim()))
    .map(l => ({ text: l.replace(/^- \[[ x]\]\s*/, '').trim(), done: l.includes('[x]') }))
}

function buildInboxContent(tasks: Task[]): string {
  return tasks.map(t => `- [${t.done ? 'x' : ' '}] ${t.text}`).join('\n') + '\n'
}

function buildFileContent(dateKey: string, haiku: string, tasks: Task[]): string {
  let content = `# ${formatLabel(dateKey)}\n\n${haiku.trim()}\n`
  if (tasks.length > 0) {
    content += `\n## Tasks\n`
    for (const t of tasks) content += `- [${t.done ? 'x' : ' '}] ${t.text}\n`
  }
  return content
}

export default function TrackerTab() {
  const state = useAppState()
  const dispatch = useAppDispatch()
  const theme = state.isDark ? dark : light

  const api = useCallback((path: string, opts?: RequestInit) =>
    apiFetch(state.serverUrl!, state.token!, path, opts), [state.serverUrl, state.token])

  const today = todayKey()
  const isAfter8pm = new Date().getHours() >= 20
  const agendaStart = isAfter8pm
    ? (() => { const d = new Date(); d.setDate(d.getDate()+1); return d.toISOString().slice(0,10) })()
    : today

  const [haiku, setHaiku] = useState('')
  const [tasks, setTasks] = useState<Task[]>([])
  const [inboxTasks, setInboxTasks] = useState<Task[]>([])
  const [newTask, setNewTask] = useState('')
  const [agendaDays, setAgendaDays] = useState<AgendaDay[]>([])
  const [calConnected, setCalConnected] = useState(false)
  const [loading, setLoading] = useState(true)
  const [pastHaiku, setPastHaiku] = useState<Record<string, string>>({})

  // Calendar connect flow
  const [connectOpen, setConnectOpen] = useState(false)
  const [deviceCode, setDeviceCode] = useState<DeviceCode | null>(null)
  const [connectError, setConnectError] = useState<string | null>(null)
  const [connectPoll, setConnectPoll] = useState<ReturnType<typeof setInterval> | null>(null)

  // Haiku write mode
  const [writing, setWriting] = useState(false)
  const [haikuLines, setHaikuLines] = useState(['', '', ''])
  const [saving, setSaving] = useState(false)

  const saveJournal = useCallback(async (h: string, t: Task[]) => {
    const content = buildFileContent(today, h, t)
    api('/wiki/file', { method: 'POST', body: JSON.stringify({ path: `journal/${today}.md`, content }) })
      .catch(() => {})
  }, [today, api])

  const saveInbox = useCallback(async (t: Task[]) => {
    const content = buildInboxContent(t)
    api('/wiki/file', { method: 'POST', body: JSON.stringify({ path: 'tasks/inbox.md', content }) })
      .catch(() => {})
  }, [api])

  const loadData = useCallback(async () => {
    if (!state.serverUrl || !state.token) return
    setLoading(true)
    try {
      // Load today's journal
      const todayRes = await api(`/wiki/file?path=${encodeURIComponent(`journal/${today}.md`)}`).catch(() => null)
      if (todayRes?.ok) {
        const d = await todayRes.json() as { content: string }
        setHaiku(extractHaiku(d.content))
        const t = extractTasks(d.content)
        if (t.length > 0) setTasks(t)
        else {
          // carry over yesterday's undone tasks
          const yest = (() => { const d = new Date(); d.setDate(d.getDate()-1); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}` })()
          const yr = await api(`/wiki/file?path=${encodeURIComponent(`journal/${yest}.md`)}`).catch(() => null)
          if (yr?.ok) {
            const yd = await yr.json() as { content: string }
            const carried = extractTasks(yd.content).filter(t => !t.done).map(t => ({ ...t, carriedOver: true }))
            if (carried.length) setTasks(carried)
          }
        }
      }

      // Past haiku (same MM-DD in prior years)
      const treeRes = await api('/wiki/tree?path=journal').catch(() => null)
      if (treeRes?.ok) {
        const td = await treeRes.json() as { entries: { name: string; path: string; isDir: boolean }[] }
        const todayMMDD = today.slice(5)
        const pastFiles = td.entries.filter(e => !e.isDir && e.name.endsWith('.md') && e.name.slice(5,10) === todayMMDD && e.name.replace('.md','') !== today)
        const results = await Promise.all(pastFiles.map(async f => {
          try {
            const r = await api(`/wiki/file?path=${encodeURIComponent(f.path)}`)
            const d = await r.json() as { content: string }
            const text = extractHaiku(d.content)
            return text ? { year: f.name.slice(0,4), text } : null
          } catch { return null }
        }))
        const map: Record<string, string> = {}
        for (const r of results) if (r) map[r.year] = r.text
        setPastHaiku(map)
      }

      // Calendar
      const calRes = await api(`/calendar/range?start=${agendaStart}&days=7`).catch(() => null)
      if (calRes?.ok) {
        const cd = await calRes.json() as { days: AgendaDay[] }
        setAgendaDays(cd.days ?? [])
        setCalConnected(true)
      } else {
        setCalConnected(false)
      }

      // Inbox tasks
      const inboxRes = await api(`/wiki/file?path=${encodeURIComponent('tasks/inbox.md')}`).catch(() => null)
      if (inboxRes?.ok) {
        const id = await inboxRes.json() as { content: string }
        setInboxTasks(extractInboxTasks(id.content))
      }
    } finally {
      setLoading(false)
    }
  }, [today, agendaStart, api, state.serverUrl, state.token])

  useEffect(() => { loadData() }, [loadData])

  async function startConnect() {
    setConnectError(null); setDeviceCode(null); setConnectOpen(true)
    try {
      const r = await api('/calendar/auth/device/start', { method: 'POST' })
      const d = await r.json() as { user_code?: string; verification_url?: string; error?: string }
      if (!r.ok || d.error) { setConnectError(d.error ?? 'Failed'); return }
      setDeviceCode({ user_code: d.user_code!, verification_url: d.verification_url! })
      const poll = setInterval(async () => {
        try {
          const sr = await api('/calendar/auth/device/status')
          const sd = await sr.json() as { connected: boolean }
          if (sd.connected) {
            clearInterval(poll); setConnectPoll(null); setConnectOpen(false); setCalConnected(true)
            const cr = await api(`/calendar/range?start=${agendaStart}&days=7`)
            if (cr.ok) { const cd = await cr.json() as { days: AgendaDay[] }; setAgendaDays(cd.days ?? []) }
          }
        } catch {}
      }, 3000)
      setConnectPoll(poll)
    } catch { setConnectError('Could not reach server') }
  }

  function cancelConnect() {
    if (connectPoll) { clearInterval(connectPoll); setConnectPoll(null) }
    setConnectOpen(false)
  }

  function toggleTask(i: number, inbox = false) {
    if (inbox) {
      const updated = inboxTasks.map((t, j) => j === i ? { ...t, done: !t.done } : t)
      setInboxTasks(updated); saveInbox(updated)
    } else {
      const updated = tasks.map((t, j) => j === i ? { ...t, done: !t.done } : t)
      setTasks(updated); saveJournal(haiku, updated)
    }
  }

  function addInboxTask() {
    const text = newTask.trim(); if (!text) return
    const updated = [...inboxTasks, { text, done: false }]
    setInboxTasks(updated); saveInbox(updated); setNewTask('')
  }

  function openWriteMode() {
    const lines = haiku ? haiku.split('\n') : ['','','']
    setHaikuLines([lines[0]??'', lines[1]??'', lines[2]??'']); setWriting(true)
  }

  async function saveHaiku() {
    const text = haikuLines.join('\n').trim()
    setSaving(true)
    setHaiku(text)
    await saveJournal(text, tasks)
    setSaving(false); setWriting(false)
  }

  const pastYears = Object.keys(pastHaiku).sort().reverse()

  const s = {
    row: { display:'flex', alignItems:'center', gap:12, padding:'11px 16px', borderBottom:`1px solid ${theme.border}` } as React.CSSProperties,
    section: { color:theme.textDim, fontSize:11, fontWeight:700, letterSpacing:0.8, padding:'14px 16px 6px', textTransform:'uppercase' as const } as React.CSSProperties,
  }

  if (!state.serverUrl || !state.token) return null

  if (loading) {
    return (
      <div style={{ height:'100%', display:'flex', alignItems:'center', justifyContent:'center' }}>
        <div style={{ color:theme.textDim }}>Loading…</div>
      </div>
    )
  }

  return (
    <div style={{ height:'100%', display:'flex', flexDirection:'column' }}>
      {/* Header */}
      <div style={{ display:'flex', alignItems:'center', padding:'12px 16px', borderBottom:`1px solid ${theme.border}`, flexShrink:0, position:'relative' }}>
        <span style={{ color:theme.textDim, fontSize:13, zIndex:1 }}>
          {new Date().toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric' })}
        </span>
        <div style={{ position:'absolute', left:0, right:0, textAlign:'center', pointerEvents:'none' }}>
          <span style={{ color:ACCENT, fontWeight:700, fontSize:18 }}>🐦 Tracker</span>
        </div>
        <button onClick={() => dispatch({ type:'TOGGLE_THEME' })} style={{ marginLeft:'auto', background:'none', border:'none', cursor:'pointer', fontSize:18, zIndex:1, color:theme.text }}>
          {state.isDark ? '🌙' : '☀️'}
        </button>
      </div>

      <div style={{ flex:1, overflowY:'auto' }}>

        {/* ── CALENDAR ── */}
        <div style={s.section}>Calendar</div>
        {calConnected ? (
          <div style={{ paddingBottom:4 }}>
            {agendaDays.filter(d => d.events.length > 0).slice(0,5).map(day => (
              <div key={day.date}>
                <div style={{ color:theme.textDim, fontSize:12, fontWeight:600, padding:'6px 16px 2px' }}>{day.label}</div>
                {day.events.map((ev, i) => (
                  <div key={i} style={{ display:'flex', gap:16, padding:'7px 16px', alignItems:'flex-start' }}>
                    <span style={{ color:theme.textDim, fontSize:12, width:52, flexShrink:0 }}>{ev.allDay ? 'all day' : ev.time}</span>
                    <span style={{ color:theme.text, fontSize:14 }}>{ev.title}</span>
                  </div>
                ))}
              </div>
            ))}
            {agendaDays.every(d => d.events.length === 0) && (
              <div style={{ color:theme.textDim, fontSize:14, padding:'8px 16px' }}>Nothing scheduled</div>
            )}
          </div>
        ) : (
          <div style={{ padding:'8px 16px 12px' }}>
            <button onClick={startConnect} style={{ background:'none', border:'none', color:ACCENT, fontSize:14, cursor:'pointer', padding:0 }}>
              + Connect Google Calendar
            </button>
          </div>
        )}

        {/* ── HAIKU ── */}
        <div style={s.section}>Today's haiku</div>
        <div style={{ padding:'4px 16px 12px' }}>
          {haiku ? (
            <div onClick={openWriteMode} style={{ cursor:'pointer' }}>
              <div style={{ color:theme.text, fontSize:18, lineHeight:1.8, fontStyle:'italic', marginBottom:4 }}>{haiku}</div>
            </div>
          ) : (
            <button onClick={openWriteMode} style={{ background:'none', border:'none', color:ACCENT, fontSize:14, cursor:'pointer', padding:0 }}>
              write tonight's haiku
            </button>
          )}
          {pastYears.length > 0 && (
            <div style={{ marginTop:12, display:'flex', flexDirection:'column', gap:8 }}>
              {pastYears.map(yr => (
                <div key={yr}>
                  <div style={{ color:theme.textFaint, fontSize:11, marginBottom:2 }}>{yr}</div>
                  <div style={{ color:theme.text, fontSize:14, lineHeight:1.7, fontStyle:'italic', opacity:0.5 }}>{pastHaiku[yr]}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── TODAY'S TASKS ── */}
        {tasks.length > 0 && (
          <>
            <div style={s.section}>Today</div>
            {tasks.map((t, i) => (
              <div key={i} style={{ ...s.row, cursor:'pointer' }} onClick={() => toggleTask(i)}>
                <span style={{ color:t.done ? ACCENT : theme.textDim, fontSize:16 }}>{t.done ? '●' : '○'}</span>
                <span style={{ color:t.done ? theme.textDim : theme.text, fontSize:14, textDecoration:t.done ? 'line-through' : 'none', flex:1 }}>
                  {t.carriedOver && !t.done && <span style={{ color:theme.textFaint, fontSize:11, marginRight:6 }}>↑</span>}
                  {t.text}
                </span>
              </div>
            ))}
          </>
        )}

        {/* ── INBOX ── */}
        <div style={s.section}>Inbox</div>
        {inboxTasks.map((t, i) => (
          <div key={i} style={{ ...s.row, cursor:'pointer' }} onClick={() => toggleTask(i, true)}>
            <span style={{ color:t.done ? ACCENT : theme.textDim, fontSize:16 }}>{t.done ? '●' : '○'}</span>
            <span style={{ color:t.done ? theme.textDim : theme.text, fontSize:14, textDecoration:t.done ? 'line-through' : 'none', flex:1 }}>{t.text}</span>
          </div>
        ))}
        <div style={{ padding:'8px 16px 16px', display:'flex', gap:8 }}>
          <input value={newTask} onChange={e => setNewTask(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && addInboxTask()}
            placeholder="Add task…"
            style={{ flex:1, background:theme.inputBg, border:`1px solid ${theme.border}`, borderRadius:8, padding:'9px 12px', color:theme.text, fontSize:14, outline:'none' }} />
          <button onClick={addInboxTask} disabled={!newTask.trim()}
            style={{ background:ACCENT, border:'none', borderRadius:8, padding:'9px 16px', color:'#fff', fontSize:14, cursor:'pointer', opacity:newTask.trim() ? 1 : 0.4 }}>+</button>
        </div>
      </div>

      {/* ── Write haiku modal ── */}
      {writing && (
        <div style={{ position:'absolute', inset:0, background:theme.bg, zIndex:300, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', padding:'40px 32px' }}>
          <button onClick={saveHaiku} disabled={saving}
            style={{ position:'absolute', top:20, right:20, background:'none', border:'none', color:ACCENT, fontSize:16, cursor:'pointer' }}>
            {saving ? '…' : 'done'}
          </button>
          {haikuLines.map((line, i) => (
            <div key={i} style={{ width:'100%', textAlign:'center', marginBottom:20 }}>
              <input value={line} onChange={e => setHaikuLines(l => l.map((v,j) => j===i ? e.target.value : v))}
                autoFocus={i===0}
                style={{ background:'none', border:'none', borderBottom:`1px solid ${theme.border}`, textAlign:'center', width:'100%', color:theme.text, fontSize:22, fontStyle:'italic', outline:'none', padding:'4px 0' }} />
              <div style={{ color:theme.textFaint, fontSize:14, marginTop:4, letterSpacing:3 }}>
                {i===1 ? '· · · · · · ·' : '· · · · ·'}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Calendar connect overlay ── */}
      {connectOpen && (
        <div style={{ position:'absolute', inset:0, background:theme.bg, zIndex:300, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', padding:'32px' }}>
          <button onClick={cancelConnect} style={{ position:'absolute', top:20, right:20, background:'none', border:'none', color:theme.textDim, fontSize:14, cursor:'pointer' }}>cancel</button>
          <div style={{ color:theme.text, fontSize:20, fontWeight:700, marginBottom:24 }}>Connect Google Calendar</div>
          {connectError ? (
            <div style={{ color:'#FF6135', fontSize:13, textAlign:'center' }}>{connectError}</div>
          ) : !deviceCode ? (
            <div style={{ color:theme.textDim }}>Starting…</div>
          ) : (
            <>
              <div style={{ color:theme.textDim, fontSize:13, marginBottom:8 }}>Open this URL in any browser:</div>
              <a href={deviceCode.verification_url} target="_blank" rel="noreferrer"
                style={{ color:ACCENT, fontSize:14, marginBottom:20, wordBreak:'break-all', textAlign:'center' }}>{deviceCode.verification_url}</a>
              <div style={{ color:theme.textDim, fontSize:13, marginBottom:8 }}>Then enter this code:</div>
              <div style={{ background:theme.surface, border:`1px solid ${theme.border}`, borderRadius:8, padding:'12px 24px', color:theme.text, fontSize:28, fontWeight:700, letterSpacing:4, marginBottom:16 }}>
                {deviceCode.user_code}
              </div>
              <div style={{ color:theme.textFaint, fontSize:12 }}>Waiting for approval…</div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
