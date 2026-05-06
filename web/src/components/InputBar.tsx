import { useState } from 'react'
import { dark, light } from '../theme'

interface Props { accent: string; isStreaming: boolean; onSend(t: string): void; onAbort(): void; isDark: boolean }

export default function InputBar({ accent, isStreaming, onSend, onAbort, isDark }: Props) {
  const [text, setText] = useState('')
  const theme = isDark ? dark : light
  const can = text.trim().length > 0 && !isStreaming

  function send() { if (!can) return; onSend(text.trim()); setText('') }

  return (
    <div style={{ padding: '8px 12px 12px', flexShrink: 0 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <textarea
          value={text} onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
          placeholder="Say something..." rows={1}
          style={{ flex: 1, background: theme.inputBg, border: 'none', borderRadius: 20, padding: '12px 16px', fontSize: 16, color: theme.text, outline: 'none', resize: 'none', maxHeight: 120, overflowY: 'auto' }}
        />
        {isStreaming ? (
          <button onClick={onAbort} style={{ width: 44, height: 44, borderRadius: 22, background: theme.surfaceAlt, border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <div style={{ width: 14, height: 14, borderRadius: 2, background: theme.textDim }} />
          </button>
        ) : (
          <button onClick={send} disabled={!can} style={{ width: 44, height: 44, borderRadius: 22, background: accent, border: 'none', cursor: can ? 'pointer' : 'default', opacity: can ? 1 : 0.4, color: '#fff', fontSize: 20, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            ↑
          </button>
        )}
      </div>
    </div>
  )
}
