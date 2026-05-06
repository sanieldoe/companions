import { useState, useCallback, useEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useAppState, useAppDispatch } from '../store'
import { apiFetch } from '../api'
import { dark, light } from '../theme'

interface TreeEntry { name: string; path: string; size: number; mtime: string; isDir: boolean }
interface FileDetail { path: string; content: string; mtime: string }
type TopFolder = 'projects' | 'raw' | 'wiki' | 'journal'
const TOP_FOLDERS: TopFolder[] = ['projects', 'raw', 'wiki', 'journal']
const ACCENT = '#FFD54F'

function fmtDate(iso: string): string {
  try { return new Date(iso).toLocaleString(undefined, { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' }) }
  catch { return iso }
}

export default function KeeperTab() {
  const state = useAppState()
  const dispatch = useAppDispatch()
  const theme = state.isDark ? dark : light

  const api = useCallback((path: string, opts?: RequestInit) =>
    apiFetch(state.serverUrl!, state.token!, path, opts), [state.serverUrl, state.token])

  const [folder, setFolder] = useState<TopFolder>('projects')
  const [stack, setStack] = useState<string[]>(['projects'])
  const currentPath = stack[stack.length - 1]
  const [entries, setEntries] = useState<TreeEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // File viewer
  const [fileOpen, setFileOpen] = useState(false)
  const [fileDetail, setFileDetail] = useState<FileDetail | null>(null)
  const [fileLoading, setFileLoading] = useState(false)
  const [editMode, setEditMode] = useState(false)
  const [editContent, setEditContent] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // Brain dump
  const [dumpOpen, setDumpOpen] = useState(false)
  const [dumpText, setDumpText] = useState('')
  const [dumpSaving, setDumpSaving] = useState(false)

  // Ask
  const [askOpen, setAskOpen] = useState(false)
  const [askQ, setAskQ] = useState('')
  const [askLoading, setAskLoading] = useState(false)
  const [askResults, setAskResults] = useState<{ path: string; heading: string; text: string }[]>([])
  const [askSearched, setAskSearched] = useState(false)

  // Tools
  const [toolsOpen, setToolsOpen] = useState(false)
  const [toolsMsg, setToolsMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  // Dupes
  const [dupesOpen, setDupesOpen] = useState(false)
  const [dupes, setDupes] = useState<{ fileA: string; fileB: string; similarity: number }[]>([])
  const [dupesLoading, setDupesLoading] = useState(false)

  const flash = (msg: string) => { setToolsMsg(msg); setTimeout(() => setToolsMsg(null), 3000) }

  const fetchTree = useCallback(async (override?: string) => {
    if (!state.serverUrl || !state.token) return
    setLoading(true); setError(null)
    try {
      const res = await api(`/wiki/tree?path=${encodeURIComponent(override ?? currentPath)}`)
      if (!res.ok) throw new Error(`Server error ${res.status}`)
      const data = await res.json() as { entries: TreeEntry[] }
      setEntries(data.entries ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    }
    setLoading(false)
  }, [currentPath, api, state.serverUrl, state.token])

  useEffect(() => { fetchTree() }, [fetchTree])

  function switchFolder(f: TopFolder) { setFolder(f); setStack([f]) }

  async function openEntry(entry: TreeEntry) {
    if (entry.isDir) { setStack(p => [...p, entry.path]); return }
    setFileOpen(true); setFileDetail(null); setFileLoading(true); setEditMode(false); setSaveError(null)
    try {
      const res = await api(`/wiki/file?path=${encodeURIComponent(entry.path)}`)
      const data = await res.json() as FileDetail
      setFileDetail(data); setEditContent(data.content)
    } catch { setSaveError('Failed to load') }
    setFileLoading(false)
  }

  async function saveFile() {
    if (!fileDetail) return
    setSaving(true); setSaveError(null)
    try {
      const res = await api('/wiki/file', { method:'POST', body:JSON.stringify({ path:fileDetail.path, content:editContent }) })
      if (!res.ok) throw new Error('Failed to save')
      setFileDetail({ ...fileDetail, content:editContent }); setEditMode(false)
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Failed')
    }
    setSaving(false)
  }

  async function submitDump() {
    if (!dumpText.trim()) return
    setDumpSaving(true)
    try {
      await api('/wiki/dump', { method:'POST', body:JSON.stringify({ text:dumpText }) })
      setDumpText(''); setDumpOpen(false); switchFolder('raw')
    } catch { /* ignore */ }
    setDumpSaving(false)
  }

  async function runAsk() {
    const q = askQ.trim(); if (!q) return
    setAskLoading(true); setAskResults([]); setAskSearched(false)
    try {
      const r = await api('/knowledge/query', { method:'POST', body:JSON.stringify({ question:q, topK:6 }) })
      const d = await r.json() as { ok:boolean; chunks:{ path:string; heading:string; text:string }[] }
      setAskResults(d.chunks ?? [])
    } catch { /* ignore */ }
    setAskLoading(false); setAskSearched(true)
  }

  async function runTool(id: string, path: string, method = 'POST') {
    setBusy(id)
    try {
      const r = await api(path, method === 'GET' ? undefined : { method })
      const d = await r.json() as Record<string, unknown>
      if (id === 'reindex') flash(`Indexed ${(d.indexed as string[])?.length ?? 0} files`)
      else if (id === 'compile') { flash(`Compiled ${(d.compiled as string[])?.length ?? 0} files`); fetchTree('wiki') }
      else if (id === 'lint') flash('Lint running… check .vault-health.md')
      else if (id === 'dupes') {
        setDupes((d.dupes as { fileA:string; fileB:string; similarity:number }[]) ?? [])
        setDupesOpen(true)
      }
    } catch { flash(`${id} failed`) }
    setBusy(null)
  }

  const isSubfolder = stack.length > 1

  const modalOverlay: React.CSSProperties = { position:'fixed', inset:0, background:'rgba(0,0,0,0.6)', zIndex:400, display:'flex', flexDirection:'column' }
  const modalBox: React.CSSProperties = { background:theme.bg, flex:1, display:'flex', flexDirection:'column' }
  const modalHdr: React.CSSProperties = { display:'flex', alignItems:'center', padding:'14px 16px', borderBottom:`1px solid ${theme.border}`, flexShrink:0 }
  const rowStyle: React.CSSProperties = { display:'flex', alignItems:'center', gap:12, padding:'13px 16px', borderBottom:`1px solid ${theme.border}`, cursor:'pointer' }
  const tabBtn = (active: boolean): React.CSSProperties => ({
    flex:1, padding:'10px 0', background:'none', border:'none', cursor:'pointer',
    borderBottom:active ? `2px solid ${theme.text}` : '2px solid transparent',
    color:active ? theme.text : theme.textDim, fontSize:13, fontWeight:active ? 600 : 400,
  })

  return (
    <div style={{ height:'100%', display:'flex', flexDirection:'column', position:'relative' }}>
      {/* Header */}
      <div style={{ display:'flex', alignItems:'center', padding:'12px 16px', borderBottom:`1px solid ${theme.border}`, flexShrink:0, position:'relative' }}>
        <div style={{ position:'absolute', left:0, right:0, textAlign:'center', pointerEvents:'none' }}>
          <span style={{ color:ACCENT, fontWeight:700, fontSize:18 }}>🐝 Keeper</span>
        </div>
        <div style={{ marginLeft:'auto', zIndex:1 }}>
          <button onClick={() => dispatch({ type:'TOGGLE_THEME' })} style={{ background:'none', border:'none', cursor:'pointer', fontSize:18, color:theme.text }}>
            {state.isDark ? '🌙' : '☀️'}
          </button>
        </div>
      </div>

      {/* Tab / back bar */}
      <div style={{ display:'flex', background:theme.surface, borderBottom:`1px solid ${theme.border}`, flexShrink:0 }}>
        {isSubfolder ? (
          <>
            <button onClick={() => setStack(p => p.slice(0,-1))} style={{ ...tabBtn(false), flex:'none' as unknown as number, padding:'10px 16px' }}>‹ Back</button>
            <span style={{ flex:1, display:'flex', alignItems:'center', padding:'0 8px', color:theme.textDim, fontSize:12, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{currentPath}</span>
          </>
        ) : TOP_FOLDERS.map(f => (
          <button key={f} style={tabBtn(folder === f)} onClick={() => switchFolder(f)}>
            {f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
        <button onClick={() => setToolsOpen(true)} style={{ background:'none', border:'none', cursor:'pointer', color:theme.textDim, fontSize:22, padding:'0 14px', flexShrink:0 }}>
          ⋯
        </button>
      </div>

      {toolsMsg && <div style={{ background:theme.surface, padding:'6px 16px', color:theme.textDim, fontSize:12, flexShrink:0 }}>{toolsMsg}</div>}

      {/* File list */}
      <div style={{ flex:1, overflowY:'auto' }}>
        {loading ? (
          <div style={{ textAlign:'center', padding:32, color:theme.textDim }}>Loading…</div>
        ) : error ? (
          <div style={{ textAlign:'center', padding:32 }}>
            <div style={{ color:theme.textDim, marginBottom:12 }}>{error}</div>
            <button onClick={() => fetchTree()} style={{ background:'none', border:`1px solid ${theme.border}`, borderRadius:8, padding:'8px 16px', color:theme.text, cursor:'pointer' }}>Retry</button>
          </div>
        ) : entries.length === 0 ? (
          <div style={{ textAlign:'center', padding:32, color:theme.textDim }}>No files yet</div>
        ) : entries.map(e => (
          <div key={e.path} style={rowStyle} onClick={() => openEntry(e)}>
            <span style={{ color:theme.textDim, fontSize:18 }}>{e.isDir ? '📁' : '📄'}</span>
            <div style={{ flex:1, minWidth:0 }}>
              <div style={{ color:theme.text, fontSize:15, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{e.name}</div>
              <div style={{ color:theme.textDim, fontSize:12, marginTop:2 }}>{fmtDate(e.mtime)}</div>
            </div>
          </div>
        ))}
      </div>

      {/* FAB row */}
      <div style={{ display:'flex', gap:12, padding:'12px 16px', flexShrink:0, background:theme.bg, borderTop:`1px solid ${theme.border}` }}>
        <button onClick={() => setDumpOpen(true)} style={{ flex:1, background:theme.surface, border:`1px solid ${theme.border}`, borderRadius:12, padding:'13px 0', color:theme.text, fontSize:15, cursor:'pointer' }}>
          + Brain Dump
        </button>
        <button onClick={() => { setAskQ(''); setAskResults([]); setAskSearched(false); setAskOpen(true) }} style={{ flex:1, background:theme.surface, border:`1px solid ${theme.border}`, borderRadius:12, padding:'13px 0', color:ACCENT, fontSize:15, cursor:'pointer' }}>
          ? Ask
        </button>
      </div>

      {/* File viewer */}
      {fileOpen && (
        <div style={modalOverlay}>
          <div style={modalBox}>
            <div style={modalHdr}>
              <button onClick={() => { setFileOpen(false); setEditMode(false) }} style={{ background:'none', border:'none', cursor:'pointer', fontSize:18, color:theme.text, minWidth:44 }}>✕</button>
              <span style={{ flex:1, textAlign:'center', color:theme.text, fontSize:15, fontWeight:700, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{fileDetail?.path ?? '…'}</span>
              <button onClick={editMode ? saveFile : () => setEditMode(true)} disabled={saving || fileLoading}
                style={{ background:'none', border:'none', cursor:'pointer', color:theme.text, fontSize:15, minWidth:44 }}>
                {editMode ? (saving ? '…' : 'Save') : 'Edit'}
              </button>
            </div>
            {saveError && <div style={{ color:'#FF6135', fontSize:13, padding:'6px 16px' }}>{saveError}</div>}
            {fileLoading ? (
              <div style={{ flex:1, display:'flex', alignItems:'center', justifyContent:'center', color:theme.textDim }}>Loading…</div>
            ) : editMode ? (
              <textarea value={editContent} onChange={e => setEditContent(e.target.value)}
                style={{ flex:1, background:theme.inputBg, border:'none', padding:16, color:theme.text, fontSize:14, lineHeight:'1.6', resize:'none', outline:'none', fontFamily:'inherit' }} />
            ) : (
              <div style={{ flex:1, overflowY:'auto', padding:'16px 20px', color:theme.text, fontSize:15, lineHeight:'1.8' }}>
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    h1: ({children}) => <h1 style={{ color:theme.text, fontSize:24, fontWeight:700, margin:'0 0 12px', borderBottom:`1px solid ${theme.border}`, paddingBottom:6 }}>{children}</h1>,
                    h2: ({children}) => <h2 style={{ color:theme.text, fontSize:20, fontWeight:700, margin:'20px 0 8px' }}>{children}</h2>,
                    h3: ({children}) => <h3 style={{ color:theme.text, fontSize:17, fontWeight:600, margin:'16px 0 6px' }}>{children}</h3>,
                    h4: ({children}) => <h4 style={{ color:theme.text, fontSize:15, fontWeight:600, margin:'12px 0 4px' }}>{children}</h4>,
                    p:  ({children}) => <p style={{ margin:'0 0 12px', color:theme.text }}>{children}</p>,
                    strong: ({children}) => <strong style={{ color:theme.text, fontWeight:700 }}>{children}</strong>,
                    em: ({children}) => <em style={{ color:theme.textDim }}>{children}</em>,
                    a:  ({href, children}) => <a href={href} style={{ color:ACCENT, textDecoration:'underline' }}>{children}</a>,
                    ul: ({children}) => <ul style={{ margin:'0 0 12px', paddingLeft:20, color:theme.text }}>{children}</ul>,
                    ol: ({children}) => <ol style={{ margin:'0 0 12px', paddingLeft:20, color:theme.text }}>{children}</ol>,
                    li: ({children}) => <li style={{ marginBottom:4, color:theme.text }}>{children}</li>,
                    blockquote: ({children}) => <blockquote style={{ borderLeft:`3px solid ${ACCENT}`, margin:'12px 0', paddingLeft:12, color:theme.textDim, fontStyle:'italic' }}>{children}</blockquote>,
                    code: ({children}) => <code style={{ background:theme.surface, border:`1px solid ${theme.border}`, borderRadius:4, padding:'1px 5px', fontSize:13, color:ACCENT, fontFamily:'monospace' }}>{children}</code>,
                    pre: ({children}) => <pre style={{ background:theme.surface, border:`1px solid ${theme.border}`, borderRadius:8, padding:12, overflowX:'auto', margin:'0 0 12px', fontSize:13, fontFamily:'monospace', color:theme.text }}>{children}</pre>,
                    hr:  () => <hr style={{ border:'none', borderTop:`1px solid ${theme.border}`, margin:'16px 0' }} />,
                    table: ({children}) => <table style={{ borderCollapse:'collapse', width:'100%', margin:'0 0 12px', fontSize:14 }}>{children}</table>,
                    th: ({children}) => <th style={{ border:`1px solid ${theme.border}`, padding:'6px 10px', background:theme.surface, color:theme.text, fontWeight:600, textAlign:'left' }}>{children}</th>,
                    td: ({children}) => <td style={{ border:`1px solid ${theme.border}`, padding:'6px 10px', color:theme.text }}>{children}</td>,
                  }}
                >
                  {fileDetail?.content ?? ''}
                </ReactMarkdown>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Brain dump */}
      {dumpOpen && (
        <div style={modalOverlay}>
          <div style={modalBox}>
            <div style={modalHdr}>
              <button onClick={() => { setDumpOpen(false); setDumpText('') }} style={{ background:'none', border:'none', cursor:'pointer', fontSize:18, color:theme.text, minWidth:44 }}>✕</button>
              <span style={{ flex:1, textAlign:'center', color:theme.text, fontSize:15, fontWeight:700 }}>Brain Dump</span>
              <div style={{ minWidth:44 }} />
            </div>
            <textarea value={dumpText} onChange={e => setDumpText(e.target.value)} placeholder="What's on your mind?"
              autoFocus style={{ flex:1, background:theme.inputBg, border:'none', padding:16, color:theme.text, fontSize:15, lineHeight:'1.6', resize:'none', outline:'none', fontFamily:'inherit' }} />
            <div style={{ padding:16, flexShrink:0 }}>
              <button onClick={submitDump} disabled={!dumpText.trim() || dumpSaving}
                style={{ width:'100%', background:theme.surface, border:`1px solid ${theme.border}`, borderRadius:12, padding:'14px 0', color:theme.text, fontSize:15, fontWeight:700, cursor:'pointer', opacity:dumpText.trim() ? 1 : 0.4 }}>
                {dumpSaving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Ask */}
      {askOpen && (
        <div style={modalOverlay}>
          <div style={modalBox}>
            <div style={modalHdr}>
              <button onClick={() => setAskOpen(false)} style={{ background:'none', border:'none', cursor:'pointer', fontSize:18, color:theme.text, minWidth:44 }}>✕</button>
              <span style={{ flex:1, textAlign:'center', color:theme.text, fontSize:15, fontWeight:700 }}>Ask your wiki</span>
              <button onClick={runAsk} disabled={askLoading || !askQ.trim()}
                style={{ background:'none', border:'none', cursor:'pointer', color:askQ.trim() ? ACCENT : theme.textFaint, fontSize:15, minWidth:44 }}>
                {askLoading ? '…' : 'Search'}
              </button>
            </div>
            <input value={askQ} onChange={e => setAskQ(e.target.value)} onKeyDown={e => e.key === 'Enter' && runAsk()}
              placeholder="What do you want to know?" autoFocus
              style={{ background:theme.inputBg, border:'none', borderBottom:`1px solid ${theme.border}`, padding:'14px 16px', color:theme.text, fontSize:15, outline:'none', flexShrink:0 }} />
            <div style={{ flex:1, overflowY:'auto' }}>
              {askLoading ? (
                <div style={{ textAlign:'center', padding:32, color:theme.textDim }}>Searching…</div>
              ) : askSearched && askResults.length === 0 ? (
                <div style={{ padding:20, color:theme.textDim, fontSize:14 }}>No matches found. Try Reindex from ⋯.</div>
              ) : !askSearched ? (
                <div style={{ padding:20, color:theme.textDim, fontSize:14 }}>Ask a question to search your wiki.</div>
              ) : askResults.map((chunk, i) => (
                <div key={i} style={{ padding:'16px 20px', borderBottom:`1px solid ${theme.border}` }}>
                  <div style={{ color:ACCENT, fontSize:11, marginBottom:6 }}>{chunk.path}{chunk.heading ? ` › ${chunk.heading}` : ''}</div>
                  <div style={{ color:theme.text, fontSize:14, lineHeight:'1.6' }}>{chunk.text}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Tools sheet */}
      {toolsOpen && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.4)', zIndex:400 }} onClick={() => setToolsOpen(false)}>
          <div style={{ position:'absolute', bottom:0, left:0, right:0, background:theme.surface, borderRadius:'16px 16px 0 0', border:`1px solid ${theme.border}` }}
            onClick={e => e.stopPropagation()}>
            <div style={{ color:theme.textDim, fontSize:11, letterSpacing:1, padding:'12px 20px 4px' }}>KNOWLEDGE TOOLS</div>
            {[
              { id:'lint', icon:'🧠', title:'Lint Vault', desc:'Check links, stale pages', run: () => { setToolsOpen(false); runTool('lint','/wiki/lint') } },
              { id:'reindex', icon:'⬆', title:'Reindex', desc:'Embed changed files for Ask', run: () => { setToolsOpen(false); runTool('reindex','/knowledge/reindex') } },
              { id:'compile', icon:'⚙', title:'Compile', desc:'Turn raw notes into wiki pages', run: () => { setToolsOpen(false); runTool('compile','/wiki/compile') } },
              { id:'dupes', icon:'⊕', title:'Find Duplicates', desc:'Surface near-duplicate pages', run: () => { setToolsOpen(false); setDupesLoading(true); setDupesOpen(true); runTool('dupes','/knowledge/dupes','GET') } },
            ].map((t, i) => (
              <div key={t.id} style={{ display:'flex', alignItems:'center', gap:16, padding:'16px 20px', borderTop:i>0 ? `1px solid ${theme.border}` : 'none', cursor:'pointer' }} onClick={t.run}>
                <span style={{ color:ACCENT, fontSize:18, width:24, textAlign:'center' }}>{t.icon}</span>
                <div style={{ flex:1 }}>
                  <div style={{ color:theme.text, fontSize:15 }}>{t.title}</div>
                  <div style={{ color:theme.textDim, fontSize:12, marginTop:2 }}>{t.desc}</div>
                </div>
                {busy === t.id && <span style={{ color:theme.textDim }}>…</span>}
              </div>
            ))}
            <div style={{ height:20 }} />
          </div>
        </div>
      )}

      {/* Dupes */}
      {dupesOpen && (
        <div style={modalOverlay}>
          <div style={modalBox}>
            <div style={modalHdr}>
              <button onClick={() => setDupesOpen(false)} style={{ background:'none', border:'none', cursor:'pointer', fontSize:18, color:theme.text, minWidth:44 }}>✕</button>
              <span style={{ flex:1, textAlign:'center', color:theme.text, fontSize:15, fontWeight:700 }}>Duplicate pages</span>
              <div style={{ minWidth:44 }} />
            </div>
            <div style={{ flex:1, overflowY:'auto' }}>
              {dupesLoading ? (
                <div style={{ textAlign:'center', padding:32, color:theme.textDim }}>Checking…</div>
              ) : dupes.length === 0 ? (
                <div style={{ padding:20, color:theme.textDim, fontSize:14 }}>No near-duplicates found ✓</div>
              ) : dupes.map((d, i) => (
                <div key={i} style={{ padding:'16px 20px', borderBottom:`1px solid ${theme.border}` }}>
                  <div style={{ color:ACCENT, fontSize:11, marginBottom:6 }}>{Math.round(d.similarity*100)}% similar</div>
                  <div style={{ color:theme.text, fontSize:14 }}>{d.fileA}</div>
                  <div style={{ color:theme.textDim, fontSize:13, marginTop:2 }}>{d.fileB}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
