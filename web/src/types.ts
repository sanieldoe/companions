export type Tab = 'tracker' | 'mentor' | 'shapeshifter' | 'keeper'
export type AgentState = 'idle' | 'thinking' | 'talking'

export interface Message {
  id: string; role: 'user' | 'assistant'; text: string
  timestamp: number; persona?: 'mentor' | 'shapeshifter'
}

export interface ModeInfo { id: string; name: string; accent: string; mascot: string }

export interface ConversationMeta {
  id: string
  startedAt: number
  title: string
}

export interface AppState {
  serverUrl: string | null; token: string | null
  connected: boolean; agentState: AgentState
  messages: Message[]; streamingText: string
  currentMode: string; modes: ModeInfo[]
  isDark: boolean; autoRoute: boolean
  routeToast: string | null; calDigest: string | null
  activeTab: Tab
  activeConversationId: string | null
  conversations: ConversationMeta[]
}

export type AppAction =
  | { type: 'SET_CREDENTIALS'; serverUrl: string; token: string }
  | { type: 'SET_CONNECTED'; value: boolean }
  | { type: 'SET_AGENT_STATE'; value: AgentState }
  | { type: 'APPEND_TOKEN'; text: string }
  | { type: 'COMMIT_MESSAGE'; persona?: 'mentor' | 'shapeshifter' }
  | { type: 'ADD_USER_MESSAGE'; text: string }
  | { type: 'SET_MODE'; mode: string }
  | { type: 'SET_MODES'; modes: ModeInfo[] }
  | { type: 'TOGGLE_THEME' }
  | { type: 'TOGGLE_AUTO_ROUTE' }
  | { type: 'SET_ROUTE_TOAST'; value: string | null }
  | { type: 'SET_CAL_DIGEST'; text: string }
  | { type: 'SET_TAB'; tab: Tab }
  | { type: 'CLEAR_HISTORY' }
  | { type: 'LOGOUT' }
  | { type: 'SET_CONVERSATIONS'; conversations: ConversationMeta[]; activeId: string | null; messages: Message[] }
  | { type: 'SET_ACTIVE_CONVERSATION'; id: string; messages: Message[] }
  | { type: 'NEW_CONVERSATION'; meta: ConversationMeta }
