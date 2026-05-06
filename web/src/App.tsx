import { useEffect, useRef } from 'react'
import { useAppState, useAppDispatch, loadConversations } from './store'
import { wsService } from './ws'
import Setup from './components/Setup'
import Main from './components/Main'

export default function App() {
  const state = useAppState()
  const dispatch = useAppDispatch()
  const ref = useRef(state)
  ref.current = state

  useEffect(() => {
    wsService.init(dispatch, () => ({
      serverUrl: ref.current.serverUrl,
      token: ref.current.token,
      currentMode: ref.current.currentMode,
    }))
    return () => wsService.disconnect()
  }, [])

  // Connect (or reconnect) whenever credentials become available.
  useEffect(() => {
    if (state.serverUrl && state.token) wsService.connect()
  }, [state.serverUrl, state.token])

  // Load conversations once connected.
  useEffect(() => {
    if (state.connected && state.serverUrl && state.token) {
      loadConversations(dispatch, state.serverUrl, state.token)
    }
  }, [state.connected])

  if (!state.serverUrl || !state.token) return <Setup />
  return <Main />
}
