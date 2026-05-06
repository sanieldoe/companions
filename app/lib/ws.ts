import { useStore, flushSyncQueue } from './store';

type ServerEvent =
  | { type: 'hello'; mode: string; modes: Array<{ id: string; name: string; accent: string; mascot: string }> }
  | { type: 'agent_start' }
  | { type: 'agent_thinking' }
  | { type: 'message_update'; text: string }
  | { type: 'agent_end' }
  | { type: 'mode_changed'; mode: string; auto?: boolean }
  | { type: 'cal_digest'; text: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'model_fallback'; message: string }
  | { type: 'canvas_update'; slug: string; canvas: unknown }
  | { type: 'calendar_result'; action: string; ok: boolean; eventId?: string; link?: string; error?: string };

type ClientMessage =
  | { type: 'message'; text: string; autoRoute?: boolean; project?: string; persona?: 'mentor' | 'shapeshifter' }
  | { type: 'switch_mode'; mode: string }
  | { type: 'abort' };

type RawListener = (event: unknown) => void;

class WsService {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldConnect = false;
  private isConnecting = false;
  private rawListeners: Set<RawListener> = new Set();
  private lastSentPersona: 'mentor' | 'shapeshifter' = 'mentor';

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
      this.lastSentPersona = msg.persona;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private _connect() {
    if (this.isConnecting) return;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    const { serverUrl, token } = useStore.getState();
    if (!serverUrl || !token) return;

    this.isConnecting = true;
    const url = `${serverUrl}?token=${encodeURIComponent(token)}`;

    try {
      const ws = new WebSocket(url);
      this.ws = ws;

      ws.onopen = () => {
        this.isConnecting = false;
        this._clearReconnect();
        const store = useStore.getState();
        store.setConnected(true);
        flushSyncQueue();
        // Always reload conversation history on every new connection so that
        // post-server-change reconnects pick up fresh history from the active server.
        store.loadConversations();
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
        useStore.getState().setConnected(false);
        useStore.getState().setAgentState('idle');
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
        break;
      case 'agent_start':
        store.setAgentState('thinking');
        break;
      case 'agent_thinking':
        store.setAgentState('thinking');
        break;
      case 'message_update':
        store.setAgentState('talking');
        store.appendStreamingToken(event.text);
        break;
      case 'agent_end':
        store.commitStreamingMessage(this.lastSentPersona);
        store.setAgentState('idle');
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
        if (!store.streamingText.trim()) {
          store.appendStreamingToken(`⚠ ${errMsg}`);
        }
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
    this.reconnectTimer = setTimeout(() => {
      if (this.shouldConnect) {
        this._connect();
      }
    }, 4000);
  }

  private _clearReconnect() {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

export const wsService = new WsService();
