import React, { useEffect, useState } from 'react';
import { apiFetch } from '../api';

interface VaultStats {
  vaultPath: string;
  wikiPages: number;
  rawDumps: number;
  journalDays: number;
  memoryEntries: number;
}

const SURFACE = '#1A1714';
const BORDER = '#2A2520';
const TEXT = '#F0EDE8';
const TEXT_DIM = '#8A8480';
const ACCENT = '#4CAF50';
const ERROR = '#FF6135';
const BG = '#0D0B08';

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div style={{
      background: SURFACE,
      border: `1px solid ${BORDER}`,
      borderRadius: '8px',
      padding: '1.25rem 1.5rem',
      minWidth: '140px',
      flex: '1',
    }}>
      <p style={{ color: TEXT_DIM, fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '0.5rem' }}>
        {label}
      </p>
      <p style={{ color: TEXT, fontSize: '2rem', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
        {value.toLocaleString()}
      </p>
    </div>
  );
}

interface BackupStatus {
  lastBackup: string | null;
  backupPath: string | null;
  count: number;
}

function relativeTime(iso: string | null): string {
  if (!iso) return 'never';
  const diffMs = Date.now() - new Date(iso).getTime();
  const secs = Math.floor(diffMs / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export default function VaultPanel() {
  const [stats, setStats] = useState<VaultStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [editingVault, setEditingVault] = useState(false);
  const [newVaultPath, setNewVaultPath] = useState('');
  const [vaultSaving, setVaultSaving] = useState(false);
  const [vaultErr, setVaultErr] = useState<string | null>(null);

  const [backupStatus, setBackupStatus] = useState<BackupStatus | null>(null);
  const [backupDest, setBackupDest] = useState('~/companion-vault-backup');
  const [backupRunning, setBackupRunning] = useState(false);
  const [backupMsg, setBackupMsg] = useState<string | null>(null);
  const [backupErr, setBackupErr] = useState<string | null>(null);

  useEffect(() => {
    apiFetch('/admin/stats')
      .then(r => r.ok ? r.json() : r.json().then((e: { error: string }) => { throw new Error(e.error); }))
      .then((d: VaultStats) => {
        setStats(d);
        setLoading(false);
      })
      .catch((err: Error) => {
        setError(err.message);
        setLoading(false);
      });

    apiFetch('/admin/backup/status')
      .then(r => r.json())
      .then((d: BackupStatus) => {
        setBackupStatus(d);
        setBackupDest(d.backupPath ?? '~/companion-vault-backup');
      })
      .catch(() => { /* non-fatal */ });
  }, []);

  function copyPath() {
    if (!stats) return;
    navigator.clipboard.writeText(stats.vaultPath).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  function startEditVault() {
    setNewVaultPath(stats?.vaultPath ?? '');
    setVaultErr(null);
    setEditingVault(true);
  }

  function saveVault() {
    if (!newVaultPath.trim()) return;
    setVaultSaving(true);
    setVaultErr(null);
    apiFetch('/admin/vault', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: newVaultPath.trim() }),
    })
      .then(r => r.json())
      .then((d: { ok?: boolean; error?: string }) => {
        if (d.ok) {
          setEditingVault(false);
        } else {
          setVaultErr(d.error ?? 'Failed to update vault');
          setVaultSaving(false);
        }
      })
      .catch((err: Error) => {
        setVaultErr(err.message);
        setVaultSaving(false);
      });
  }

  function runBackup() {
    setBackupRunning(true);
    setBackupMsg(null);
    setBackupErr(null);
    apiFetch('/admin/backup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ destination: backupDest }),
    })
      .then(r => r.json())
      .then((d: { ok: boolean; error?: string; backupPath?: string; lastBackup?: string }) => {
        if (d.ok) {
          setBackupMsg('Backup complete');
          setTimeout(() => setBackupMsg(null), 3000);
          apiFetch('/admin/backup/status')
            .then(r => r.json())
            .then((s: BackupStatus) => setBackupStatus(s))
            .catch(() => { /* non-fatal */ });
        } else {
          setBackupErr(d.error ?? 'Backup failed');
        }
      })
      .catch((err: Error) => setBackupErr(err.message))
      .finally(() => setBackupRunning(false));
  }

  function onDestBlur() {
    const trimmed = backupDest.trim();
    if (!trimmed) return;
    apiFetch('/admin/backup/destination', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ destination: trimmed }),
    }).catch(() => { /* non-fatal */ });
  }

  return (
    <div>
      <h2 style={{ color: TEXT, fontSize: '1.25rem', fontWeight: 600, marginBottom: '1.5rem' }}>Vault</h2>

      {loading && <p style={{ color: TEXT_DIM, fontSize: '0.875rem' }}>Loading…</p>}
      {error && <p style={{ color: ERROR, fontSize: '0.875rem' }}>{error}</p>}

      {stats && (
        <>
          <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', marginBottom: '2rem' }}>
            <StatCard label="Wiki Pages" value={stats.wikiPages} />
            <StatCard label="Raw Dumps" value={stats.rawDumps} />
            <StatCard label="Journal Days" value={stats.journalDays} />
            <StatCard label="Memory Entries" value={stats.memoryEntries} />
          </div>

          <div style={{
            background: SURFACE,
            border: `1px solid ${BORDER}`,
            borderRadius: '8px',
            padding: '1.25rem',
          }}>
            <p style={{ color: TEXT_DIM, fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '0.75rem' }}>
              Vault Path
            </p>

            {!editingVault ? (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                  <code style={{
                    background: BG,
                    border: `1px solid ${BORDER}`,
                    borderRadius: '4px',
                    padding: '6px 10px',
                    color: TEXT,
                    fontSize: '0.85rem',
                    fontFamily: 'monospace',
                    flex: 1,
                    wordBreak: 'break-all',
                  }}>
                    {stats.vaultPath}
                  </code>
                  <button onClick={copyPath} style={{ background: 'transparent', border: `1px solid ${BORDER}`, color: copied ? ACCENT : TEXT_DIM, borderRadius: '4px', padding: '5px 12px', fontSize: '0.8rem', cursor: 'pointer', whiteSpace: 'nowrap', transition: 'color 0.2s' }}>
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                  <button onClick={startEditVault} style={{ background: 'transparent', border: `1px solid ${BORDER}`, color: TEXT_DIM, borderRadius: '4px', padding: '5px 12px', fontSize: '0.8rem', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                    Change
                  </button>
                </div>
              </>
            ) : (
              <>
                <input
                  type="text"
                  value={newVaultPath}
                  onChange={e => setNewVaultPath(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') saveVault(); if (e.key === 'Escape') setEditingVault(false); }}
                  autoFocus
                  style={{ background: BG, border: `1px solid ${ACCENT}`, borderRadius: '4px', padding: '6px 10px', color: TEXT, fontSize: '0.85rem', fontFamily: 'monospace', width: '100%', boxSizing: 'border-box', outline: 'none', marginBottom: '0.6rem' }}
                />
                <p style={{ color: TEXT_DIM, fontSize: '0.78rem', marginBottom: '0.75rem' }}>
                  Server will restart after saving. Missing subdirs will be created automatically.
                </p>
                {vaultErr && <p style={{ color: ERROR, fontSize: '0.78rem', marginBottom: '0.75rem' }}>{vaultErr}</p>}
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button
                    onClick={saveVault}
                    disabled={vaultSaving}
                    style={{ background: ACCENT, border: 'none', borderRadius: '6px', padding: '7px 18px', color: '#fff', fontSize: '0.85rem', fontWeight: 600, cursor: vaultSaving ? 'not-allowed' : 'pointer', opacity: vaultSaving ? 0.7 : 1 }}
                  >
                    {vaultSaving ? 'Saving…' : 'Save & Restart'}
                  </button>
                  <button
                    onClick={() => { setEditingVault(false); setVaultErr(null); }}
                    disabled={vaultSaving}
                    style={{ background: 'transparent', border: `1px solid ${BORDER}`, borderRadius: '6px', padding: '7px 18px', color: TEXT_DIM, fontSize: '0.85rem', cursor: 'pointer' }}
                  >
                    Cancel
                  </button>
                </div>
              </>
            )}
          </div>

          <div style={{
            background: SURFACE,
            border: `1px solid ${BORDER}`,
            borderRadius: '8px',
            padding: '1.25rem',
            marginTop: '1rem',
          }}>
            <p style={{ color: TEXT_DIM, fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '0.75rem' }}>
              Backup
            </p>

            <div style={{ marginBottom: '0.75rem' }}>
              <p style={{ color: TEXT_DIM, fontSize: '0.78rem', marginBottom: '0.35rem' }}>Destination</p>
              <input
                type="text"
                value={backupDest}
                onChange={e => setBackupDest(e.target.value)}
                onBlur={onDestBlur}
                style={{
                  background: BG,
                  border: `1px solid ${BORDER}`,
                  borderRadius: '4px',
                  padding: '6px 10px',
                  color: TEXT,
                  fontSize: '0.85rem',
                  fontFamily: 'monospace',
                  width: '100%',
                  boxSizing: 'border-box',
                  outline: 'none',
                }}
              />
            </div>

            <p style={{ color: TEXT_DIM, fontSize: '0.82rem', marginBottom: '0.85rem' }}>
              Last backup: {relativeTime(backupStatus?.lastBackup ?? null)}
              {backupStatus && backupStatus.count > 0 && (
                <span style={{ marginLeft: '1.25rem' }}>Count: {backupStatus.count}</span>
              )}
            </p>

            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
              <button
                onClick={runBackup}
                disabled={backupRunning}
                style={{
                  background: ACCENT,
                  border: 'none',
                  borderRadius: '6px',
                  padding: '8px 20px',
                  color: '#fff',
                  fontSize: '0.875rem',
                  fontWeight: 600,
                  cursor: backupRunning ? 'not-allowed' : 'pointer',
                  opacity: backupRunning ? 0.7 : 1,
                  transition: 'opacity 0.2s',
                }}
              >
                {backupRunning ? 'Backing up…' : 'Back Up Now'}
              </button>

              {backupMsg && (
                <span style={{ color: ACCENT, fontSize: '0.875rem' }}>{backupMsg}</span>
              )}
              {backupErr && (
                <span style={{ color: ERROR, fontSize: '0.875rem' }}>{backupErr}</span>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
