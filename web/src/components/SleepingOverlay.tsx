import { useAppState } from '../store'
import { dark, light } from '../theme'

const STARS = [
  { top: '8%', left: '12%', size: 2 }, { top: '15%', left: '72%', size: 1.5 },
  { top: '22%', left: '40%', size: 1 }, { top: '30%', left: '88%', size: 2 },
  { top: '10%', left: '55%', size: 1 }, { top: '40%', left: '20%', size: 1.5 },
  { top: '5%', left: '33%', size: 1 }, { top: '18%', left: '92%', size: 1.5 },
  { top: '35%', left: '60%', size: 1 }, { top: '28%', left: '5%', size: 2 },
]

export default function SleepingOverlay({ visible }: { visible: boolean }) {
  const state = useAppState()
  const theme = state.isDark ? dark : light

  return (
    <div style={{
      position: 'absolute', inset: 0, background: theme.bg,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      opacity: visible ? 1 : 0, pointerEvents: visible ? 'auto' : 'none',
      transition: 'opacity 300ms', zIndex: 100,
    }}>
      {STARS.map((s, i) => (
        <div key={i} style={{ position: 'absolute', top: s.top, left: s.left, width: s.size, height: s.size, borderRadius: '50%', background: '#fff', opacity: 0.5 }} />
      ))}
      <div style={{ textAlign: 'center' }}>
        <div style={{ color: theme.textDim, fontSize: 18, marginBottom: 8 }}>Resting...</div>
        <div style={{ color: theme.textFaint, fontSize: 13 }}>I'll be here when you're back.</div>
      </div>
    </div>
  )
}
