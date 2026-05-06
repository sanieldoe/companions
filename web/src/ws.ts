import { AppAction, ModeInfo } from './types'

type Dispatch = (a: AppAction) => void
type GetState = () => { serverUrl: string | null; token: string | null; currentMode: string }

class WsService {
  private ws: WebSocket | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private should = false; private connecting = false
  private dispatch: Dispatch | null = null
  private getState: GetState | null = null

  init(d: Dispatch, g: GetState) { this.dispatch = d; this.getState = g }

  connect() { this.should = true; this._conn() }

  disconnect() {
    this.should = false; this._clear(); this.ws?.close(); this.ws = null
    this.dispatch?.({ type: 'SET_CONNECTED', value: false })
  }

  send(msg: object) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
  }

  private _conn() {
    if (this.connecting || !this.dispatch || !this.getState) return
    if (this.ws?.readyState === WebSocket.OPEN) return
    const { serverUrl, token } = this.getState()
    if (!serverUrl || !token) return
    this.connecting = true
    try {
      const ws = new WebSocket(`${serverUrl}?token=${encodeURIComponent(token)}`)
      this.ws = ws
      ws.onopen = () => {
        this.connecting = false; this._clear()
        this.dispatch!({ type: 'SET_CONNECTED', value: true })
      }
      ws.onmessage = e => { try { this._handle(JSON.parse(e.data)) } catch {} }
      ws.onclose = () => {
        this.connecting = false
        this.dispatch!({ type: 'SET_CONNECTED', value: false })
        this.dispatch!({ type: 'SET_AGENT_STATE', value: 'idle' })
        if (this.should) this._sched()
      }
      ws.onerror = () => { this.connecting = false }
    } catch { this.connecting = false; if (this.should) this._sched() }
  }

  private _handle(e: { type: string;[k: string]: unknown }) {
    const d = this.dispatch!; const g = this.getState!
    switch (e.type) {
      case 'hello':
        d({ type: 'SET_MODES', modes: e.modes as ModeInfo[] })
        d({ type: 'SET_MODE', mode: e.mode as string })
        d({ type: 'SET_AGENT_STATE', value: 'idle' })
        break
      case 'agent_start': case 'agent_thinking':
        d({ type: 'SET_AGENT_STATE', value: 'thinking' }); break
      case 'message_update':
        d({ type: 'SET_AGENT_STATE', value: 'talking' })
        d({ type: 'APPEND_TOKEN', text: e.text as string })
        break
      case 'agent_end': {
        const m = g().currentMode
        d({ type: 'COMMIT_MESSAGE', persona: m === 'mentor' || m === 'shapeshifter' ? m : undefined })
        d({ type: 'SET_AGENT_STATE', value: 'idle' })
        break
      }
      case 'mode_changed':
        d({ type: 'SET_MODE', mode: e.mode as string })
        if (e.auto) {
          const n = e.mode as string
          d({ type: 'SET_ROUTE_TOAST', value: `Routed to ${n.charAt(0).toUpperCase() + n.slice(1)}` })
          setTimeout(() => d({ type: 'SET_ROUTE_TOAST', value: null }), 2500)
        }
        break
      case 'cal_digest': d({ type: 'SET_CAL_DIGEST', text: e.text as string }); break
      case 'error':
        d({ type: 'COMMIT_MESSAGE' })
        d({ type: 'SET_AGENT_STATE', value: 'idle' })
        break
    }
  }

  private _sched() { this._clear(); this.timer = setTimeout(() => { if (this.should) this._conn() }, 4000) }
  private _clear() { if (this.timer) { clearTimeout(this.timer); this.timer = null } }
}

export const wsService = new WsService()
