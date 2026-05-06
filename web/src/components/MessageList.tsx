import { useRef, useEffect } from 'react'
import { Message, AgentState } from '../types'
import { dark, light } from '../theme'
import { ACCENTS, EMOJIS } from '../store'

interface Props {
  messages: Message[]; streamingText: string
  agentState: AgentState; accent: string; isDark: boolean
}

function fmt(ts: number) {
  const d = new Date(ts)
  const h = d.getHours() % 12 || 12
  const m = d.getMinutes().toString().padStart(2, '0')
  return `${h}:${m} ${d.getHours() >= 12 ? 'PM' : 'AM'}`
}

export default function MessageList({ messages, streamingText, agentState, accent, isDark }: Props) {
  const theme = isDark ? dark : light
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length, streamingText])

  const showTyping = agentState === 'thinking' && !streamingText

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: '12px 16px' }}>
      {messages.map((msg, i) => {
        const isUser = msg.role === 'user'
        const prev = messages[i - 1]
        const showTs = !prev || msg.timestamp - prev.timestamp > 120000
        const bdrColor = !isUser && msg.persona ? (ACCENTS[msg.persona] ?? 'transparent') : 'transparent'
        return (
          <div key={msg.id}>
            {showTs && (
              <div style={{ textAlign: 'center', color: theme.textFaint, fontSize: 11, margin: '8px 0 4px' }}>
                {fmt(msg.timestamp)}
              </div>
            )}
            {!isUser && msg.persona && (
              <div style={{ color: ACCENTS[msg.persona] ?? theme.textDim, fontSize: 12, fontWeight: 700, marginBottom: 2, marginLeft: 2 }}>
                {EMOJIS[msg.persona]} {msg.persona.charAt(0).toUpperCase() + msg.persona.slice(1)}
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: isUser ? 'flex-end' : 'flex-start', marginBottom: 6 }}>
              <div style={{
                maxWidth: '80%', padding: '10px 14px', borderRadius: 18,
                borderBottomRightRadius: isUser ? 4 : 18,
                borderBottomLeftRadius: isUser ? 18 : 4,
                background: isUser ? accent : theme.surface,
                color: isUser ? '#fff' : theme.text,
                fontSize: 15, lineHeight: 1.5,
                borderLeft: !isUser ? `2px solid ${bdrColor}` : undefined,
              }}>
                {msg.text}
              </div>
            </div>
          </div>
        )
      })}

      {showTyping && (
        <div style={{ display: 'flex', gap: 4, padding: '10px 14px', background: theme.surface, borderRadius: 18, borderBottomLeftRadius: 4, width: 'fit-content', marginBottom: 6 }}>
          {[0, 1, 2].map(i => (
            <div key={i} style={{ width: 6, height: 6, borderRadius: 3, background: theme.textDim, animation: `bounce 1.2s ease-in-out ${i * 0.2}s infinite` }} />
          ))}
        </div>
      )}

      {streamingText && (
        <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: 6 }}>
          <div style={{ maxWidth: '80%', padding: '10px 14px', borderRadius: 18, borderBottomLeftRadius: 4, background: theme.surface, color: theme.text, fontSize: 15, lineHeight: 1.5 }}>
            {streamingText}
          </div>
        </div>
      )}

      <div ref={endRef} />
    </div>
  )
}
