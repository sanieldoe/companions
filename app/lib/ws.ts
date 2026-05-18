import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState } from 'react-native';
import { useStore, flushSyncQueue } from './store';

type ServerEvent =
  | { type: 'hello'; mode: string; modes: Array<{ id: string; name: string; emoji: string; accent: string; mascot: string }>; hasReplay?: boolean }
  | { type: 'agent_start' }
  | { type: 'agent_thinking' }
  | { type: 'message_update'; text: string }
  | { type: 'agent_end'; persona?: string }
  | { type: 'mode_changed'; mode: string; auto?: boolean }
  | { type: 'cal_digest'; text: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'model_fallback'; message: string }
  | { type: 'canvas_update'; slug: string; canvas: unknown }
  | { type: 'calendar_result'; action: string; ok: boolean; eventId?: string; link?: string; error?: string };

type ClientMessage =
  | { type: 'message'; text: string; autoRoute?: boolean; project?: string; persona?: 'mentor' | 'shapeshifter'; conversationId?: string; fileName?: string; fileContent?: string; fileMime?: string }
  | { type: 'switch_mode'; mode: string }
  | { type: 'abort' };

type RawListener = (event: unknown) => void;

class WsService {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldConnect = false;
  private isConnecting = false;
  private rawListeners: Set<RawListener> = new Set();
  private pendingPersona: 'mentor' | 'shapeshifter' | null = null;
  private pendingConversationLoad = false;

  constructor() {
    // When the app returns to foreground, reconnect if the WS died while backgrounded.
    // On Android/iOS the JS thread is frozen in background so ws.onclose may not fire
    // until later — this ensures we reconnect immediately when the user returns.
    AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active' && this.shouldConnect) {
        this._checkAndReconnect();
      }
    });
  }

  private _checkAndReconnect(): void {
    if (this.isConnecting) return;
    if (!this.ws) {
      this._connect();
      return;
    }
    const rs = this.ws.readyState;
    if (rs === WebSocket.CLOSED || rs === WebSocket.CLOSING) {
      this._connect();
      return;
    }
    // If the WS thinks it's OPEN but JS was frozen, the underlying socket
    // is almost certainly dead (OS killed it during background). Force a
    // reconnect when an agent run is in flight so we don't sit on a zombie socket.
    const { agentState } = useStore.getState();
    if (rs === WebSocket.OPEN && (agentState === 'thinking' || agentState === 'talking')) {
      try { this.ws.close(); } catch {}
      this.ws = null;
      this._connect();
    }
  }

  addListener(fn: RawListener): void {
    this.rawListeners.add(fn);
  }

  removeListener(fn: RawListener): void {
    this.rawListeners.delete(fn);
  }

  connect() {
    this.shouldConnect = true;
    this._connect();
  }

  reconnect() {
    this._clearReconnect();
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    this.isConnecting = false;
    this._connect();
  }

  disconnect() {
    this.shouldConnect = false;
    this._clearReconnect();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    useStore.getState().setConnected(false);
  }

  send(msg: ClientMessage) {
    if (msg.type === 'message' && msg.persona) {
      this.pendingPersona = msg.persona;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private _connect() {
    if (this.isConnecting) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    const { serverUrl, token } = useStore.getState();
    if (!serverUrl || !token) return;

    this.isConnecting = true;
    const url = `${serverUrl}?token=${encodeURIComponent(token)}`;

    try {
      const ws = new WebSocket(url);
      this.ws = ws;

      ws.onopen = async () => {
        this.isConnecting = false;
        this._clearReconnect();
        const store = useStore.getState();
        store.setConnected(true);
        await flushSyncQueue();
        const persistedSlug = await AsyncStorage.getItem('current_project_slug').catch(() => null);
        if (persistedSlug) {
          useStore.getState().setCurrentProjectSlugOnly(persistedSlug);
        }
        // loadConversations is deferred to the hello handler so we know
        // whether a replay is in progress before loading stale history.
      };

      ws.onmessage = (event) => {
        try {
          const data: ServerEvent = JSON.parse(event.data as string);
          this._handleEvent(data);
          // Broadcast to raw listeners (for canvas_update etc.)
          for (const fn of this.rawListeners) {
            try { fn(data); } catch {}
          }
        } catch {
          // ignore parse errors
        }
      };

      ws.onclose = () => {
        this.isConnecting = false;
        // Preserve streamingText if a response is in flight — the server will replay
        // the full buffered response on reconnect (which begins with an injected
        // agent_start that clears streamingText cleanly). Wiping here causes the
        // visible bubble to vanish during the reconnect gap.
        const { agentState, disconnectedAt } = useStore.getState();
        const midStream = agentState === 'thinking' || agentState === 'talking';
        const now = disconnectedAt ?? Date.now();
        if (midStream) {
          useStore.setState({ connected: false, disconnectedAt: now });
        } else {
          useStore.setState({ connected: false, disconnectedAt: now, agentState: 'idle', streamingText: '' });
        }
        if (this.shouldConnect) {
          this._scheduleReconnect();
        }
      };

      ws.onerror = () => {
        this.isConnecting = false;
        // onclose will be called after onerror, handle reconnect there
      };
    } catch {
      this.isConnecting = false;
      if (this.shouldConnect) {
        this._scheduleReconnect();
      }
    }
  }

  private _handleEvent(event: ServerEvent) {
    const store = useStore.getState();
    switch (event.type) {
      case 'hello':
        store.setModes(event.modes);
        store.setMode(event.mode);
        store.setAgentState('idle');
        if (event.hasReplay) {
          // A replay stream is about to start — defer loading conversations until
          // agent_end so we don't overwrite messages while tokens are streaming.
          this.pendingConversationLoad = true;
        } else {
          this.pendingConversationLoad = false;
          store.loadConversations();
        }
        break;
      case 'agent_start':
        store.setAgentState('thinking');
        useStore.setState({ streamingText: '' });
        break;
      case 'agent_thinking':
        store.setAgentState('thinking');
        break;
      case 'message_update':
        store.setAgentState('talking');
        store.appendStreamingToken(event.text);
        break;
      case 'agent_end':
        store.commitStreamingMessage((event.persona as 'mentor' | 'shapeshifter') ?? this.pendingPersona ?? 'mentor');
        this.pendingPersona = null;
        store.setAgentState('idle');
        if (this.pendingConversationLoad) {
          this.pendingConversationLoad = false;
          store.loadConversations();
        }
        break;
      case 'mode_changed':
        store.setMode(event.mode);
        if (event.auto) {
          store.setRouteToast(`Routed to ${event.mode.charAt(0).toUpperCase() + event.mode.slice(1)}`);
          setTimeout(() => useStore.getState().setRouteToast(null), 2500);
        }
        break;
      case 'cal_digest':
        store.setCalDigest(event.text);
        break;
      case 'error': {
        const errMsg = event.message || 'Something went wrong';
        const prefix = store.streamingText.trim() ? '\n\n' : '';
        store.appendStreamingToken(`${prefix}⚠ ${errMsg}`);
        store.commitStreamingMessage(store.currentMode as 'mentor' | 'shapeshifter' | undefined);
        store.setAgentState('idle');
        break;
      }
      case 'model_fallback':
        store.setRouteToast(`⚠ ${event.message}`);
        setTimeout(() => useStore.getState().setRouteToast(null), 5000);
        break;
      case 'canvas_update':
        // Handled by raw listeners (e.g. ruse.tsx canvas viewer)
        break;
      case 'calendar_result':
        if (event.ok) store.bumpCalendarVersion();
        break;
    }
  }

  private _scheduleReconnect() {
    this._clearReconnect();
    // Short delay when foreground & mid-stream so we resume the replay quickly;
    // longer otherwise to avoid hammering the server.
    const { agentState } = useStore.getState();
    const midStream = agentState === 'thinking' || agentState === 'talking';
    const isActive = AppState.currentState === 'active';
    const delay = (midStream && isActive) ? 500 : (3000 + Math.random() * 2000);
    this.reconnectTimer = setTimeout(() => {
      if (this.shouldConnect) {
        this._connect();
      }
    }, delay);
  }

  private _clearReconnect() {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

export const wsService = new WsService();
