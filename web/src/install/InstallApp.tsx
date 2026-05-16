import React, { useState, useEffect, useRef } from 'react';
import QRCodeImg from '../QRCodeImg';

const BG = '#0D0B08';
const SURFACE = '#1A1714';
const BORDER = '#2A2520';
const TEXT = '#F0EDE8';
const TEXT_DIM = '#8A8480';
const ACCENT = '#4CAF50';
const ERROR = '#FF6135';

interface Persona {
  mode: string;
  name: string;
  emoji: string;
}

interface ModelState {
  category: 'local' | 'cloud';
  provider: string;
  modelId: string;
  apiKey: string;
  baseUrl: string;
}

interface WizardState {
  vault: { path: string; validated: boolean; exists: boolean; missingFolders: string[] };
  userName: string;
  authSecret: string;
  model: ModelState;
  personas: Persona[];
  calendar: { clientId: string; clientSecret: string; skip: boolean };
}

interface TailscaleStatus {
  connected: boolean;
  ip: string | null;
  port: number;
}

function generateSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

// --- Spinner ---
function Spinner() {
  return (
    <div style={{
      width: '40px',
      height: '40px',
      borderRadius: '50%',
      border: `3px solid ${BORDER}`,
      borderTopColor: ACCENT,
      animation: 'spin 0.8s linear infinite',
      margin: '0 auto',
    }} />
  );
}

// --- Input ---
function Input({
  value, onChange, placeholder, type = 'text', readOnly = false, mono = false,
  style: extraStyle,
}: {
  value: string;
  onChange?: (v: string) => void;
  placeholder?: string;
  type?: string;
  readOnly?: boolean;
  mono?: boolean;
  style?: React.CSSProperties;
}) {
  return (
    <input
      type={type}
      value={value}
      readOnly={readOnly}
      onChange={e => onChange?.(e.target.value)}
      placeholder={placeholder}
      style={{
        width: '100%',
        background: BG,
        border: `1px solid ${BORDER}`,
        borderRadius: '6px',
        color: TEXT,
        fontSize: '0.95rem',
        padding: '10px 12px',
        outline: 'none',
        fontFamily: mono ? 'monospace' : 'inherit',
        boxSizing: 'border-box',
        ...extraStyle,
      }}
    />
  );
}

// --- Button ---
function Btn({
  onClick, disabled = false, children, variant = 'primary', style: extraStyle,
}: {
  onClick?: () => void;
  disabled?: boolean;
  children: React.ReactNode;
  variant?: 'primary' | 'secondary';
  style?: React.CSSProperties;
}) {
  const isPrimary = variant === 'primary';
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        background: isPrimary ? ACCENT : 'transparent',
        border: isPrimary ? 'none' : `1px solid ${BORDER}`,
        color: isPrimary ? '#000' : TEXT_DIM,
        borderRadius: '6px',
        padding: '10px 20px',
        fontSize: '0.95rem',
        fontWeight: isPrimary ? 700 : 400,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        transition: 'opacity 0.15s',
        fontFamily: 'inherit',
        ...extraStyle,
      }}
    >
      {children}
    </button>
  );
}

// --- Label ---
function Label({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      color: TEXT_DIM,
      fontSize: '0.78rem',
      textTransform: 'uppercase',
      letterSpacing: '0.07em',
      marginBottom: '0.4rem',
    }}>
      {children}
    </div>
  );
}

// ---- Step 0: Welcome ----
function StepWelcome({ onNext }: { onNext: () => void }) {
  const steps = ['Tailscale', 'Vault', 'Your Name', 'Secret', 'Model / Subscription', 'Personas', 'Calendar'];
  return (
    <div style={{ textAlign: 'center' }}>
      <h1 style={{ color: TEXT, fontSize: '2rem', fontWeight: 700, marginBottom: '0.75rem' }}>
        Companion Setup
      </h1>
      <p style={{ color: TEXT_DIM, fontSize: '1rem', marginBottom: '2.5rem', lineHeight: 1.6 }}>
        Let's get your personal AI assistant running in a few steps.
      </p>
      <div style={{ marginBottom: '2.5rem' }}>
        {steps.map((s, i) => (
          <div key={i} style={{
            color: TEXT_DIM,
            fontSize: '0.9rem',
            padding: '0.4rem 0',
            borderBottom: i < steps.length - 1 ? `1px solid ${BORDER}` : 'none',
          }}>
            {s}
          </div>
        ))}
      </div>
      <Btn onClick={onNext}>Get Started →</Btn>
    </div>
  );
}

// ---- Step 1: Tailscale ----
function StepTailscale({ onNext }: { onNext: () => void }) {
  const [status, setStatus] = useState<TailscaleStatus | null>(null);
  const [loading, setLoading] = useState(true);

  async function check() {
    setLoading(true);
    try {
      const r = await fetch('/install/tailscale-status');
      const d = await r.json() as TailscaleStatus;
      setStatus(d);
    } catch {
      setStatus({ connected: false, ip: null, port: 3000 });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { check(); }, []);

  return (
    <div>
      <h2 style={{ color: TEXT, fontSize: '1.4rem', fontWeight: 700, marginBottom: '0.5rem' }}>Tailscale</h2>
      <p style={{ color: TEXT_DIM, fontSize: '0.9rem', marginBottom: '1.5rem', lineHeight: 1.6 }}>
        Tailscale creates a private network so your phone can reach this server securely from anywhere.
      </p>

      {loading ? (
        <div style={{ padding: '1.5rem 0' }}>
          <Spinner />
        </div>
      ) : status?.connected ? (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          color: ACCENT,
          fontSize: '0.95rem',
          marginBottom: '1rem',
        }}>
          <span>✓</span>
          <span>Connected — {status.ip}</span>
        </div>
      ) : (
        <div style={{ marginBottom: '1rem' }}>
          <p style={{ color: TEXT_DIM, fontSize: '0.9rem', marginBottom: '0.75rem' }}>
            Not detected
          </p>
          <div style={{ color: TEXT_DIM, fontSize: '0.9rem', lineHeight: 1.7, marginBottom: '0.75rem' }}>
            <div>1. Install Tailscale on this Mac</div>
            <div>2. Sign in and connect</div>
            <div>3. Install Tailscale on your phone</div>
          </div>
          <p style={{ color: TEXT_DIM, fontSize: '0.85rem' }}>tailscale.com</p>
        </div>
      )}

      {!loading && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '1.5rem' }}>
          <Btn onClick={check} variant="secondary">Re-check</Btn>
          <Btn onClick={onNext}>Continue →</Btn>
        </div>
      )}
    </div>
  );
}

// ---- Step 2: Vault ----
function StepVault({
  vault, onChange, onNext,
}: {
  vault: WizardState['vault'];
  onChange: (v: WizardState['vault']) => void;
  onNext: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function validate() {
    if (!vault.path.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const r = await fetch('/install/validate-vault', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: vault.path.trim() }),
      });
      const d = await r.json() as { exists: boolean; missingFolders?: string[]; error?: string };
      if (!r.ok) throw new Error(d.error ?? 'Validation failed');
      onChange({ ...vault, validated: true, exists: d.exists, missingFolders: d.missingFolders ?? [] });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Validation failed');
      onChange({ ...vault, validated: false });
    } finally {
      setLoading(false);
    }
  }

  function statusMsg() {
    if (!vault.validated) return null;
    if (!vault.exists) return 'New vault will be created here.';
    if (vault.missingFolders.length === 0) return 'Vault found. All folders present.';
    return `Vault found. Missing folders will be created: ${vault.missingFolders.join(', ')}`;
  }

  const msg = statusMsg();

  return (
    <div>
      <h2 style={{ color: TEXT, fontSize: '1.4rem', fontWeight: 700, marginBottom: '0.5rem' }}>Vault Folder</h2>
      <p style={{ color: TEXT_DIM, fontSize: '0.9rem', marginBottom: '1.5rem', lineHeight: 1.6 }}>
        This is where Companion stores your notes, journal, and projects.
      </p>
      <Label>Path</Label>
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem' }}>
        <Input
          value={vault.path}
          onChange={v => onChange({ ...vault, path: v, validated: false })}
          placeholder="/Users/you/companion-vault"
          style={{ flex: 1 }}
        />
        <Btn onClick={validate} disabled={loading || !vault.path.trim()}>
          {loading ? '…' : 'Validate'}
        </Btn>
      </div>
      {msg && <p style={{ color: ACCENT, fontSize: '0.875rem', marginBottom: '0.75rem' }}>{msg}</p>}
      {error && <p style={{ color: ERROR, fontSize: '0.875rem', marginBottom: '0.75rem' }}>{error}</p>}
      <div style={{ marginTop: '1.5rem', textAlign: 'right' }}>
        <Btn onClick={onNext} disabled={!vault.validated}>Next →</Btn>
      </div>
    </div>
  );
}

// ---- Step 3: Name ----
function StepName({ userName, onChange, onNext }: {
  userName: string;
  onChange: (v: string) => void;
  onNext: () => void;
}) {
  return (
    <div>
      <h2 style={{ color: TEXT, fontSize: '1.4rem', fontWeight: 700, marginBottom: '0.5rem' }}>What's your name?</h2>
      <p style={{ color: TEXT_DIM, fontSize: '0.9rem', marginBottom: '1.5rem', lineHeight: 1.6 }}>
        Companion will use this name when talking to you.
      </p>
      <Input
        value={userName}
        onChange={onChange}
        placeholder="Your name"
        style={{ fontSize: '1.2rem', padding: '14px 16px', textAlign: 'center' }}
      />
      <div style={{ marginTop: '1.5rem', textAlign: 'right' }}>
        <Btn onClick={onNext} disabled={!userName.trim()}>Next →</Btn>
      </div>
    </div>
  );
}

// ---- Step 4: Secret ----
function StepSecret({ authSecret, onNext }: { authSecret: string; onNext: () => void }) {
  const [copied, setCopied] = useState(false);

  async function copySecret() {
    try {
      await navigator.clipboard.writeText(authSecret);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback: select text
    }
  }

  return (
    <div>
      <h2 style={{ color: TEXT, fontSize: '1.4rem', fontWeight: 700, marginBottom: '0.5rem' }}>Server Secret</h2>
      <p style={{ color: TEXT_DIM, fontSize: '0.9rem', marginBottom: '1.5rem', lineHeight: 1.6 }}>
        This is your password for the mobile app and dashboard.
      </p>
      <Label>Your Secret</Label>
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem' }}>
        <Input value={authSecret} readOnly mono style={{ flex: 1, letterSpacing: '0.05em' }} />
        <Btn onClick={copySecret} variant="secondary">
          {copied ? 'Copied!' : 'Copy'}
        </Btn>
      </div>
      <p style={{ color: TEXT_DIM, fontSize: '0.8rem', marginBottom: '1.5rem' }}>
        Keep this safe. You'll need it to connect your phone.
      </p>
      <div style={{ textAlign: 'right' }}>
        <Btn onClick={onNext}>Next →</Btn>
      </div>
    </div>
  );
}

// ---- Step 5: Model ----

const LOCAL_PROVIDERS: { id: string; label: string; baseUrl: string; modelId: string; preferred?: boolean }[] = [
  { id: 'omlx',     label: 'oMLX',      baseUrl: 'http://localhost:8000/v1',  modelId: 'llama3.2',       preferred: true },
  { id: 'ollama',   label: 'Ollama',     baseUrl: 'http://localhost:11434/v1', modelId: 'llama3.2' },
  { id: 'lmstudio', label: 'LM Studio',  baseUrl: 'http://localhost:1234/v1',  modelId: 'llama-3.2-3b' },
  { id: 'custom',   label: 'Custom',     baseUrl: '',                          modelId: '' },
];

const CLOUD_PROVIDERS: { id: string; label: string; modelPlaceholder: string }[] = [
  { id: 'anthropic', label: 'Anthropic (Claude)', modelPlaceholder: 'claude-sonnet-4-6' },
  { id: 'openai',    label: 'OpenAI',             modelPlaceholder: 'gpt-4o' },
];

function ToggleBtn({
  selected, onClick, children,
}: { selected: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1,
        background: selected ? ACCENT : 'transparent',
        border: selected ? 'none' : `1px solid ${BORDER}`,
        color: selected ? '#000' : TEXT_DIM,
        borderRadius: '6px',
        padding: '8px 12px',
        fontSize: '0.9rem',
        fontWeight: selected ? 700 : 400,
        cursor: 'pointer',
        fontFamily: 'inherit',
        transition: 'all 0.15s',
      }}
    >
      {children}
    </button>
  );
}

function ProviderBtn({
  selected, onClick, children,
}: { selected: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: 'transparent',
        border: selected ? `1px solid ${ACCENT}` : `1px solid ${BORDER}`,
        color: selected ? TEXT : TEXT_DIM,
        borderRadius: '6px',
        padding: '10px 14px',
        fontSize: '0.88rem',
        fontWeight: selected ? 600 : 400,
        cursor: 'pointer',
        fontFamily: 'inherit',
        transition: 'all 0.15s',
        textAlign: 'left' as const,
      }}
    >
      {children}
    </button>
  );
}

type ModelSubTab = 'local' | 'cloud' | 'subscription';

function StepModel({ model, onChange, onNext }: {
  model: WizardState['model'];
  onChange: (v: WizardState['model']) => void;
  onNext: () => void;
}) {
  // Derive initial sub-tab from model state
  const initialTab: ModelSubTab =
    model.provider === 'none' ? 'subscription' :
    model.category === 'local' ? 'local' : 'cloud';
  const [subTab, setSubTab] = useState<ModelSubTab>(initialTab);

  function selectTab(tab: ModelSubTab) {
    setSubTab(tab);
    if (tab === 'local') {
      const p = LOCAL_PROVIDERS[0];
      onChange({ category: 'local', provider: p.id, baseUrl: p.baseUrl, modelId: p.modelId, apiKey: '' });
    } else if (tab === 'cloud') {
      const p = CLOUD_PROVIDERS[0];
      onChange({ category: 'cloud', provider: p.id, baseUrl: '', modelId: '', apiKey: '' });
    } else {
      // subscription — no default model yet
      onChange({ category: 'cloud', provider: 'none', modelId: '', apiKey: '', baseUrl: '' });
    }
  }

  function selectLocalProvider(id: string) {
    const p = LOCAL_PROVIDERS.find(x => x.id === id)!;
    onChange({ ...model, provider: id, baseUrl: p.baseUrl, modelId: p.modelId });
  }

  function selectCloudProvider(id: string) {
    onChange({ ...model, provider: id, modelId: '', apiKey: '' });
  }

  const cloudProvider = CLOUD_PROVIDERS.find(p => p.id === model.provider);

  const isNextDisabled =
    subTab === 'subscription'
      ? false
      : subTab === 'local'
        ? !model.modelId.trim()
        : !model.modelId.trim() || !model.apiKey.trim();

  return (
    <div>
      <h2 style={{ color: TEXT, fontSize: '1.4rem', fontWeight: 700, marginBottom: '0.5rem' }}>LLM Model</h2>
      <p style={{ color: TEXT_DIM, fontSize: '0.9rem', marginBottom: '1.5rem', lineHeight: 1.6 }}>
        Which AI model should Companion use?
      </p>

      {/* Category tabs */}
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.25rem' }}>
        <ToggleBtn selected={subTab === 'local'} onClick={() => selectTab('local')}>
          Local
        </ToggleBtn>
        <ToggleBtn selected={subTab === 'cloud'} onClick={() => selectTab('cloud')}>
          Cloud (API key)
        </ToggleBtn>
        <ToggleBtn selected={subTab === 'subscription'} onClick={() => selectTab('subscription')}>
          Cloud (Subscription)
        </ToggleBtn>
      </div>

      {/* Local providers */}
      {subTab === 'local' && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', marginBottom: '1.25rem' }}>
            {LOCAL_PROVIDERS.map(p => (
              <ProviderBtn key={p.id} selected={model.provider === p.id} onClick={() => selectLocalProvider(p.id)}>
                {p.label}
                {p.preferred && (
                  <span style={{ color: ACCENT, fontSize: '0.75rem', marginLeft: '0.4rem', fontWeight: 400 }}>
                    (preferred)
                  </span>
                )}
              </ProviderBtn>
            ))}
          </div>
          <div style={{ marginBottom: '1rem' }}>
            <Label>Base URL</Label>
            <Input
              value={model.baseUrl}
              onChange={v => onChange({ ...model, baseUrl: v })}
              placeholder="http://localhost:8000/v1"
              mono
            />
          </div>
          <div style={{ marginBottom: '1.5rem' }}>
            <Label>Model</Label>
            <Input
              value={model.modelId}
              onChange={v => onChange({ ...model, modelId: v })}
              placeholder="llama3.2"
            />
          </div>
        </>
      )}

      {/* Cloud (API key) providers */}
      {subTab === 'cloud' && (
        <>
          <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.25rem' }}>
            {CLOUD_PROVIDERS.map(p => (
              <ProviderBtn key={p.id} selected={model.provider === p.id} onClick={() => selectCloudProvider(p.id)}>
                {p.label}
              </ProviderBtn>
            ))}
          </div>
          <div style={{ marginBottom: '1rem' }}>
            <Label>Model ID</Label>
            <Input
              value={model.modelId}
              onChange={v => onChange({ ...model, modelId: v })}
              placeholder={cloudProvider?.modelPlaceholder ?? ''}
            />
          </div>
          <div style={{ marginBottom: '1.5rem' }}>
            <Label>API Key</Label>
            <Input
              value={model.apiKey}
              onChange={v => onChange({ ...model, apiKey: v })}
              placeholder="sk-..."
              type="password"
            />
          </div>
        </>
      )}

      {/* Cloud (Subscription) */}
      {subTab === 'subscription' && (
        <div style={{ background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: '8px', padding: '1.25rem', marginBottom: '1rem' }}>
          <p style={{ color: TEXT, fontSize: '0.9rem', marginBottom: '0.5rem', fontWeight: 500 }}>
            Use your existing subscription
          </p>
          <p style={{ color: TEXT_DIM, fontSize: '0.85rem', lineHeight: 1.6, marginBottom: '1rem' }}>
            Connect your Anthropic, OpenAI, GitHub Copilot, or Google account after setup via the Dashboard → Models → Connected Accounts.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {['Anthropic (Claude Pro/Max)', 'OpenAI (ChatGPT Plus/Pro)', 'GitHub Copilot', 'Google (Gemini CLI)', 'Antigravity (Free)'].map(name => (
              <div key={name} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: TEXT_DIM, fontSize: '0.85rem' }}>
                <span style={{ color: ACCENT }}>○</span>
                {name}
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ textAlign: 'right' }}>
        <Btn onClick={onNext} disabled={isNextDisabled}>Next →</Btn>
      </div>
    </div>
  );
}

// ---- Step 6: Personas ----
function StepPersonas({ personas, onChange, onNext }: {
  personas: Persona[];
  onChange: (v: Persona[]) => void;
  onNext: () => void;
}) {
  function updatePersona(i: number, field: keyof Persona, value: string) {
    const next = personas.map((p, idx) => idx === i ? { ...p, [field]: value } : p);
    onChange(next);
  }

  return (
    <div>
      <h2 style={{ color: TEXT, fontSize: '1.4rem', fontWeight: 700, marginBottom: '0.5rem' }}>Personas</h2>
      <p style={{ color: TEXT_DIM, fontSize: '0.9rem', marginBottom: '1.5rem', lineHeight: 1.6 }}>
        Customize your AI companions. You can always change these later.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginBottom: '1.5rem' }}>
        {personas.map((p, i) => (
          <div key={p.mode} style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.75rem',
            background: SURFACE,
            border: `1px solid ${BORDER}`,
            borderRadius: '8px',
            padding: '0.75rem 1rem',
          }}>
            <input
              value={p.emoji}
              onChange={e => updatePersona(i, 'emoji', e.target.value)}
              maxLength={3}
              style={{
                width: '48px',
                background: BG,
                border: `1px solid ${BORDER}`,
                borderRadius: '6px',
                color: TEXT,
                fontSize: '1.3rem',
                padding: '6px 8px',
                outline: 'none',
                textAlign: 'center',
                fontFamily: 'inherit',
                flexShrink: 0,
              }}
            />
            <input
              value={p.name}
              onChange={e => updatePersona(i, 'name', e.target.value)}
              style={{
                flex: 1,
                background: BG,
                border: `1px solid ${BORDER}`,
                borderRadius: '6px',
                color: TEXT,
                fontSize: '0.95rem',
                padding: '8px 10px',
                outline: 'none',
                fontFamily: 'inherit',
              }}
            />
            <span style={{ color: TEXT_DIM, fontSize: '0.78rem', flexShrink: 0 }}>({p.mode})</span>
          </div>
        ))}
      </div>
      <div style={{ textAlign: 'right' }}>
        <Btn onClick={onNext}>Finish →</Btn>
      </div>
    </div>
  );
}

// ---- Step 7: Calendar ----
function StepCalendar({
  calendar, onChange, onNext, onBack,
}: {
  calendar: WizardState['calendar'];
  onChange: (v: WizardState['calendar']) => void;
  onNext: () => void;
  onBack: () => void;
}) {
  return (
    <div>
      <h2 style={{ color: TEXT, fontSize: '1.4rem', fontWeight: 700, marginBottom: '0.5rem' }}>
        Google Calendar (Optional)
      </h2>
      <p style={{ color: TEXT_DIM, fontSize: '0.9rem', marginBottom: '1.5rem', lineHeight: 1.6 }}>
        Connect your Google Calendar so Companion can see your schedule and create events.
      </p>

      <div style={{
        background: SURFACE,
        border: `1px solid ${BORDER}`,
        borderRadius: '8px',
        padding: '1.25rem',
        marginBottom: '1.5rem',
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem', color: TEXT_DIM, fontSize: '0.88rem', lineHeight: 1.6 }}>
          <div>1. Go to <span style={{ color: TEXT }}>console.cloud.google.com</span></div>
          <div>2. Create a project → Enable <span style={{ color: TEXT }}>"Google Calendar API"</span></div>
          <div>3. Go to APIs &amp; Services → Credentials → Create OAuth client</div>
          <div>4. Choose <span style={{ color: TEXT }}>"TV and Limited Input Devices"</span> as application type</div>
          <div>5. Copy the Client ID and Client Secret below</div>
        </div>
      </div>

      <div style={{ marginBottom: '1rem' }}>
        <Label>Client ID</Label>
        <Input
          value={calendar.clientId}
          onChange={v => onChange({ ...calendar, clientId: v })}
          placeholder="123456.apps.googleusercontent.com"
        />
      </div>
      <div style={{ marginBottom: '1.5rem' }}>
        <Label>Client Secret</Label>
        <Input
          value={calendar.clientSecret}
          onChange={v => onChange({ ...calendar, clientSecret: v })}
          placeholder="GOCSPX-..."
          type="password"
        />
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Btn variant="secondary" onClick={onBack}>← Back</Btn>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <Btn variant="secondary" onClick={() => {
            onChange({ clientId: '', clientSecret: '', skip: true });
            onNext();
          }}>Skip</Btn>
          <Btn
            onClick={onNext}
            disabled={!calendar.clientId.trim() || !calendar.clientSecret.trim()}
          >Next →</Btn>
        </div>
      </div>
    </div>
  );
}

// ---- Step 8: Applying ----
function StepApply({ state, onBack }: { state: WizardState; onBack: () => void }) {
  const [phase, setPhase] = useState<'applying' | 'done' | 'error'>('applying');
  const [error, setError] = useState<string | null>(null);
  const [showDashboard, setShowDashboard] = useState(false);
  const apkUrl = window.location.origin + '/download/apk';

  // Calendar connect state
  const [calPhase, setCalPhase] = useState<'idle' | 'starting' | 'waiting' | 'connected' | 'error' | 'skip'>('idle');
  const [calCode, setCalCode] = useState<string | null>(null);
  const [calUrl, setCalUrl] = useState<string | null>(null);
  const [calErr, setCalErr] = useState<string | null>(null);
  const [calToken, setCalToken] = useState<string | null>(null);
  const calPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const calUrlOpenedRef = useRef(false);

  useEffect(() => {
    async function apply() {
      try {
        const { model } = state;
        let defaultModel: string;
        let defaultModelKey: string;
        if (model.provider === 'none') {
          // Subscription tab selected — skip model config
          defaultModel = '';
          defaultModelKey = '';
        } else if (model.category === 'local' && model.provider !== 'custom') {
          defaultModel = `openai-compat:${model.baseUrl}:${model.modelId}`;
          defaultModelKey = '';
        } else if (model.category === 'cloud' && model.provider === 'anthropic') {
          defaultModel = `anthropic:${model.modelId}`;
          defaultModelKey = model.apiKey;
        } else if (model.category === 'cloud' && model.provider === 'openai') {
          defaultModel = `openai:${model.modelId}`;
          defaultModelKey = model.apiKey;
        } else {
          // custom
          defaultModel = model.baseUrl ? `${model.baseUrl}:${model.modelId}` : model.modelId;
          defaultModelKey = model.apiKey;
        }
        const applyBody = {
          ...state,
          model: { defaultModel, apiKey: defaultModelKey },
          googleClientId: state.calendar.skip ? '' : state.calendar.clientId,
          googleClientSecret: state.calendar.skip ? '' : state.calendar.clientSecret,
        };
        const r = await fetch('/install/apply', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(applyBody),
        });
        const d = await r.json() as { ok?: boolean; error?: string };
        if (!r.ok) throw new Error(d.error ?? 'Apply failed');
        setPhase('done');
        setTimeout(() => setShowDashboard(true), 3000);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Apply failed');
        setPhase('error');
      }
    }
    apply();
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps

  // Calendar connect flow — kicks off when server is back up
  useEffect(() => {
    if (!showDashboard) return;
    if (state.calendar.skip || !state.calendar.clientId) {
      setCalPhase('skip');
      return;
    }

    async function startCalendar() {
      setCalPhase('starting');

      // Get JWT — retry up to 10 times with 2s delay
      let token: string | null = null;
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          const tr = await fetch('/auth/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ secret: state.authSecret }),
          });
          if (tr.ok) {
            const td = await tr.json() as { token: string };
            token = td.token;
            break;
          }
        } catch {
          // server still restarting
        }
        await new Promise(res => setTimeout(res, 2000));
      }

      if (!token) {
        setCalPhase('error');
        setCalErr('Could not start calendar auth. You can connect later from Dashboard → Setup.');
        return;
      }
      setCalToken(token);

      // Start device flow
      try {
        const dr = await fetch('/calendar/auth/device/start', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!dr.ok) throw new Error('Device start failed');
        const dd = await dr.json() as { user_code: string; verification_url: string; expires_in: number };
        setCalCode(dd.user_code);
        setCalUrl(dd.verification_url);
        setCalPhase('waiting');
      } catch {
        setCalPhase('error');
        setCalErr('Could not start calendar auth. You can connect later from Dashboard → Setup.');
        return;
      }
    }

    startCalendar();

    return () => {
      if (calPollRef.current) clearInterval(calPollRef.current);
    };
  }, [showDashboard]);  // eslint-disable-line react-hooks/exhaustive-deps

  // Poll for calendar authorization
  useEffect(() => {
    if (calPhase !== 'waiting' || !calToken) return;

    calPollRef.current = setInterval(async () => {
      try {
        const pr = await fetch('/calendar/auth/device/status', {
          headers: { Authorization: `Bearer ${calToken}` },
        });
        if (pr.ok) {
          const pd = await pr.json() as { connected: boolean };
          if (pd.connected) {
            setCalPhase('connected');
            if (calPollRef.current) clearInterval(calPollRef.current);
          }
        }
      } catch {
        // ignore transient errors
      }
    }, 3000);

    return () => {
      if (calPollRef.current) clearInterval(calPollRef.current);
    };
  }, [calPhase, calToken]);

  // Auto-open verification URL once
  useEffect(() => {
    if (calPhase === 'waiting' && calUrl && !calUrlOpenedRef.current) {
      calUrlOpenedRef.current = true;
      window.open(calUrl, '_blank');
    }
  }, [calPhase, calUrl]);

  if (phase === 'applying') {
    return (
      <div style={{ textAlign: 'center', padding: '2rem 0' }}>
        <h2 style={{ color: TEXT, fontSize: '1.4rem', fontWeight: 700, marginBottom: '2rem' }}>
          Setting up Companion...
        </h2>
        <Spinner />
      </div>
    );
  }

  if (phase === 'error') {
    return (
      <div style={{ textAlign: 'center', padding: '2rem 0' }}>
        <h2 style={{ color: ERROR, fontSize: '1.4rem', fontWeight: 700, marginBottom: '1rem' }}>
          Setup failed
        </h2>
        <p style={{ color: TEXT_DIM, fontSize: '0.9rem', marginBottom: '1.5rem' }}>{error}</p>
        <Btn onClick={onBack} variant="secondary">← Back</Btn>
      </div>
    );
  }

  return (
    <div style={{ textAlign: 'center', padding: '2rem 0' }}>
      <h2 style={{ color: TEXT, fontSize: '1.4rem', fontWeight: 700, marginBottom: '1rem' }}>
        All done! 🎉
      </h2>
      <p style={{ color: TEXT_DIM, fontSize: '0.9rem', marginBottom: '1.5rem' }}>
        Server is restarting...
      </p>
      {showDashboard && (
        <>
          <a
            href="/dashboard"
            style={{
              color: ACCENT,
              fontSize: '1rem',
              textDecoration: 'none',
              fontWeight: 600,
            }}
          >
            → Open Dashboard
          </a>

          {/* Calendar connect section */}
          {calPhase !== 'skip' && (
            <div style={{ marginTop: '2rem', borderTop: `1px solid ${BORDER}`, paddingTop: '1.5rem', textAlign: 'left' }}>
              <p style={{ color: TEXT, fontSize: '0.95rem', fontWeight: 600, marginBottom: '0.75rem' }}>
                Connect Google Calendar
              </p>

              {(calPhase === 'idle' || calPhase === 'starting') && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', color: TEXT_DIM, fontSize: '0.88rem' }}>
                  <Spinner />
                  <span>Starting authorization...</span>
                </div>
              )}

              {calPhase === 'waiting' && calCode && (
                <>
                  <p style={{ color: TEXT_DIM, fontSize: '0.85rem', marginBottom: '0.75rem' }}>
                    Enter this code at accounts.google.com/device:
                  </p>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '0.75rem' }}>
                    <span style={{
                      fontFamily: 'monospace',
                      fontSize: '1.4rem',
                      fontWeight: 700,
                      color: TEXT,
                      background: BG,
                      border: `1px solid ${BORDER}`,
                      borderRadius: '6px',
                      padding: '8px 16px',
                      letterSpacing: '0.1em',
                    }}>
                      {calCode}
                    </span>
                    {calUrl && (
                      <a
                        href={calUrl}
                        target="_blank"
                        rel="noreferrer"
                        style={{
                          color: ACCENT,
                          fontSize: '0.88rem',
                          fontWeight: 600,
                          textDecoration: 'none',
                          border: `1px solid ${ACCENT}`,
                          borderRadius: '6px',
                          padding: '6px 12px',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        Open Google →
                      </a>
                    )}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: TEXT_DIM, fontSize: '0.85rem' }}>
                    <span>Waiting for authorization...</span>
                    <div style={{
                      width: '14px',
                      height: '14px',
                      borderRadius: '50%',
                      border: `2px solid ${BORDER}`,
                      borderTopColor: ACCENT,
                      animation: 'spin 0.8s linear infinite',
                      flexShrink: 0,
                    }} />
                  </div>
                </>
              )}

              {calPhase === 'connected' && (
                <p style={{ color: ACCENT, fontSize: '0.95rem', fontWeight: 600 }}>
                  ✓ Google Calendar connected
                </p>
              )}

              {calPhase === 'error' && (
                <p style={{ color: TEXT_DIM, fontSize: '0.85rem' }}>
                  ⚠ {calErr}
                </p>
              )}
            </div>
          )}

          <div style={{ marginTop: '2rem', borderTop: `1px solid ${BORDER}`, paddingTop: '1.5rem' }}>
            <p style={{ color: TEXT, fontSize: '0.95rem', fontWeight: 600, marginBottom: '0.4rem' }}>
              Install on Android
            </p>
            <p style={{ color: TEXT_DIM, fontSize: '0.82rem', marginBottom: '1.25rem' }}>
              Scan with your phone camera — it will download the app directly to your phone.
            </p>
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '1rem' }}>
              <QRCodeImg value={apkUrl} size={200} dark="#F0EDE8" light="#0D0B08" />
            </div>
            <p style={{ color: TEXT_DIM, fontSize: '0.75rem', fontFamily: 'monospace', wordBreak: 'break-all' }}>
              {apkUrl}
            </p>
          </div>
        </>
      )}
    </div>
  );
}

// ---- Main App ----
export default function InstallApp() {
  const [step, setStep] = useState(0);
  const [alreadyConfigured, setAlreadyConfigured] = useState(false);
  const [state, setState] = useState<WizardState>({
    vault: { path: '', validated: false, exists: false, missingFolders: [] },
    userName: '',
    authSecret: generateSecret(),
    model: { category: 'local', provider: 'omlx', baseUrl: 'http://localhost:8000/v1', modelId: 'llama3.2', apiKey: '' },
    personas: [],
    calendar: { clientId: '', clientSecret: '', skip: false },
  });

  useEffect(() => {
    // Inject spinner keyframe
    const style = document.createElement('style');
    style.textContent = '@keyframes spin { to { transform: rotate(360deg); } }';
    document.head.appendChild(style);

    async function init() {
      try {
        const r = await fetch('/install/status');
        const d = await r.json() as { configured?: boolean };
        if (d.configured) {
          setAlreadyConfigured(true);
          return;
        }
      } catch {
        // server may not have this endpoint yet — continue normally
      }

      try {
        const r = await fetch('/install/personas');
        if (r.ok) {
          const personas = await r.json() as Persona[];
          setState(s => ({ ...s, personas }));
        }
      } catch {
        // ignore — user can fill in manually
      }
    }
    init();
  }, []);

  if (alreadyConfigured) {
    return (
      <div style={{
        minHeight: '100vh',
        background: BG,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}>
        <div style={{
          background: SURFACE,
          border: `1px solid ${BORDER}`,
          borderRadius: '12px',
          padding: '2.5rem 2rem',
          maxWidth: '400px',
          textAlign: 'center',
        }}>
          <h2 style={{ color: TEXT, fontSize: '1.3rem', fontWeight: 700, marginBottom: '0.75rem' }}>
            Already configured
          </h2>
          <p style={{ color: TEXT_DIM, fontSize: '0.9rem', marginBottom: '1.5rem' }}>
            Companion is already set up.
          </p>
          <a href="/dashboard" style={{ color: ACCENT, fontSize: '1rem', textDecoration: 'none', fontWeight: 600 }}>
            → Open Dashboard
          </a>
        </div>
      </div>
    );
  }

  const TOTAL_STEPS = 7; // steps 1–7

  function stepIndicator() {
    if (step === 0 || step === 8) return null;
    return (
      <div style={{ color: TEXT_DIM, fontSize: '0.78rem', marginBottom: '1.5rem', textAlign: 'center' }}>
        Step {step} of {TOTAL_STEPS}
      </div>
    );
  }

  return (
    <div style={{
      minHeight: '100vh',
      background: BG,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      padding: '2rem 1rem',
    }}>
      <div style={{
        background: SURFACE,
        border: `1px solid ${BORDER}`,
        borderRadius: '12px',
        padding: '2.5rem 2rem',
        width: '100%',
        maxWidth: '540px',
      }}>
        {stepIndicator()}

        {step === 0 && (
          <StepWelcome onNext={() => setStep(1)} />
        )}

        {step === 1 && (
          <>
            <StepTailscale onNext={() => setStep(2)} />
            <div style={{ marginTop: '1rem' }}>
              <Btn onClick={() => setStep(0)} variant="secondary">← Back</Btn>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <StepVault
              vault={state.vault}
              onChange={vault => setState(s => ({ ...s, vault }))}
              onNext={() => setStep(3)}
            />
            <div style={{ marginTop: '1rem' }}>
              <Btn onClick={() => setStep(1)} variant="secondary">← Back</Btn>
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <StepName
              userName={state.userName}
              onChange={userName => setState(s => ({ ...s, userName }))}
              onNext={() => setStep(4)}
            />
            <div style={{ marginTop: '1rem' }}>
              <Btn onClick={() => setStep(2)} variant="secondary">← Back</Btn>
            </div>
          </>
        )}

        {step === 4 && (
          <>
            <StepSecret authSecret={state.authSecret} onNext={() => setStep(5)} />
            <div style={{ marginTop: '1rem' }}>
              <Btn onClick={() => setStep(3)} variant="secondary">← Back</Btn>
            </div>
          </>
        )}

        {step === 5 && (
          <>
            <StepModel
              model={state.model}
              onChange={model => setState(s => ({ ...s, model }))}
              onNext={() => setStep(6)}
            />
            <div style={{ marginTop: '1rem' }}>
              <Btn onClick={() => setStep(4)} variant="secondary">← Back</Btn>
            </div>
          </>
        )}

        {step === 6 && (
          <>
            <StepPersonas
              personas={state.personas}
              onChange={personas => setState(s => ({ ...s, personas }))}
              onNext={() => setStep(7)}
            />
            <div style={{ marginTop: '1rem' }}>
              <Btn onClick={() => setStep(5)} variant="secondary">← Back</Btn>
            </div>
          </>
        )}

        {step === 7 && (
          <StepCalendar
            calendar={state.calendar}
            onChange={calendar => setState(s => ({ ...s, calendar }))}
            onNext={() => setStep(8)}
            onBack={() => setStep(6)}
          />
        )}

        {step === 8 && (
          <StepApply state={state} onBack={() => setStep(7)} />
        )}
      </div>
    </div>
  );
}
