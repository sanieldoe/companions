import { useCallback } from 'react'
import { useAppState, useAppDispatch, ACCENTS, EMOJIS, NAMES } from '../store'
import { wsService } from '../ws'
import { dark, light } from '../theme'
import MessageList from './MessageList'
import InputBar from './InputBar'

interface Props { persona: 'mentor' | 'shapeshifter'; onSettings(): void }

export default function ChatTab({ persona, onSettings }: Props) {
  const state = useAppState()
  const dispatch = useAppDispatch()
  const theme = state.isDark ? dark : light
  const accent = ACCENTS[persona]
  const isStreaming = state.agentState === 'thinking' || state.agentState === 'talking'

  const handleSend = useCallback((text: string) => {
    dispatch({ type: 'ADD_USER_MESSAGE', text })
    wsService.send({ type: 'message', text })
  }, [dispatch])

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '12px 16px', borderBottom: `1px solid ${theme.border}`, flexShrink: 0,
      }}>
        <button onClick={onSettings} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 20, padding: '6px 10px', color: theme.text }}>≡</button>
        <span style={{ color: accent, fontWeight: 700, fontSize: 18 }}>{EMOJIS[persona]} {NAMES[persona]}</span>
        <button onClick={() => dispatch({ type: 'TOGGLE_THEME' })} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, padding: '6px 10px', color: theme.text }}>
          {state.isDark ? '🌙' : '☀️'}
        </button>
      </div>
      <div style={{ flex: 1, overflow: 'hidden' }}>
        <MessageList messages={state.messages} streamingText={state.streamingText}
          agentState={state.agentState} accent={accent} isDark={state.isDark} />
      </div>
      <InputBar accent={accent} isStreaming={isStreaming} onSend={handleSend}
        onAbort={() => wsService.send({ type: 'abort' })} isDark={state.isDark} />
    </div>
  )
}
