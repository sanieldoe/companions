import { create } from 'zustand';
import { setItem } from './storage';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { apiFetch } from './api';

export interface ModeInfo {
  id: string;
  name: string;
  emoji: string;
  accent: string;
  mascot: string;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  timestamp: number;
  persona?: 'mentor' | 'shapeshifter';  // which persona sent this (assistant only)
}

export interface ConversationMeta {
  id: string;
  startedAt: number;
  title: string;  // first user message truncated to 40 chars
  folder?: string;
  project?: string;
}

export type AgentState = 'idle' | 'thinking' | 'talking';

interface CompanionStore {
  // Connection
  serverUrl: string | null;
  token: string | null;
  connected: boolean;
  agentState: AgentState;

  // Conversation
  messages: Message[];
  streamingText: string;

  // Conversations
  activeConversationId: string | null;
  conversations: ConversationMeta[];

  // Mode
  currentMode: string;
  modes: ModeInfo[];

  // Theme
  isDark: boolean;

  // Project
  currentProjectSlug: string;

  // Persona handoff (Shapeshifter canvas → Mentor chat as Shapeshifter)
  requestedChatPersona: 'mentor' | 'shapeshifter' | null;
  setRequestedChatPersona(v: 'mentor' | 'shapeshifter' | null): void;

  // Global capture sheet
  captureSheetVisible: boolean;
  openCapture(): void;
  closeCapture(): void;

  // Auto-routing
  autoRoute: boolean;
  routeToast: string | null;
  calDigest: string | null;
  calendarVersion: number;
  bumpCalendarVersion(): void;

  // Actions
  setCredentials(serverUrl: string, token: string): void;
  setCurrentProject(slug: string): Promise<void>;
  setConnected(v: boolean): void;
  setAgentState(v: AgentState): void;
  appendStreamingToken(text: string): void;
  commitStreamingMessage(persona?: 'mentor' | 'shapeshifter'): void;
  addUserMessage(text: string): void;
  setMode(mode: string): void;
  setModes(modes: ModeInfo[]): void;
  toggleTheme(): void;
  setIsDark(v: boolean): void;
  toggleAutoRoute(): void;
  setRouteToast(v: string | null): void;
  setCalDigest(v: string | null): void;
  setCurrentProjectSlugOnly(slug: string): void;
  loadConversations(): Promise<void>;
  newConversation(folder?: string): Promise<void>;
  moveConversation(id: string, folder: string | undefined): Promise<void>;
  loadConversation(id: string): Promise<void>;
  renameConversation(id: string, title: string): Promise<void>;
  deleteConversation(id: string): Promise<void>;
  clearAllHistory(): Promise<void>;
}

interface SyncItem {
  id: string;
  messages: Message[];
  meta: ConversationMeta;
}
const _syncQueue: SyncItem[] = [];
let _isSyncing = false;

async function _syncToServer(id: string, messages: Message[], meta: ConversationMeta) {
  try {
    const project = meta.project ?? useStore.getState().currentProjectSlug;
    const res = await apiFetch(`/chats/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ messages, meta, project }),
    });
    if (res.ok) {
      const data = await res.json() as { ok: boolean; conversations?: ConversationMeta[] };
      if (data.conversations) {
        // Trust server's capped list as authoritative
        useStore.setState({ conversations: data.conversations });
        await AsyncStorage.setItem('conversation_index', JSON.stringify(data.conversations)).catch(() => {});
      }
    }
  } catch {
    // Replace existing queued item for same id, or push new
    const existing = _syncQueue.findIndex(q => q.id === id);
    if (existing >= 0) {
      _syncQueue[existing] = { id, messages, meta };
    } else {
      _syncQueue.push({ id, messages, meta });
    }
  }
}

export async function flushSyncQueue() {
  if (_isSyncing || _syncQueue.length === 0) return;
  _isSyncing = true;
  while (_syncQueue.length > 0) {
    const item = _syncQueue[0];
    try {
      const project = useStore.getState().currentProjectSlug;
      const res = await apiFetch(`/chats/${item.id}`, {
        method: 'PUT',
        body: JSON.stringify({ messages: item.messages, meta: item.meta, project }),
      });
      if (res.ok) {
        const data = await res.json() as { ok: boolean; conversations?: ConversationMeta[] };
        if (data.conversations) {
          useStore.setState({ conversations: data.conversations });
          await AsyncStorage.setItem('conversation_index', JSON.stringify(data.conversations)).catch(() => {});
        }
      }
      _syncQueue.shift();
    } catch {
      break; // stop on failure, try again on next flush
    }
  }
  _isSyncing = false;
}

export const useStore = create<CompanionStore>((set, get) => ({
  serverUrl: null,
  token: null,
  connected: false,
  agentState: 'idle',

  messages: [],
  streamingText: '',

  activeConversationId: null,
  conversations: [],

  currentMode: 'mentor',
  modes: [],

  isDark: true,

  currentProjectSlug: 'general',

  requestedChatPersona: null,
  setRequestedChatPersona(v) { set({ requestedChatPersona: v }); },

  captureSheetVisible: false,
  openCapture() { set({ captureSheetVisible: true }); },
  closeCapture() { set({ captureSheetVisible: false }); },

  autoRoute: true,
  routeToast: null,
  calDigest: null,
  calendarVersion: 0,
  bumpCalendarVersion() { set((s) => ({ calendarVersion: s.calendarVersion + 1 })); },

  setCredentials(serverUrl, token) {
    set({ serverUrl, token });
  },

  setConnected(v) {
    set({ connected: v });
  },

  setAgentState(v) {
    set({ agentState: v });
  },

  appendStreamingToken(text) {
    set((state) => ({ streamingText: state.streamingText + text }));
  },

  commitStreamingMessage(persona) {
    const { streamingText, messages, activeConversationId } = get();
    if (!streamingText.trim()) {
      set({ streamingText: '', agentState: 'idle' });
      return;
    }
    const msg: Message = {
      id: `assistant-${Date.now()}`,
      role: 'assistant',
      text: streamingText.trim(),
      timestamp: Date.now(),
      persona,
    };
    const updated = [...messages, msg];
    set({ messages: updated, streamingText: '', agentState: 'idle' });
    if (activeConversationId) {
      AsyncStorage.setItem(`conversation_${activeConversationId}`, JSON.stringify(updated)).catch(() => {});
      const { conversations } = get();
      const activeMeta = conversations.find(c => c.id === activeConversationId);
      if (activeMeta) _syncToServer(activeConversationId, updated, activeMeta);
    }
  },

  addUserMessage(text) {
    const msg: Message = {
      id: `user-${Date.now()}`,
      role: 'user',
      text,
      timestamp: Date.now(),
    };
    const { messages, activeConversationId, conversations } = get();
    const updated = [...messages, msg];
    set({ messages: updated });

    if (!activeConversationId) return;

    // Set title from first user message
    const isFirstUserMsg = !messages.some(m => m.role === 'user');
    if (isFirstUserMsg) {
      const title = text.slice(0, 40) + (text.length > 40 ? '…' : '');
      const updatedConvos = conversations.map(c =>
        c.id === activeConversationId ? { ...c, title } : c
      );
      set({ conversations: updatedConvos });
      AsyncStorage.setItem('conversation_index', JSON.stringify(updatedConvos)).catch(() => {});
      // Meta changed — sync with updated title
      const updatedMeta = updatedConvos.find(c => c.id === activeConversationId);
      if (updatedMeta) _syncToServer(activeConversationId, updated, updatedMeta);
    }
    // Persist messages
    AsyncStorage.setItem(`conversation_${activeConversationId}`, JSON.stringify(updated)).catch(() => {});
    if (!isFirstUserMsg) {
      const currentConvos = get().conversations;
      const activeMeta = currentConvos.find(c => c.id === activeConversationId);
      if (activeMeta) _syncToServer(activeConversationId, updated, activeMeta);
    }
  },

  setMode(mode) {
    set({ currentMode: mode });
  },

  setModes(modes) {
    set({ modes });
    AsyncStorage.setItem('cachedModes', JSON.stringify(modes)).catch(() => {});
  },

  toggleTheme() {
    const next = !get().isDark;
    set({ isDark: next });
    setItem('isDark', String(next)).catch(() => {});
  },

  setIsDark(v) {
    set({ isDark: v });
  },

  toggleAutoRoute() {
    set((state) => ({ autoRoute: !state.autoRoute }));
  },

  setRouteToast(v) {
    set({ routeToast: v });
  },

  setCalDigest(v) {
    set({ calDigest: v });
  },

  async setCurrentProject(slug) {
    set({ currentProjectSlug: slug, activeConversationId: null, messages: [], conversations: [] });
    await AsyncStorage.setItem('current_project_slug', slug).catch(() => {});
    await AsyncStorage.removeItem('active_conversation_id').catch(() => {});
    await get().loadConversations();
  },

  setCurrentProjectSlugOnly(slug) {
    set({ currentProjectSlug: slug });
  },

  async loadConversations() {
    // Try server first
    try {
      const projectSlug = get().currentProjectSlug;

      const idxRes = await apiFetch(`/chats?project=${encodeURIComponent(projectSlug)}`);
      if (idxRes.ok) {
        const { conversations }: { conversations: ConversationMeta[] } = await idxRes.json();

        // Read local active conversation ID and its messages from AsyncStorage.
        // AsyncStorage is written on every send/receive so it's always at least
        // as fresh as the server — sometimes ahead if a sync hadn't finished.
        const localActiveId = await AsyncStorage.getItem('active_conversation_id');
        const localMsgsRaw = localActiveId
          ? await AsyncStorage.getItem(`conversation_${localActiveId}`)
          : null;
        const localMessages: Message[] = localMsgsRaw ? JSON.parse(localMsgsRaw) : [];

        // Build the working conversation list, recovering any local-only conversation
        // that the server doesn't know about yet (e.g. sync hadn't completed before reload).
        let workingConvos = [...conversations];
        if (localActiveId && localMessages.length > 0 && !workingConvos.find(c => c.id === localActiveId)) {
          const localIndexRaw = await AsyncStorage.getItem('conversation_index');
          const localIndex: ConversationMeta[] = localIndexRaw ? JSON.parse(localIndexRaw) : [];
          const localMeta = localIndex.find(c => c.id === localActiveId);
          if (localMeta) {
            // Prepend to list and push to server
            workingConvos = [localMeta, ...workingConvos];
            _syncToServer(localActiveId, localMessages, localMeta);
          }
        }

        // Prefer the locally active conversation; fall back to server's first.
        let activeId = (localActiveId && workingConvos.find(c => c.id === localActiveId))
          ? localActiveId
          : workingConvos[0]?.id ?? null;

        if (!activeId) {
          // Nothing anywhere — start fresh
          const id = `conv_${Date.now()}`;
          const meta: ConversationMeta = { id, startedAt: Date.now(), title: 'New conversation', project: projectSlug };
          const updated = [meta];
          await AsyncStorage.setItem('conversation_index', JSON.stringify(updated));
          await AsyncStorage.setItem('active_conversation_id', id);
          set({ conversations: updated, activeConversationId: id, messages: [] });
          return;
        }

        // Load messages: if local AsyncStorage has messages for the active conversation,
        // compare with server and use whichever is longer.
        let messages: Message[] = localMessages;
        if (activeId !== localActiveId || localMessages.length === 0) {
          // Active conversation changed (fallback case) — read its local cache
          const altRaw = await AsyncStorage.getItem(`conversation_${activeId}`);
          messages = altRaw ? JSON.parse(altRaw) : [];
        }

        // Also check server — use it only if it's longer than local
        try {
          const msgsRes = await apiFetch(`/chats/${activeId}?project=${encodeURIComponent(projectSlug)}`);
          const serverMessages: Message[] = msgsRes.ok
            ? ((await msgsRes.json()).messages ?? [])
            : [];
          if (serverMessages.length > messages.length) {
            messages = serverMessages;
          }
        } catch { /* keep local */ }

        // Sync local back to server if it was ahead
        if (localMessages.length > 0 && activeId === localActiveId) {
          const activeMeta = workingConvos.find(c => c.id === activeId);
          if (activeMeta) _syncToServer(activeId, messages, activeMeta);
        }

        // Update local cache
        await AsyncStorage.setItem('conversation_index', JSON.stringify(workingConvos));
        await AsyncStorage.setItem(`conversation_${activeId}`, JSON.stringify(messages));
        await AsyncStorage.setItem('active_conversation_id', activeId);

        set({ conversations: workingConvos, activeConversationId: activeId, messages });
        return;
      }
    } catch { /* fall through to AsyncStorage */ }

    // Fallback: AsyncStorage cache (offline)
    try {
      const indexRaw = await AsyncStorage.getItem('conversation_index');
      const conversations: ConversationMeta[] = indexRaw ? JSON.parse(indexRaw) : [];
      const activeId = await AsyncStorage.getItem('active_conversation_id');

      if (activeId && conversations.find(c => c.id === activeId)) {
        const msgsRaw = await AsyncStorage.getItem(`conversation_${activeId}`);
        const messages: Message[] = msgsRaw ? JSON.parse(msgsRaw) : [];
        set({ conversations, activeConversationId: activeId, messages });
        return;
      }
    } catch {}

    // Nothing anywhere — create fresh (offline)
    const id = `conv_${Date.now()}`;
    const meta: ConversationMeta = { id, startedAt: Date.now(), title: 'New conversation' };
    await AsyncStorage.setItem('conversation_index', JSON.stringify([meta]));
    await AsyncStorage.setItem('active_conversation_id', id);
    set({ conversations: [meta], activeConversationId: id, messages: [] });
  },

  async newConversation(folder?: string) {
    const { conversations, activeConversationId, messages } = get();
    // Save current conversation if it has messages
    if (activeConversationId && messages.length > 0) {
      await AsyncStorage.setItem(`conversation_${activeConversationId}`, JSON.stringify(messages)).catch(() => {});
    }
    const id = `conv_${Date.now()}`;
    const meta: ConversationMeta = { id, startedAt: Date.now(), title: 'New conversation', ...(folder ? { folder } : {}) };
    const updated = [meta, ...conversations].slice(0, 50); // cap at 50
    await AsyncStorage.setItem('conversation_index', JSON.stringify(updated)).catch(() => {});
    await AsyncStorage.setItem('active_conversation_id', id).catch(() => {});
    set({ conversations: updated, activeConversationId: id, messages: [] });
    // New empty conversation — push to server so index is updated
    _syncToServer(id, [], meta);
  },

  async moveConversation(id: string, folder: string | undefined) {
    const { conversations, activeConversationId, messages } = get();
    const updated = conversations.map(c => c.id === id ? { ...c, folder } : c);
    set({ conversations: updated });
    await AsyncStorage.setItem('conversation_index', JSON.stringify(updated)).catch(() => {});
    const meta = updated.find(c => c.id === id);
    if (meta) {
      const msgs = id === activeConversationId ? messages : [];
      _syncToServer(id, msgs, meta);
    }
  },

  async loadConversation(id: string) {
    const { conversations, activeConversationId, messages } = get();
    // Save current
    if (activeConversationId && messages.length > 0) {
      await AsyncStorage.setItem(`conversation_${activeConversationId}`, JSON.stringify(messages)).catch(() => {});
    }

    await AsyncStorage.setItem('active_conversation_id', id).catch(() => {});

    // Try server
    let loaded: Message[] = [];
    try {
      const res = await apiFetch(`/chats/${id}`);
      if (res.ok) {
        const data = await res.json();
        loaded = data.messages ?? [];
        await AsyncStorage.setItem(`conversation_${id}`, JSON.stringify(loaded)).catch(() => {});
      }
    } catch {
      // Fall back to local cache
      const msgsRaw = await AsyncStorage.getItem(`conversation_${id}`);
      loaded = msgsRaw ? JSON.parse(msgsRaw) : [];
    }

    set({ activeConversationId: id, messages: loaded });
  },

  async renameConversation(id: string, title: string) {
    const { conversations, activeConversationId, messages } = get();
    const updated = conversations.map((c) => (c.id === id ? { ...c, title } : c));
    set({ conversations: updated });
    await AsyncStorage.setItem('conversation_index', JSON.stringify(updated)).catch(() => {});
    const meta = updated.find((c) => c.id === id);
    if (meta) {
      const msgs = id === activeConversationId ? messages : [];
      _syncToServer(id, msgs, meta);
    }
  },

  async deleteConversation(id: string) {
    const { conversations, activeConversationId, currentProjectSlug } = get();
    const updated = conversations.filter((c) => c.id !== id);
    try { await apiFetch(`/chats/${id}?project=${encodeURIComponent(currentProjectSlug)}`, { method: 'DELETE' }); } catch {}
    await AsyncStorage.removeItem(`conversation_${id}`).catch(() => {});
    await AsyncStorage.setItem('conversation_index', JSON.stringify(updated)).catch(() => {});

    if (updated.length === 0) {
      const newId = `conv_${Date.now()}`;
      const meta: ConversationMeta = { id: newId, startedAt: Date.now(), title: 'New conversation' };
      const fresh = [meta];
      await AsyncStorage.setItem('conversation_index', JSON.stringify(fresh)).catch(() => {});
      await AsyncStorage.setItem('active_conversation_id', newId).catch(() => {});
      _syncToServer(newId, [], meta);
      set({ conversations: fresh, activeConversationId: newId, messages: [] });
    } else if (id === activeConversationId) {
      const next = updated[0];
      await AsyncStorage.setItem('active_conversation_id', next.id).catch(() => {});
      const msgsRaw = await AsyncStorage.getItem(`conversation_${next.id}`);
      const msgs: Message[] = msgsRaw ? JSON.parse(msgsRaw) : [];
      set({ conversations: updated, activeConversationId: next.id, messages: msgs });
    } else {
      set({ conversations: updated });
    }
  },

  async clearAllHistory() {
    const { conversations, currentProjectSlug } = get();
    // Remove all conversation message keys
    await Promise.all(
      conversations.map(c => AsyncStorage.removeItem(`conversation_${c.id}`))
    ).catch(() => {});
    await AsyncStorage.removeItem('conversation_index').catch(() => {});
    await AsyncStorage.removeItem('active_conversation_id').catch(() => {});
    try { await apiFetch(`/chats?project=${encodeURIComponent(currentProjectSlug)}`, { method: 'DELETE' }); } catch {}
    // Start fresh
    const id = `conv_${Date.now()}`;
    const meta: ConversationMeta = { id, startedAt: Date.now(), title: 'New conversation' };
    await AsyncStorage.setItem('conversation_index', JSON.stringify([meta])).catch(() => {});
    await AsyncStorage.setItem('active_conversation_id', id).catch(() => {});
    set({ conversations: [meta], activeConversationId: id, messages: [] });
  },
}));

// Accent colour helpers
export const MODE_ACCENTS: Record<string, string> = {
  mentor: '#4CAF50',
  shapeshifter: '#FF6135',
  keeper: '#FFD54F',
  tracker: '#42A5F5',
};

export const MODE_EMOJIS: Record<string, string> = {
  mentor: '🐢',
  shapeshifter: '🦞',
  keeper: '🐝',
  tracker: '🐙',
};

export const MODE_NAMES: Record<string, string> = {
  mentor: 'Sage',
  shapeshifter: 'Creato',
  keeper: 'Loom',
  tracker: 'Tick',
};

export function getModeName(mode: string, modes: ModeInfo[]): string {
  return modes.find(m => m.id === mode)?.name ?? MODE_NAMES[mode] ?? mode;
}

export function getModeEmoji(mode: string, modes: ModeInfo[]): string {
  return modes.find(m => m.id === mode)?.emoji ?? MODE_EMOJIS[mode] ?? '';
}

export function getAccent(mode: string, modes: ModeInfo[]): string {
  const found = modes.find((m) => m.id === mode);
  if (found) return found.accent;
  return MODE_ACCENTS[mode] ?? '#4CAF50';
}
