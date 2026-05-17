import { useEffect, useState, useRef } from 'react'
import { useAppState, useAppDispatch, newConversation, loadConversation, clearAllHistory, renameConversation, deleteConversation, moveConversation } from '../store'
import { apiFetch } from '../api'
import { wsService } from '../ws'
import { dark, light } from '../theme'

interface Props { open: boolean; onClose(): void }

interface ModelEntry { provider: string; id: string; name: string; contextWindow: number }
interface ProviderInfo { authStatus: { configured: boolean; source?: string }; models: ModelEntry[] }

const FEATURED = [
  { id: 'anthropic', label: 'Anthropic', oauth: false },
  { id: 'openai', label: 'OpenAI', oauth: false },
  { id: 'github-copilot', label: 'GitHub Copilot', oauth: true },
]

const CLOUD_PROVIDER_IDS = new Set([
  'amazon-bedrock','anthropic','azure-openai-responses','cerebras','deepseek',
  'fireworks','github-copilot','google','google-antigravity','google-gemini-cli',
  'google-vertex','groq','huggingface','kimi-coding','minimax','minimax-cn',
  'mistral','openai','openai-codex','opencode','opencode-go','openrouter',
  'vercel-ai-gateway','xai','zai',
])

function formatDate(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 86400000) return 'Today'
  if (diff < 172800000) return 'Yesterday'
  const d = new Date(ts)
  return `${d.getDate()} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()]}`
}

export default function SettingsModal({ open, onClose }: Props) {
  const state = useAppState()
  const dispatch = useAppDispatch()
  const theme = state.isDark ? dark : light

  const [providers, setProviders] = useState<Record<string, ProviderInfo>>({})
  const [chatModel, setChatModel] = useState<{ provider: string; modelId: string } | null>(null)
  const [loading, setLoading] = useState(false)

  // API key flow
  const [keyProvider, setKeyProvider] = useState<string | null>(null)
  const [keyValue, setKeyValue] = useState('')
  const [keySaving, setKeySaving] = useState(false)

  // OAuth flow
  const [oauthProvider, setOauthProvider] = useState<string | null>(null)
  const [oauthUrl, setOauthUrl] = useState<string | null>(null)
  const [oauthCode, setOauthCode] = useState<string | null>(null)
  const [oauthPolling, setOauthPolling] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Model picker
  const [modelPickerOpen, setModelPickerOpen] = useState(false)

  // Conversation folder UI
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set())
  const [newFolderName, setNewFolderName] = useState('')
  const [showNewFolder, setShowNewFolder] = useState(false)
  const [newConvoFolder, setNewConvoFolder] = useState<string | undefined>(undefined)
  const [showNewConvoFolderPicker, setShowNewConvoFolderPicker] = useState(false)

  // Conversation rename / more-menu state
  const [renameTargetId, setRenameTargetId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [moreMenuId, setMoreMenuId] = useState<string | null>(null)
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)

  const toggleFolder = (folder: string) => {
    setExpandedFolders(prev => {
      const next = new Set(prev)
      next.has(folder) ? next.delete(folder) : next.add(folder)
      return next
    })
  }

  const folders = Array.from(
    new Set(state.conversations.map(c => c.folder).filter((f): f is string => !!f))
  ).sort()
  const byFolder = (folder: string) => state.conversations.filter(c => c.folder === folder)
  const unfiled = state.conversations.filter(c => !c.folder)

  const stopPolling = () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null } }
  useEffect(() => () => stopPolling(), [])

  async function loadData() {
    if (!state.serverUrl || !state.token) return
    setLoading(true)
    try {
      const [provRes, modelRes] = await Promise.all([
        apiFetch(state.serverUrl, state.token, '/providers'),
        apiFetch(state.serverUrl, state.token, '/modes/chat/model'),
      ])
      if (provRes.ok) { const d = await provRes.json(); setProviders(d.providers ?? {}) }
      if (modelRes.ok) { const d = await modelRes.json(); setChatModel(d.model ?? null) }
    } catch { /* ignore */ }
    setLoading(false)
  }

  useEffect(() => { if (open) loadData() }, [open])

  async function saveKey() {
    if (!keyProvider || !keyValue.trim() || !state.serverUrl || !state.token) return
    setKeySaving(true)
    try {
      const res = await apiFetch(state.serverUrl, state.token, `/providers/${keyProvider}/apikey`, {
        method: 'POST', body: JSON.stringify({ key: keyValue.trim() }),
      })
      if (res.ok) { setKeyProvider(null); setKeyValue(''); await loadData() }
    } catch { /* ignore */ }
    setKeySaving(false)
  }

  async function removeKey(id: string) {
    if (!state.serverUrl || !state.token) return
    await apiFetch(state.serverUrl, state.token, `/providers/${id}/apikey`, { method: 'DELETE' }).catch(() => {})
    setKeyProvider(null); setKeyValue(''); await loadData()
  }

  async function startOAuth(id: string) {
    if (!state.serverUrl || !state.token) return
    stopPolling(); setOauthProvider(id); setOauthUrl(null); setOauthCode(null); setOauthPolling(false)
    try {
      const res = await apiFetch(state.serverUrl, state.token, `/providers/${id}/login`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok || !data.authUrl) return
      setOauthUrl(data.authUrl); setOauthCode(data.userCode ?? null); setOauthPolling(true)
      pollRef.current = setInterval(async () => {
        try {
          const r = await apiFetch(state.serverUrl!, state.token!, `/providers/${id}/login/status`)
          const s = await r.json()
          if (s.done) { stopPolling(); setOauthPolling(false); setOauthProvider(null); setOauthUrl(null); setOauthCode(null); await loadData() }
        } catch { stopPolling(); setOauthPolling(false) }
      }, 3000)
    } catch { setOauthProvider(null) }
  }

  function cancelOAuth() { stopPolling(); setOauthProvider(null); setOauthUrl(null); setOauthCode(null); setOauthPolling(false) }

  async function selectModel(provider: string, modelId: string) {
    if (!state.serverUrl || !state.token) return
    const res = await apiFetch(state.serverUrl, state.token, '/modes/chat/model', {
      method: 'PUT', body: JSON.stringify({ provider, modelId }),
    }).catch(() => null)
    if (res?.ok) { setChatModel({ provider, modelId }); setModelPickerOpen(false) }
  }

  async function resetModel() {
    if (!state.serverUrl || !state.token) return
    await apiFetch(state.serverUrl, state.token, '/modes/chat/model', {
      method: 'PUT', body: 'null',
    }).catch(() => {})
    setChatModel(null); setModelPickerOpen(false)
  }

  if (!open) return null

  const sortedModels: ModelEntry[] = Object.entries(providers)
    .sort(([, a], [, b]) => (b.authStatus.configured ? 1 : 0) - (a.authStatus.configured ? 1 : 0))
    .flatMap(([, info]) => info.models)

  const localProviders = Object.entries(providers).filter(([id]) => !CLOUD_PROVIDER_IDS.has(id))

  const row: React.CSSProperties = {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '13px 16px', cursor: 'pointer', borderBottom: `1px solid ${theme.border}`,
  }
  const sectionLabel: React.CSSProperties = {
    color: theme.textDim, fontSize: 11, fontWeight: 700, letterSpacing: 0.8,
    padding: '18px 16px 6px', textTransform: 'uppercase' as const,
  }
  const card: React.CSSProperties = {
    background: theme.surface, borderRadius: 12,
    border: `1px solid ${theme.border}`, overflow: 'hidden', marginBottom: 4,
  }

  const renderConvo = (c: typeof state.conversations[0]) => {
    const isActive = c.id === state.activeConversationId
    const isRenaming = renameTargetId === c.id
    const isMoreOpen = moreMenuId === c.id
    const isDeleteConfirm = deleteConfirmId === c.id

    return (
      <div key={c.id} style={{ borderBottom: `1px solid ${theme.border}` }}>
        <div style={{ display: 'flex', alignItems: 'center', padding: '10px 4px 10px 16px' }}>
          {/* Main clickable area */}
          <div
            style={{ flex: 1, cursor: isActive ? 'default' : 'pointer', marginRight: 4 }}
            onClick={() => { if (!isRenaming && !isActive) { loadConversation(dispatch, state.serverUrl!, state.token!, c.id); onClose() } }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 }}>
              <span style={{ color: theme.textFaint, fontSize: 11 }}>{formatDate(c.startedAt)}</span>
              {isActive && <span style={{ color: '#4CAF50', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }}>current</span>}
            </div>
            {isRenaming ? (
              <input
                type="text"
                value={renameDraft}
                onChange={e => setRenameDraft(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    if (renameDraft.trim()) renameConversation(dispatch, state.serverUrl!, state.token!, c.id, renameDraft.trim())
                    setRenameTargetId(null)
                  }
                  if (e.key === 'Escape') setRenameTargetId(null)
                }}
                onBlur={() => {
                  if (renameDraft.trim()) renameConversation(dispatch, state.serverUrl!, state.token!, c.id, renameDraft.trim())
                  setRenameTargetId(null)
                }}
                autoFocus
                style={{ width: '100%', background: theme.inputBg, border: `1px solid ${theme.border}`, borderRadius: 6, padding: '4px 8px', color: theme.text, fontSize: 14, outline: 'none', boxSizing: 'border-box' as const }}
              />
            ) : (
              <div style={{ color: isActive ? theme.textDim : theme.text, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>
                {c.title}
              </div>
            )}
          </div>

          {/* Action buttons */}
          <div style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
            <button
              onClick={() => { setRenameTargetId(c.id); setRenameDraft(c.title); setMoreMenuId(null) }}
              style={{ background: 'none', border: 'none', color: theme.textDim, cursor: 'pointer', fontSize: 16, padding: '6px 8px' }}
            >✎</button>
            <div style={{ position: 'relative' as const }}>
              <button
                onClick={() => { setMoreMenuId(isMoreOpen ? null : c.id); setDeleteConfirmId(null) }}
                style={{ background: 'none', border: 'none', color: theme.textDim, cursor: 'pointer', fontSize: 16, padding: '6px 8px' }}
              >⋯</button>
              {isMoreOpen && (
                <div style={{
                  position: 'absolute' as const, right: 0, top: '100%', zIndex: 10,
                  background: theme.surface, border: `1px solid ${theme.border}`,
                  borderRadius: 8, minWidth: 180, boxShadow: '0 4px 16px rgba(0,0,0,0.2)',
                }}>
                  {folders.filter(f => f !== c.folder).map(f => (
                    <div
                      key={f}
                      style={{ padding: '10px 14px', cursor: 'pointer', color: theme.text, fontSize: 14, borderBottom: `1px solid ${theme.border}` }}
                      onClick={() => { moveConversation(dispatch, c.id, f); setMoreMenuId(null) }}
                    >Move to "📁 {f}"</div>
                  ))}
                  {c.folder && (
                    <div
                      style={{ padding: '10px 14px', cursor: 'pointer', color: theme.text, fontSize: 14, borderBottom: `1px solid ${theme.border}` }}
                      onClick={() => { moveConversation(dispatch, c.id, undefined); setMoreMenuId(null) }}
                    >Remove from folder</div>
                  )}
                  {isDeleteConfirm ? (
                    <div style={{ padding: '10px 14px' }}>
                      <div style={{ color: theme.text, fontSize: 13, marginBottom: 8 }}>Are you sure?</div>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button
                          onClick={() => { deleteConversation(dispatch, state.serverUrl!, state.token!, c.id); setMoreMenuId(null); setDeleteConfirmId(null) }}
                          style={{ flex: 1, padding: '6px 0', background: '#ff453a22', color: '#ff453a', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13 }}
                        >Yes, delete</button>
                        <button
                          onClick={() => setDeleteConfirmId(null)}
                          style={{ flex: 1, padding: '6px 0', background: theme.surfaceAlt, color: theme.textDim, border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13 }}
                        >Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <div
                      style={{ padding: '10px 14px', cursor: 'pointer', color: '#ff453a', fontSize: 14 }}
                      onClick={() => setDeleteConfirmId(c.id)}
                    >Delete</div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 300, background: 'rgba(0,0,0,0.5)' }} onClick={onClose}>
      <div
        style={{ position: 'absolute', bottom: 0, left: 0, right: 0, background: theme.bg, borderRadius: '20px 20px 0 0', maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Handle + header */}
        <div style={{ padding: '12px 16px 0', flexShrink: 0 }}>
          <div style={{ width: 40, height: 4, background: theme.border, borderRadius: 2, margin: '0 auto 12px' }} />
          <div style={{ color: theme.text, fontSize: 18, fontWeight: 700, marginBottom: 8 }}>Settings</div>
        </div>

        <div style={{ overflowY: 'auto', flex: 1, paddingBottom: 40 }}>
          {loading && <div style={{ color: theme.textDim, textAlign: 'center', padding: 24 }}>Loading…</div>}

          {/* ── CONVERSATIONS ── */}
          <div style={sectionLabel}>Conversations</div>
          <div style={card}>
            {/* New conversation row with folder picker */}
            <div style={row} onClick={() => setShowNewConvoFolderPicker(v => !v)}>
              <span style={{ color: theme.text, fontSize: 15 }}>✏️&nbsp; New conversation</span>
              <span style={{ color: theme.textDim, fontSize: 13 }}>
                {newConvoFolder ? `📁 ${newConvoFolder}` : 'No folder'} ▾
              </span>
            </div>

            {/* Folder picker for new conversation */}
            {showNewConvoFolderPicker && (
              <div style={{ background: theme.surfaceAlt, borderTop: `1px solid ${theme.border}`, padding: "4px 0" }}>
                <div
                  style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 20px', cursor: 'pointer', borderBottom: `1px solid ${theme.border}` }}
                  onClick={() => { setNewConvoFolder(undefined); setShowNewConvoFolderPicker(false); newConversation(dispatch, state.serverUrl!, state.token!); onClose() }}
                >
                  <span style={{ color: theme.text, fontSize: 14 }}>No folder</span>
                  {!newConvoFolder && <span style={{ color: '#4CAF50' }}>✓</span>}
                </div>
                {folders.map(f => (
                  <div
                    key={f}
                    style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 20px', cursor: 'pointer', borderBottom: `1px solid ${theme.border}` }}
                    onClick={() => { setNewConvoFolder(f); setShowNewConvoFolderPicker(false); newConversation(dispatch, state.serverUrl!, state.token!); onClose() }}
                  >
                    <span style={{ color: theme.text, fontSize: 14 }}>📁 {f}</span>
                    {newConvoFolder === f && <span style={{ color: '#4CAF50' }}>✓</span>}
                  </div>
                ))}
              </div>
            )}

            {/* New folder row */}
            <div style={row} onClick={() => setShowNewFolder(v => !v)}>
              <span style={{ color: theme.text, fontSize: 15 }}>📁&nbsp; New folder</span>
              <span style={{ color: theme.textDim, fontSize: 13 }}>{showNewFolder ? '↑' : '+'}</span>
            </div>
            {showNewFolder && (
              <div style={{ background: theme.surfaceAlt, borderTop: `1px solid ${theme.border}`, padding: '12px 16px 14px' }}>
                <input
                  type="text"
                  value={newFolderName}
                  onChange={e => setNewFolderName(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      const name = newFolderName.trim().toLowerCase().replace(/\s+/g, '-')
                      if (name) {
                        setNewConvoFolder(name)
                        newConversation(dispatch, state.serverUrl!, state.token!)
                        setNewFolderName('')
                        setShowNewFolder(false)
                        setExpandedFolders(prev => new Set([...prev, name]))
                        onClose()
                      }
                    }
                  }}
                  placeholder="Folder name…"
                  autoFocus
                  style={{ width: '100%', background: theme.inputBg, border: `1px solid ${theme.border}`, borderRadius: 8, padding: '10px 12px', color: theme.text, fontSize: 14, outline: 'none', boxSizing: 'border-box' as const, marginBottom: 10 }}
                />
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <button
                    onClick={() => {
                      const name = newFolderName.trim().toLowerCase().replace(/\s+/g, '-')
                      if (name) {
                        setNewConvoFolder(name)
                        newConversation(dispatch, state.serverUrl!, state.token!)
                        setNewFolderName('')
                        setShowNewFolder(false)
                        setExpandedFolders(prev => new Set([...prev, name]))
                        onClose()
                      }
                    }}
                    disabled={!newFolderName.trim()}
                    style={{ padding: '7px 18px', borderRadius: 8, border: 'none', background: '#4CAF50', color: '#fff', cursor: 'pointer', fontSize: 14, fontWeight: 700, opacity: newFolderName.trim() ? 1 : 0.4 }}
                  >Create + open</button>
                </div>
              </div>
            )}

            {/* Folder tree */}
            {state.conversations.length > 0 && (
              <>
                {/* Folders with their conversations */}
                {folders.map(folder => {
                  const isOpen = expandedFolders.has(folder)
                  const folderConvos = byFolder(folder)
                  return (
                    <div key={folder}>
                      <div
                        style={{ ...row, cursor: 'pointer' }}
                        onClick={() => toggleFolder(folder)}
                      >
                        <span style={{ color: theme.text, fontSize: 14, fontWeight: 700 }}>
                          {isOpen ? '▾' : '▸'} 📁 {folder}
                        </span>
                        <span style={{ color: theme.textFaint, fontSize: 12 }}>{folderConvos.length}</span>
                      </div>
                      {isOpen && folderConvos.map(c => renderConvo(c))}
                    </div>
                  )
                })}

                {/* Unfiled */}
                {unfiled.length > 0 && (
                  <div>
                    {folders.length > 0 && (
                      <div style={{ ...row, cursor: 'default' }}>
                        <span style={{ color: theme.textDim, fontSize: 14, fontWeight: 700 }}>Unfiled</span>
                        <span style={{ color: theme.textFaint, fontSize: 12 }}>{unfiled.length}</span>
                      </div>
                    )}
                    {unfiled.map(c => renderConvo(c))}
                  </div>
                )}
              </>
            )}

            <div style={{ ...row, borderBottom: 'none' }} onClick={() => { clearAllHistory(dispatch, state.serverUrl!, state.token!); onClose() }}>
              <span style={{ color: '#f87171', fontSize: 15 }}>🗑&nbsp; Clear all history</span>
            </div>
          </div>

          {/* ── PROVIDERS ── */}
          <div style={sectionLabel}>Providers</div>
          <div style={card}>
            {FEATURED.map(({ id, label, oauth }, i) => {
              const info = providers[id]
              const configured = info?.authStatus?.configured ?? false
              const isKeyExpanded = keyProvider === id
              const isOAuthActive = oauthProvider === id
              return (
                <div key={id}>
                  {i > 0 && <div style={{ height: 1, background: theme.border, marginLeft: 16 }} />}
                  <div style={row} onClick={() => {
                    if (oauth) { isOAuthActive ? cancelOAuth() : startOAuth(id) }
                    else { setKeyProvider(isKeyExpanded ? null : id); setKeyValue('') }
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div style={{ width: 8, height: 8, borderRadius: 4, background: configured ? '#4CAF50' : theme.border }} />
                      <span style={{ color: theme.text, fontSize: 15 }}>{label}</span>
                      {configured && info?.authStatus?.source && (
                        <span style={{ color: theme.textFaint, fontSize: 12 }}>{info.authStatus.source}</span>
                      )}
                    </div>
                    <span style={{ color: theme.textDim, fontSize: 13 }}>
                      {oauth ? (configured ? 'Re-login' : 'Login') : (configured ? (isKeyExpanded ? '↑' : 'Change') : 'Add key')}
                    </span>
                  </div>

                  {/* API key panel */}
                  {!oauth && isKeyExpanded && (
                    <div style={{ background: theme.surfaceAlt, borderTop: `1px solid ${theme.border}`, padding: '12px 16px 14px' }}>
                      <input
                        type="password" value={keyValue} onChange={e => setKeyValue(e.target.value)}
                        placeholder="Paste API key…" autoFocus
                        style={{ width: '100%', background: theme.inputBg, border: `1px solid ${theme.border}`, borderRadius: 8, padding: '10px 12px', color: theme.text, fontSize: 14, outline: 'none', boxSizing: 'border-box' as const }}
                      />
                      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 10 }}>
                        {configured && (
                          <button onClick={() => removeKey(id)} style={{ padding: '7px 14px', borderRadius: 8, border: 'none', background: '#ff453a22', color: '#ff453a', cursor: 'pointer', fontSize: 14 }}>
                            Remove
                          </button>
                        )}
                        <button onClick={saveKey} disabled={!keyValue.trim() || keySaving}
                          style={{ padding: '7px 18px', borderRadius: 8, border: 'none', background: '#4CAF50', color: '#fff', cursor: 'pointer', fontSize: 14, fontWeight: 700, opacity: keyValue.trim() ? 1 : 0.4 }}>
                          {keySaving ? '…' : 'Save'}
                        </button>
                      </div>
                    </div>
                  )}

                  {/* OAuth panel */}
                  {oauth && isOAuthActive && oauthUrl && (
                    <div style={{ background: theme.surfaceAlt, borderTop: `1px solid ${theme.border}`, padding: '12px 16px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <span style={{ color: theme.text, fontSize: 13 }}>1. Open this URL in a browser:</span>
                      <a href={oauthUrl} target="_blank" rel="noreferrer" style={{ color: '#42A5F5', fontSize: 13, wordBreak: 'break-all' as const }}>{oauthUrl}</a>
                      {oauthCode && (
                        <>
                          <span style={{ color: theme.text, fontSize: 13 }}>2. Enter this code:</span>
                          <div style={{ background: theme.inputBg, border: `1px solid ${theme.border}`, borderRadius: 8, padding: '10px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ color: theme.text, fontSize: 20, fontWeight: 700, letterSpacing: 3 }}>{oauthCode}</span>
                            <span style={{ color: theme.textFaint, fontSize: 11 }}>tap to copy</span>
                          </div>
                        </>
                      )}
                      {oauthPolling && <span style={{ color: theme.textFaint, fontSize: 13 }}>⏳ Waiting for authorization…</span>}
                      <button onClick={cancelOAuth} style={{ alignSelf: 'flex-end', background: 'none', border: 'none', color: theme.textDim, cursor: 'pointer', fontSize: 13 }}>Cancel</button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {/* ── LOCAL MODELS ── */}
          <div style={sectionLabel}>Local Models</div>
          <div style={card}>
            <div style={{ color: theme.textDim, fontSize: 13, padding: '12px 16px', lineHeight: '20px' }}>
              Add ollama, llama.cpp, lmstudio, or omlx via{' '}
              <span style={{ color: theme.text }}>~/.pi/agent/models.json</span>
            </div>
            {localProviders.map(([id, info], i) => (
              <div key={id} style={{ ...row, borderTop: i === 0 ? `1px solid ${theme.border}` : undefined, borderBottom: 'none' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ width: 8, height: 8, borderRadius: 4, background: info.authStatus.configured ? '#4CAF50' : theme.border }} />
                  <span style={{ color: theme.text, fontSize: 15 }}>{id}</span>
                  <span style={{ color: theme.textFaint, fontSize: 12 }}>
                    {info.models.length} model{info.models.length !== 1 ? 's' : ''}
                  </span>
                </div>
              </div>
            ))}
          </div>

          {/* ── CHAT MODEL ── */}
          <div style={sectionLabel}>Chat Model</div>
          <div style={card}>
            <div style={row} onClick={() => setModelPickerOpen(v => !v)}>
              <span style={{ color: theme.text, fontSize: 15 }}>Mentor &amp; Shapeshifter</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ color: theme.textDim, fontSize: 13, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {chatModel ? `${chatModel.provider} / ${chatModel.modelId}` : 'default'}
                </span>
                <span style={{ color: theme.textDim, fontSize: 13 }}>{modelPickerOpen ? '↑' : 'Change'}</span>
              </div>
            </div>
            {modelPickerOpen && (
              <div style={{ background: theme.surfaceAlt, borderTop: `1px solid ${theme.border}` }}>
                <div style={{ ...row, borderBottom: `1px solid ${theme.border}` }} onClick={resetModel}>
                  <div>
                    <div style={{ color: theme.text, fontSize: 14 }}>Default</div>
                    <div style={{ color: theme.textFaint, fontSize: 12 }}>From server config</div>
                  </div>
                  {!chatModel && <span style={{ color: '#4CAF50' }}>✓</span>}
                </div>
                {sortedModels.map(m => {
                  const available = providers[m.provider]?.authStatus?.configured ?? false
                  const selected = chatModel?.provider === m.provider && chatModel?.modelId === m.id
                  return (
                    <div key={`${m.provider}/${m.id}`}
                      style={{ ...row, opacity: available ? 1 : 0.45, borderBottom: `1px solid ${theme.border}` }}
                      onClick={() => available && selectModel(m.provider, m.id)}>
                      <div>
                        <div style={{ color: theme.text, fontSize: 14 }}>{m.name}</div>
                        <div style={{ color: theme.textFaint, fontSize: 12 }}>
                          {m.provider} · {Math.round(m.contextWindow / 1000)}k ctx{!available ? ' · not configured' : ''}
                        </div>
                      </div>
                      {selected && <span style={{ color: '#4CAF50' }}>✓</span>}
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* ── ACCOUNT ── */}
          <div style={sectionLabel}>Account</div>
          <div style={card}>
            {state.serverUrl && (
              <div style={{ ...row, cursor: 'default' }}>
                <span style={{ color: theme.textFaint, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>
                  {state.serverUrl}
                </span>
              </div>
            )}
            <div style={{ ...row, borderBottom: 'none' }} onClick={() => { wsService.disconnect(); dispatch({ type: 'LOGOUT' }); onClose() }}>
              <span style={{ color: '#f87171', fontSize: 15 }}>🔌&nbsp; Disconnect</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
