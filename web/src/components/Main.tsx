import { useEffect, useRef, useState } from 'react'
import { useAppState, useAppDispatch, EMOJIS } from '../store'
import { wsService } from '../ws'
import { dark, light } from '../theme'
import { Tab } from '../types'
import ChatTab from './ChatTab'
import TrackerTab from './TrackerTab'
import KeeperTab from './KeeperTab'
import SleepingOverlay from './SleepingOverlay'
import SettingsModal from './SettingsModal'

const TABS: Tab[] = ['tracker', 'mentor', 'shapeshifter', 'keeper']

export default function Main() {
  const state = useAppState()
  const dispatch = useAppDispatch()
  const theme = state.isDark ? dark : light
  const [settingsOpen, setSettingsOpen] = useState(false)
  const prevMode = useRef(state.currentMode)

  useEffect(() => {
    if (prevMode.current === state.currentMode) return
    prevMode.current = state.currentMode
    if (state.currentMode === 'mentor' || state.currentMode === 'shapeshifter') {
      dispatch({ type: 'SET_TAB', tab: state.currentMode })
    }
  }, [state.currentMode])

  function switchTab(tab: Tab) {
    dispatch({ type: 'SET_TAB', tab })
    if (tab === 'mentor' || tab === 'shapeshifter') wsService.send({ type: 'switch_mode', mode: tab })
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: theme.bg, position: 'relative' }}>
      <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
        {state.activeTab === 'tracker' && <TrackerTab />}
        {state.activeTab === 'mentor' && <ChatTab persona="mentor" onSettings={() => setSettingsOpen(true)} />}
        {state.activeTab === 'shapeshifter' && <ChatTab persona="shapeshifter" onSettings={() => setSettingsOpen(true)} />}
        {state.activeTab === 'keeper' && <KeeperTab />}
        <SleepingOverlay visible={!state.connected} />
      </div>

      {state.routeToast && (
        <div style={{
          position: 'absolute', bottom: 80, left: '50%', transform: 'translateX(-50%)',
          background: '#333', color: '#fff', padding: '8px 16px', borderRadius: 20,
          fontSize: 13, zIndex: 200, pointerEvents: 'none', whiteSpace: 'nowrap',
        }}>
          {state.routeToast}
        </div>
      )}

      <div style={{
        display: 'flex', borderTop: `1px solid ${theme.border}`,
        background: theme.bg, flexShrink: 0,
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}>
        {TABS.map(tab => (
          <button key={tab} onClick={() => switchTab(tab)} style={{
            flex: 1, padding: '12px 0 8px', background: 'none', border: 'none', cursor: 'pointer',
          }}>
            <span style={{ fontSize: 24, opacity: state.activeTab === tab ? 1 : 0.4 }}>
              {EMOJIS[tab]}
            </span>
          </button>
        ))}
      </div>

      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  )
}
