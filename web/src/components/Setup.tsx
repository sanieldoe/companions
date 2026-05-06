import { useState } from 'react'
import { useAppDispatch } from '../store'
import { wsService } from '../ws'

// Derive ws/wss URL from the page origin — app is always served from the same server
function defaultServerUrl(): string {
  return window.location.origin.replace(/^http/, 'ws')
}

export default function Setup() {
  const dispatch = useAppDispatch()
  const [url, setUrl] = useState(defaultServerUrl)
  const [secret, setSecret] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function connect() {
    setError(null)
    const u = url.trim(); const s = secret.trim()
    if (!u) { setError('Enter a server address'); return }
    if (!s) { setError('Enter the secret key'); return }
    const norm = /^https?:\/\//i.test(u) || /^wss?:\/\//i.test(u) ? u : 'ws://' + u
    const http = norm.replace(/^ws:\/\//i, 'http://').replace(/^wss:\/\//i, 'https://')
    setLoading(true)
    try {
      const res = await fetch(`${http}/auth/token`, {
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: s }),
      })
      if (!res.ok) { setError(`Auth failed: ${res.status}`); return }
      const data = await res.json()
      if (!data.token) { setError('No token returned'); return }
      dispatch({ type: 'SET_CREDENTIALS', serverUrl: norm, token: data.token })
    } catch (e) {
      setError(`Could not connect: ${e instanceof Error ? e.message : String(e)}`)
    } finally { setLoading(false) }
  }

  const inp: React.CSSProperties = {
    background: '#1A1814', border: '1px solid #333', borderRadius: 12,
    color: '#E8E4DC', padding: '14px 16px', fontSize: 16, outline: 'none', width: '100%',
  }

  return (
    <div style={{ height: '100%', background: '#0D0B08', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div style={{ width: '100%', maxWidth: 400, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ textAlign: 'center', marginBottom: 8 }}>
          <div style={{ fontSize: 48, marginBottom: 8 }}>🐸</div>
          <div style={{ color: '#4CAF50', fontSize: 28, fontWeight: 700 }}>Companion</div>
          <div style={{ color: '#666', fontSize: 14, marginTop: 4 }}>Connect to your server</div>
        </div>
        <input value={url} onChange={e => setUrl(e.target.value)} placeholder="ws://localhost:3000"
          style={inp} onKeyDown={e => e.key === 'Enter' && connect()} />
        <input value={secret} onChange={e => setSecret(e.target.value)} placeholder="Secret key"
          type="password" style={inp} onKeyDown={e => e.key === 'Enter' && connect()} />
        <button onClick={connect} disabled={loading} style={{
          background: '#4CAF50', color: '#fff', border: 'none', borderRadius: 12,
          padding: '14px 16px', fontSize: 16, fontWeight: 700, cursor: 'pointer',
          width: '100%', opacity: loading ? 0.7 : 1,
        }}>
          {loading ? 'Connecting...' : 'Connect'}
        </button>
        {error && <div style={{ color: '#f87171', fontSize: 13, textAlign: 'center' }}>{error}</div>}
      </div>
    </div>
  )
}
