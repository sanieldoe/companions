import React, { createContext, useContext, useReducer, ReactNode } from 'react'
import { AppState, AppAction, Message, ConversationMeta } from './types'
import { apiFetch } from './api'

export type { ConversationMeta }

export const ACCENTS: Record<string, string> = { mentor: '#4CAF50', shapeshifter: '#FF6135', keeper: '#FFD54F', tracker: '#42A5F5' }
export const EMOJIS: Record<string, string> = { mentor: '🐸', shapeshifter: '🦊', keeper: '🐝', tracker: '🐦' }
export const NAMES: Record<string, string> = { mentor: 'Mentor', shapeshifter: 'Shapeshifter', keeper: 'Keeper', tracker: 'Tracker' }

function init(): AppState {
  return {
    serverUrl: localStorage.getItem('serverUrl'),
    token: localStorage.getItem('token'),
    connected: false, agentState: 'idle',
    messages: JSON.parse(localStorage.getItem('messages') || '[]'),
    streamingText: '', currentMode: 'mentor', modes: [],
    isDark: localStorage.getItem('isDark') !== 'false',
    autoRoute: true, routeToast: null, calDigest: null, activeTab: 'mentor',
    activeConversationId: localStorage.getItem('active_conversation_id'),
    conversations: JSON.parse(localStorage.getItem('conversation_index') || '[]'),
  }
}

function reducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'SET_CREDENTIALS':
      localStorage.setItem('serverUrl', action.serverUrl)
      localStorage.setItem('token', action.token)
      return { ...state, serverUrl: action.serverUrl, token: action.token }
    case 'SET_CONNECTED': return { ...state, connected: action.value }
    case 'SET_AGENT_STATE': return { ...state, agentState: action.value }
    case 'APPEND_TOKEN': return { ...state, streamingText: state.streamingText + action.text }
    case 'COMMIT_MESSAGE': {
      if (!state.streamingText.trim()) return { ...state, streamingText: '' }
      const msg: Message = {
        id: `assistant-${Date.now()}`, role: 'assistant',
        text: state.streamingText.trim(), timestamp: Date.now(), persona: action.persona,
      }
      const updated = [...state.messages, msg]
      localStorage.setItem('messages', JSON.stringify(updated.slice(-200)))
      if (state.activeConversationId) {
        localStorage.setItem(`conversation_${state.activeConversationId}`, JSON.stringify(updated.slice(-200)))
      }
      return { ...state, messages: updated, streamingText: '' }
    }
    case 'ADD_USER_MESSAGE': {
      const msg: Message = { id: `user-${Date.now()}`, role: 'user', text: action.text, timestamp: Date.now() }
      const updated = [...state.messages, msg]
      localStorage.setItem('messages', JSON.stringify(updated.slice(-200)))
      if (state.activeConversationId) {
        localStorage.setItem(`conversation_${state.activeConversationId}`, JSON.stringify(updated.slice(-200)))
      }
      // Auto-title from first user message
      const isFirst = !state.messages.some(m => m.role === 'user')
      if (isFirst && state.activeConversationId) {
        const title = action.text.slice(0, 40) + (action.text.length > 40 ? '…' : '')
        const updatedConvos = state.conversations.map(c =>
          c.id === state.activeConversationId ? { ...c, title } : c
        )
        localStorage.setItem('conversation_index', JSON.stringify(updatedConvos))
        return { ...state, messages: updated, conversations: updatedConvos }
      }
      return { ...state, messages: updated }
    }
    case 'SET_MODE': return { ...state, currentMode: action.mode }
    case 'SET_MODES': return { ...state, modes: action.modes }
    case 'TOGGLE_THEME': {
      const next = !state.isDark
      localStorage.setItem('isDark', String(next))
      return { ...state, isDark: next }
    }
    case 'TOGGLE_AUTO_ROUTE': return { ...state, autoRoute: !state.autoRoute }
    case 'SET_ROUTE_TOAST': return { ...state, routeToast: action.value }
    case 'SET_CAL_DIGEST': return { ...state, calDigest: action.text }
    case 'SET_TAB': return { ...state, activeTab: action.tab }
    case 'CLEAR_HISTORY':
      localStorage.removeItem('messages')
      localStorage.removeItem('conversation_index')
      localStorage.removeItem('active_conversation_id')
      return { ...state, messages: [], streamingText: '', conversations: [], activeConversationId: null }
    case 'LOGOUT':
      localStorage.removeItem('serverUrl'); localStorage.removeItem('token')
      localStorage.removeItem('messages'); localStorage.removeItem('conversation_index')
      localStorage.removeItem('active_conversation_id')
      return { ...state, serverUrl: null, token: null, connected: false, messages: [], streamingText: '', conversations: [], activeConversationId: null }
    case 'SET_CONVERSATIONS':
      localStorage.setItem('conversation_index', JSON.stringify(action.conversations))
      if (action.activeId) localStorage.setItem('active_conversation_id', action.activeId)
      return { ...state, conversations: action.conversations, activeConversationId: action.activeId, messages: action.messages }
    case 'SET_ACTIVE_CONVERSATION':
      localStorage.setItem('active_conversation_id', action.id)
      return { ...state, activeConversationId: action.id, messages: action.messages }
    case 'NEW_CONVERSATION': {
      const updated = [action.meta, ...state.conversations].slice(0, 50)
      localStorage.setItem('conversation_index', JSON.stringify(updated))
      localStorage.setItem('active_conversation_id', action.meta.id)
      localStorage.removeItem('messages')
      return { ...state, conversations: updated, activeConversationId: action.meta.id, messages: [], streamingText: '' }
    }
    default: return state
  }
}

const StateCtx = createContext<AppState>(null!)
const DispatchCtx = createContext<React.Dispatch<AppAction>>(null!)

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, init)
  return (
    <StateCtx.Provider value={state}>
      <DispatchCtx.Provider value={dispatch}>{children}</DispatchCtx.Provider>
    </StateCtx.Provider>
  )
}

export const useAppState = () => useContext(StateCtx)
export const useAppDispatch = () => useContext(DispatchCtx)

// ── Async conversation helpers ──────────────────────────────────────────────

export async function loadConversations(
  dispatch: React.Dispatch<AppAction>,
  serverUrl: string,
  token: string
): Promise<void> {
  try {
    const res = await apiFetch(serverUrl, token, '/chats')
    if (res.ok) {
      const { conversations }: { conversations: ConversationMeta[] } = await res.json()
      const localActiveId = localStorage.getItem('active_conversation_id')
      let activeId = (localActiveId && conversations.find(c => c.id === localActiveId))
        ? localActiveId : conversations[0]?.id ?? null
      if (!activeId) {
        const id = `conv_${Date.now()}`
        const meta: ConversationMeta = { id, startedAt: Date.now(), title: 'New conversation' }
        apiFetch(serverUrl, token, `/chats/${id}`, { method: 'PUT', body: JSON.stringify({ messages: [], meta }) }).catch(() => {})
        localStorage.setItem('conversation_index', JSON.stringify([meta]))
        localStorage.setItem('active_conversation_id', id)
        dispatch({ type: 'SET_CONVERSATIONS', conversations: [meta], activeId: id, messages: [] })
        return
      }
      const msgsRes = await apiFetch(serverUrl, token, `/chats/${activeId}`)
      const { messages } = msgsRes.ok ? await msgsRes.json() : { messages: [] }
      localStorage.setItem('conversation_index', JSON.stringify(conversations))
      localStorage.setItem('active_conversation_id', activeId)
      dispatch({ type: 'SET_CONVERSATIONS', conversations, activeId, messages })
      return
    }
  } catch { /* fall through to localStorage */ }

  // Offline fallback
  const conversations: ConversationMeta[] = JSON.parse(localStorage.getItem('conversation_index') || '[]')
  const activeId = localStorage.getItem('active_conversation_id')
  if (activeId && conversations.find(c => c.id === activeId)) {
    const messages: Message[] = JSON.parse(localStorage.getItem(`conversation_${activeId}`) || '[]')
    dispatch({ type: 'SET_CONVERSATIONS', conversations, activeId, messages })
    return
  }
  const id = `conv_${Date.now()}`
  const meta: ConversationMeta = { id, startedAt: Date.now(), title: 'New conversation' }
  localStorage.setItem('conversation_index', JSON.stringify([meta]))
  localStorage.setItem('active_conversation_id', id)
  dispatch({ type: 'SET_CONVERSATIONS', conversations: [meta], activeId: id, messages: [] })
}

export async function newConversation(
  dispatch: React.Dispatch<AppAction>,
  serverUrl: string,
  token: string
): Promise<void> {
  const id = `conv_${Date.now()}`
  const meta: ConversationMeta = { id, startedAt: Date.now(), title: 'New conversation' }
  apiFetch(serverUrl, token, `/chats/${id}`, { method: 'PUT', body: JSON.stringify({ messages: [], meta }) }).catch(() => {})
  dispatch({ type: 'NEW_CONVERSATION', meta })
}

export async function loadConversation(
  dispatch: React.Dispatch<AppAction>,
  serverUrl: string,
  token: string,
  id: string
): Promise<void> {
  let messages: Message[] = []
  try {
    const res = await apiFetch(serverUrl, token, `/chats/${id}`)
    if (res.ok) {
      const data = await res.json()
      messages = data.messages ?? []
      localStorage.setItem(`conversation_${id}`, JSON.stringify(messages))
    }
  } catch {
    messages = JSON.parse(localStorage.getItem(`conversation_${id}`) || '[]')
  }
  dispatch({ type: 'SET_ACTIVE_CONVERSATION', id, messages })
}

export async function clearAllHistory(
  dispatch: React.Dispatch<AppAction>,
  serverUrl: string,
  token: string
): Promise<void> {
  apiFetch(serverUrl, token, '/chats', { method: 'DELETE' }).catch(() => {})
  dispatch({ type: 'CLEAR_HISTORY' })
}
