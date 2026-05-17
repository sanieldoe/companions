import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Modal, View, Text, StyleSheet, ScrollView, TouchableOpacity,
  TextInput, ActivityIndicator, Alert, Linking,
} from 'react-native';
import { Clipboard } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { deleteItem } from '../lib/storage';
import { useTheme } from '../lib/theme';
import { apiFetch } from '../lib/api';
import { useStore, ConversationMeta, MODE_ACCENTS, getModeName } from '../lib/store';
import { wsService } from '../lib/ws';

const DANGER = '#ff453a';

function formatConvoDate(ts: number): string {
  const now = Date.now();
  const diff = now - ts;
  const day = 86400000;
  if (diff < day) return 'Today';
  if (diff < 2 * day) return 'Yesterday';
  const d = new Date(ts);
  return `${d.getDate()} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()]}`;
}

interface ModelEntry { provider: string; id: string; name: string; contextWindow: number; }
interface ProviderInfo { authStatus: { configured: boolean; source?: string }; models: ModelEntry[]; }

// Providers shown prominently — in display order
const FEATURED: { id: string; label: string; oauth?: boolean }[] = [
  { id: 'anthropic',     label: 'Anthropic' },
  { id: 'openai',        label: 'OpenAI' },
  { id: 'github-copilot', label: 'GitHub Copilot', oauth: true },
];

// All built-in cloud provider IDs (from Pi SDK) — anything else is "local/custom"
const CLOUD_PROVIDER_IDS = new Set([
  'amazon-bedrock','anthropic','azure-openai-responses','cerebras','deepseek',
  'fireworks','github-copilot','google','google-antigravity','google-gemini-cli',
  'google-vertex','groq','huggingface','kimi-coding','minimax','minimax-cn',
  'mistral','openai','openai-codex','opencode','opencode-go','openrouter',
  'vercel-ai-gateway','xai','zai',
]);

interface Props { visible: boolean; onClose: () => void; section?: 'model' | 'history'; }

export default function SettingsModal({ visible, onClose, section }: Props) {
  const insets = useSafeAreaInsets();
  const theme = useTheme();

  const conversations = useStore((s) => s.conversations);
  const modes = useStore((s) => s.modes);
  const activeConversationId = useStore((s) => s.activeConversationId);
  const newConversation = useStore((s) => s.newConversation);
  const loadConversation = useStore((s) => s.loadConversation);
  const renameConversation = useStore((s) => s.renameConversation);
  const deleteConversation = useStore((s) => s.deleteConversation);
  const clearAllHistory = useStore((s) => s.clearAllHistory);
  const moveConversation = useStore((s) => s.moveConversation);

  const [renameTargetId, setRenameTargetId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');

  // Folder UI state
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [newFolderName, setNewFolderName] = useState('');
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newConvoFolder, setNewConvoFolder] = useState<string | undefined>(undefined);
  const [showNewConvoFolderPicker, setShowNewConvoFolderPicker] = useState(false);

  const toggleFolder = (folder: string) => {
    setExpandedFolders(prev => {
      const next = new Set(prev);
      next.has(folder) ? next.delete(folder) : next.add(folder);
      return next;
    });
  };

  // Derive folder list and grouped conversations
  const folders = Array.from(
    new Set(conversations.map(c => c.folder).filter((f): f is string => !!f))
  ).sort();
  const byFolder = (folder: string) => conversations.filter(c => c.folder === folder);
  const unfiled = conversations.filter(c => !c.folder);

  const [providers, setProviders] = useState<Record<string, ProviderInfo>>({});
  const [chatModel, setChatModel] = useState<{ provider: string; modelId: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // API key entry
  const [keyInputProvider, setKeyInputProvider] = useState<string | null>(null);
  const [keyInputValue, setKeyInputValue] = useState('');
  const [keyInputSaving, setKeyInputSaving] = useState(false);

  // Model picker
  const [chatPickerOpen, setChatPickerOpen] = useState(false);

  // Device code OAuth
  const [oauthProvider, setOauthProvider] = useState<string | null>(null);
  const [oauthUrl, setOauthUrl] = useState<string | null>(null);
  const [oauthCode, setOauthCode] = useState<string | null>(null);
  const [oauthPolling, setOauthPolling] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  };

  useEffect(() => () => stopPolling(), []);

  useEffect(() => {
    if (!visible) stopPolling();
  }, [visible]);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [provRes, chatRes] = await Promise.all([
        apiFetch('/providers'),
        apiFetch('/modes/chat/model'),
      ]);
      const provData = await provRes.json() as { providers: Record<string, ProviderInfo> };
      const chatData = await chatRes.json() as { model: { provider: string; modelId: string } | null };
      setProviders(provData.providers ?? {});
      setChatModel(chatData.model);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (visible) loadData(); }, [visible, loadData]);

  // ── API key flow ──────────────────────────────────────────────────────────
  const saveApiKey = async () => {
    if (!keyInputProvider || !keyInputValue.trim()) return;
    setKeyInputSaving(true);
    try {
      const res = await apiFetch(`/providers/${keyInputProvider}/apikey`, {
        method: 'POST', body: JSON.stringify({ key: keyInputValue.trim() }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? 'Failed');
      setKeyInputProvider(null);
      setKeyInputValue('');
      await loadData();
    } catch (err) {
      Alert.alert('Error', err instanceof Error ? err.message : 'Failed to save key');
    } finally {
      setKeyInputSaving(false);
    }
  };

  const removeApiKey = async (provider: string) => {
    try {
      await apiFetch(`/providers/${provider}/apikey`, { method: 'DELETE' });
      await loadData();
    } catch { /* ignore */ }
  };

  // ── OAuth / device-code flow ──────────────────────────────────────────────
  const startOAuth = async (provider: string) => {
    stopPolling();
    setOauthProvider(provider);
    setOauthUrl(null);
    setOauthCode(null);
    setOauthPolling(false);
    try {
      const res = await apiFetch(`/providers/${provider}/login`, { method: 'POST' });
      const data = await res.json() as { authUrl?: string; userCode?: string; error?: string };
      if (!res.ok || !data.authUrl) throw new Error(data.error ?? 'Failed to start login');
      setOauthUrl(data.authUrl);
      setOauthCode(data.userCode ?? null);
      setOauthPolling(true);
      pollRef.current = setInterval(async () => {
        try {
          const r = await apiFetch(`/providers/${provider}/login/status`);
          const s = await r.json() as { done: boolean; error?: string };
          if (s.done) {
            stopPolling();
            setOauthPolling(false);
            setOauthProvider(null);
            setOauthUrl(null);
            setOauthCode(null);
            await loadData();
          }
        } catch { stopPolling(); setOauthPolling(false); }
      }, 3000);
    } catch (err) {
      setOauthProvider(null);
      Alert.alert('Login failed', err instanceof Error ? err.message : 'Unknown error');
    }
  };

  const cancelOAuth = () => {
    stopPolling();
    setOauthProvider(null);
    setOauthUrl(null);
    setOauthCode(null);
    setOauthPolling(false);
  };

  // ── Model selection ───────────────────────────────────────────────────────
  const saveChatModel = async (provider: string, modelId: string) => {
    try {
      const res = await apiFetch('/modes/chat/model', {
        method: 'PUT', body: JSON.stringify({ provider, modelId }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? 'Failed');
      setChatModel({ provider, modelId });
      setChatPickerOpen(false);
    } catch (err) {
      Alert.alert('Error', err instanceof Error ? err.message : 'Failed to set model');
    }
  };

  const resetChatModel = async () => {
    try {
      await apiFetch('/modes/chat/model', { method: 'PUT', body: JSON.stringify(null) });
      setChatModel(null);
    } catch { /* ignore */ }
  };

  // Available models sorted: configured providers first, then alphabetical
  const sortedModels = Object.entries(providers)
    .sort(([, a], [, b]) => {
      if (a.authStatus.configured !== b.authStatus.configured)
        return a.authStatus.configured ? -1 : 1;
      return 0;
    })
    .flatMap(([, info]) => info.models);

  const localProviders = Object.entries(providers).filter(([id]) => !CLOUD_PROVIDER_IDS.has(id));

  // ── Conversation row renderer ────────────────────────────────────────────
  const renderConvo = (c: ConversationMeta) => {
    const isActive = c.id === activeConversationId;
    const isRenaming = renameTargetId === c.id;
    return (
      <View key={c.id} style={[styles.convoRow, { borderTopColor: theme.border }]}>
        <TouchableOpacity
          style={styles.convoRowMain}
          activeOpacity={isActive ? 1 : 0.7}
          onPress={() => { if (!isRenaming && !isActive) { loadConversation(c.id); onClose(); } }}
        >
          <View style={styles.convoRowHeader}>
            <Text style={[styles.convoDate, { color: theme.textFaint }]}>{formatConvoDate(c.startedAt)}</Text>
            {isActive && <Text style={[styles.convoBadge, { color: MODE_ACCENTS.mentor }]}>current</Text>}
          </View>
          {isRenaming ? (
            <TextInput
              style={[styles.convoRenameInput, { color: theme.text, borderColor: theme.border, backgroundColor: theme.inputBg }]}
              value={renameDraft}
              onChangeText={setRenameDraft}
              onSubmitEditing={() => { if (renameDraft.trim()) renameConversation(c.id, renameDraft.trim()); setRenameTargetId(null); }}
              onBlur={() => { if (renameDraft.trim()) renameConversation(c.id, renameDraft.trim()); setRenameTargetId(null); }}
              autoFocus returnKeyType="done" selectTextOnFocus
            />
          ) : (
            <Text style={[styles.convoTitle, { color: isActive ? theme.textDim : theme.text }]} numberOfLines={1}>
              {c.title}
            </Text>
          )}
        </TouchableOpacity>
        <View style={styles.convoActions}>
          <TouchableOpacity
            style={styles.convoActionBtn} activeOpacity={0.7}
            onPress={() => { setRenameTargetId(c.id); setRenameDraft(c.title); }}
          >
            <Text style={[styles.convoActionLabel, { color: theme.textDim }]}>✎</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.convoActionBtn} activeOpacity={0.7}
            onPress={() => {
              const options = [
                ...folders.filter(f => f !== c.folder).map(f => ({
                  text: `Move to “${f}”`,
                  onPress: () => moveConversation(c.id, f),
                })),
                ...(c.folder ? [{ text: 'Remove from folder', onPress: () => moveConversation(c.id, undefined) }] : []),
                { text: 'Delete', style: 'destructive' as const, onPress: () =>
                  Alert.alert('Delete conversation', `“${c.title}” will be permanently deleted.`, [
                    { text: 'Cancel', style: 'cancel' },
                    { text: 'Delete', style: 'destructive', onPress: () => deleteConversation(c.id) },
                  ])
                },
                { text: 'Cancel', style: 'cancel' as const },
              ];
              Alert.alert(c.title, undefined, options);
            }}
          >
            <Text style={[styles.convoActionLabel, { color: theme.textDim }]}>⋯</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={[styles.root, { backgroundColor: theme.bg, paddingTop: insets.top }]}>
        <View style={[styles.header, { borderBottomColor: theme.border }]}>
          <Text style={[styles.title, { color: theme.text }]}>
            {section === 'model' ? 'Model' : section === 'history' ? 'Conversations' : 'Settings'}
          </Text>
          <TouchableOpacity onPress={onClose} activeOpacity={0.7} style={styles.closeBtn}>
            <Text style={[styles.closeBtnLabel, { color: theme.textDim }]}>Done</Text>
          </TouchableOpacity>
        </View>

        {loading ? (
          <View style={styles.center}><ActivityIndicator /></View>
        ) : error ? (
          <View style={styles.center}>
            <Text style={[styles.errorText, { color: theme.textDim }]}>{error}</Text>
            <TouchableOpacity onPress={loadData}><Text style={{ color: '#4CAF50' }}>Retry</Text></TouchableOpacity>
          </View>
        ) : (
          <ScrollView contentContainerStyle={styles.scroll}>

            {/* ── CONVERSATIONS ─────────────────────────────────── */}
            {(!section || section === 'history') && (<>
            <Text style={[styles.sectionLabel, { color: theme.textDim }]}>CONVERSATIONS</Text>
            <View style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}>

              {/* New conversation — with optional folder picker */}
              <TouchableOpacity
                style={styles.providerRow}
                activeOpacity={0.7}
                onPress={() => setShowNewConvoFolderPicker(v => !v)}
              >
                <Text style={[styles.providerName, { color: theme.text }]}>✏️  New conversation</Text>
                <Text style={[styles.action, { color: theme.textDim }]}>
                  {newConvoFolder ? `📁 ${newConvoFolder}` : 'No folder'} ▾
                </Text>
              </TouchableOpacity>

              {/* Folder picker for new conversation */}
              {showNewConvoFolderPicker && (
                <View style={[styles.folderPicker, { backgroundColor: theme.surfaceAlt, borderTopColor: theme.border }]}>
                  <TouchableOpacity
                    style={styles.folderPickerRow}
                    onPress={() => { setNewConvoFolder(undefined); setShowNewConvoFolderPicker(false); newConversation(undefined); onClose(); }}
                  >
                    <Text style={[styles.folderPickerLabel, { color: theme.text }]}>No folder</Text>
                    {!newConvoFolder && <Text style={{ color: MODE_ACCENTS.mentor }}>✓</Text>}
                  </TouchableOpacity>
                  {folders.map(f => (
                    <TouchableOpacity
                      key={f}
                      style={[styles.folderPickerRow, { borderTopColor: theme.border, borderTopWidth: StyleSheet.hairlineWidth }]}
                      onPress={() => { setNewConvoFolder(f); setShowNewConvoFolderPicker(false); newConversation(f); onClose(); }}
                    >
                      <Text style={[styles.folderPickerLabel, { color: theme.text }]}>📁 {f}</Text>
                      {newConvoFolder === f && <Text style={{ color: MODE_ACCENTS.mentor }}>✓</Text>}
                    </TouchableOpacity>
                  ))}
                </View>
              )}

              {/* New folder */}
              <View style={[styles.divider, { backgroundColor: theme.border }]} />
              <TouchableOpacity
                style={styles.providerRow}
                activeOpacity={0.7}
                onPress={() => setShowNewFolder(v => !v)}
              >
                <Text style={[styles.providerName, { color: theme.text }]}>📁  New folder</Text>
                <Text style={[styles.action, { color: theme.textDim }]}>{showNewFolder ? '↑' : '+'}</Text>
              </TouchableOpacity>
              {showNewFolder && (
                <View style={[styles.keyPanel, { borderTopColor: theme.border }]}>
                  <TextInput
                    style={[styles.keyInput, { color: theme.text, borderColor: theme.border, backgroundColor: theme.inputBg }]}
                    value={newFolderName}
                    onChangeText={setNewFolderName}
                    placeholder="Folder name…"
                    placeholderTextColor={theme.textFaint}
                    autoFocus
                    returnKeyType="done"
                    onSubmitEditing={() => {
                      const name = newFolderName.trim().toLowerCase().replace(/\s+/g, '-');
                      if (name) {
                        // Folder is created implicitly when a conversation is moved/created into it
                        setNewConvoFolder(name);
                        newConversation(name);
                        setNewFolderName('');
                        setShowNewFolder(false);
                        setExpandedFolders(prev => new Set([...prev, name]));
                        onClose();
                      }
                    }}
                  />
                  <View style={styles.keyActions}>
                    <TouchableOpacity
                      onPress={() => {
                        const name = newFolderName.trim().toLowerCase().replace(/\s+/g, '-');
                        if (name) {
                          setNewConvoFolder(name);
                          newConversation(name);
                          setNewFolderName('');
                          setShowNewFolder(false);
                          setExpandedFolders(prev => new Set([...prev, name]));
                          onClose();
                        }
                      }}
                      style={[styles.saveBtn, { opacity: newFolderName.trim() ? 1 : 0.4 }]}
                      disabled={!newFolderName.trim()}
                    >
                      <Text style={styles.saveBtnLabel}>Create + open</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              )}

              {/* Folder tree */}
              {conversations.length > 0 && (
                <>
                  <View style={[styles.divider, { backgroundColor: theme.border }]} />

                  {/* Folders */}
                  {folders.map(folder => {
                    const isOpen = expandedFolders.has(folder);
                    const folderConvos = byFolder(folder);
                    return (
                      <View key={folder}>
                        <TouchableOpacity
                          style={[styles.folderRow, { borderTopColor: theme.border }]}
                          onPress={() => toggleFolder(folder)}
                          activeOpacity={0.7}
                        >
                          <Text style={[styles.folderRowLabel, { color: theme.text }]}>
                            {isOpen ? '▾' : '▸'} 📁 {folder}
                          </Text>
                          <Text style={[styles.folderRowCount, { color: theme.textFaint }]}>
                            {folderConvos.length}
                          </Text>
                        </TouchableOpacity>
                        {isOpen && folderConvos.map(c => renderConvo(c))}
                      </View>
                    );
                  })}

                  {/* Unfiled */}
                  {unfiled.length > 0 && (
                    <View>
                      {folders.length > 0 && (
                        <View style={[styles.folderRow, { borderTopColor: theme.border }]}>
                          <Text style={[styles.folderRowLabel, { color: theme.textDim }]}>Unfiled</Text>
                          <Text style={[styles.folderRowCount, { color: theme.textFaint }]}>{unfiled.length}</Text>
                        </View>
                      )}
                      {unfiled.map(c => renderConvo(c))}
                    </View>
                  )}
                </>
              )}

              {/* Clear all */}
              <View style={[styles.divider, { backgroundColor: theme.border }]} />
              <TouchableOpacity
                style={styles.providerRow}
                activeOpacity={0.7}
                onPress={() => { clearAllHistory(); onClose(); }}
              >
                <Text style={[styles.providerName, { color: DANGER }]}>🗑  Clear all history</Text>
              </TouchableOpacity>
            </View>
            </>)}

            {/* ── PROVIDERS ─────────────────────────────────────────── */}
            {(!section || section === 'model') && (<>
            <Text style={[styles.sectionLabel, { color: theme.textDim }]}>PROVIDERS</Text>
            <View style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}>
              {FEATURED.map(({ id, label, oauth }, i) => {
                const info = providers[id];
                const configured = info?.authStatus?.configured ?? false;
                const isExpanded = keyInputProvider === id;
                const isOAuthActive = oauthProvider === id;

                return (
                  <View key={id}>
                    {i > 0 && <View style={[styles.divider, { backgroundColor: theme.border }]} />}

                    <TouchableOpacity
                      style={styles.providerRow}
                      activeOpacity={0.7}
                      onPress={() => {
                        if (oauth) {
                          if (isOAuthActive) { cancelOAuth(); return; }
                          startOAuth(id);
                        } else {
                          setKeyInputProvider(isExpanded ? null : id);
                          setKeyInputValue('');
                        }
                      }}
                    >
                      <View style={styles.providerLeft}>
                        <View style={[styles.dot, { backgroundColor: configured ? '#4CAF50' : theme.border }]} />
                        <Text style={[styles.providerName, { color: theme.text }]}>{label}</Text>
                        {configured && (
                          <Text style={[styles.badge, { color: theme.textFaint }]}>
                            {info.authStatus.source ?? '✓'}
                          </Text>
                        )}
                      </View>
                      {oauth && isOAuthActive
                        ? <ActivityIndicator size="small" />
                        : <Text style={[styles.action, { color: theme.textDim }]}>
                            {oauth
                              ? (configured ? 'Re-login' : 'Login')
                              : (configured ? (isExpanded ? '↑' : 'Change') : 'Add key')}
                          </Text>}
                    </TouchableOpacity>

                    {/* Device-code OAuth panel */}
                    {oauth && isOAuthActive && oauthUrl && (
                      <View style={[styles.oauthPanel, { backgroundColor: theme.surfaceAlt, borderTopColor: theme.border }]}>
                        {oauthCode ? (
                          <>
                            <Text style={[styles.oauthInstruction, { color: theme.text }]}>
                              1. Open the URL below in any browser
                            </Text>
                            <TouchableOpacity onPress={() => Linking.openURL(oauthUrl)}>
                              <Text style={[styles.oauthLink, { color: '#42A5F5' }]}>{oauthUrl}</Text>
                            </TouchableOpacity>
                            <Text style={[styles.oauthInstruction, { color: theme.text, marginTop: 10 }]}>
                              2. Enter this code:
                            </Text>
                            <TouchableOpacity
                              onPress={async () => { Clipboard.setString(oauthCode); Alert.alert('Copied', oauthCode); }}
                              style={[styles.codeBox, { backgroundColor: theme.inputBg, borderColor: theme.border }]}
                            >
                              <Text style={[styles.codeText, { color: theme.text }]}>{oauthCode}</Text>
                              <Text style={[styles.copyHint, { color: theme.textFaint }]}>tap to copy</Text>
                            </TouchableOpacity>
                          </>
                        ) : (
                          <TouchableOpacity onPress={() => Linking.openURL(oauthUrl)}>
                            <Text style={[styles.oauthLink, { color: '#42A5F5' }]}>{oauthUrl}</Text>
                          </TouchableOpacity>
                        )}
                        {oauthPolling && (
                          <View style={styles.oauthWaiting}>
                            <ActivityIndicator size="small" />
                            <Text style={[styles.oauthWaitText, { color: theme.textFaint }]}>
                              Waiting for authorization…
                            </Text>
                          </View>
                        )}
                        <TouchableOpacity onPress={cancelOAuth} style={styles.cancelBtn}>
                          <Text style={[styles.cancelBtnLabel, { color: theme.textDim }]}>Cancel</Text>
                        </TouchableOpacity>
                      </View>
                    )}

                    {/* API key input panel */}
                    {!oauth && isExpanded && (
                      <View style={[styles.keyPanel, { backgroundColor: theme.surfaceAlt, borderTopColor: theme.border }]}>
                        <TextInput
                          style={[styles.keyInput, { color: theme.text, backgroundColor: theme.inputBg, borderColor: theme.border }]}
                          value={keyInputValue}
                          onChangeText={setKeyInputValue}
                          placeholder="Paste API key…"
                          placeholderTextColor={theme.textFaint}
                          secureTextEntry
                          autoFocus
                          autoCapitalize="none"
                          autoCorrect={false}
                        />
                        <View style={styles.keyActions}>
                          {configured && (
                            <TouchableOpacity
                              onPress={() => { removeApiKey(id); setKeyInputProvider(null); }}
                              style={styles.removeBtn}
                            >
                              <Text style={styles.removeBtnLabel}>Remove</Text>
                            </TouchableOpacity>
                          )}
                          <TouchableOpacity
                            onPress={saveApiKey}
                            style={[styles.saveBtn, { opacity: keyInputValue.trim() ? 1 : 0.4 }]}
                            disabled={!keyInputValue.trim() || keyInputSaving}
                          >
                            {keyInputSaving
                              ? <ActivityIndicator size="small" color="#fff" />
                              : <Text style={styles.saveBtnLabel}>Save</Text>}
                          </TouchableOpacity>
                        </View>
                      </View>
                    )}
                  </View>
                );
              })}
            </View>

            {/* ── LOCAL MODELS ──────────────────────────────────────── */}
            <Text style={[styles.sectionLabel, { color: theme.textDim }]}>LOCAL MODELS</Text>
            <View style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}>
              <Text style={[styles.localHint, { color: theme.textDim }]}>
                {'Add ollama, llama.cpp, lmstudio, or omlx via\n'}
                <Text style={{ color: theme.text }}>~/.pi/agent/models.json</Text>
              </Text>
              {localProviders.length > 0 && localProviders.map(([id, info]) => (
                <View key={id} style={[styles.localRow, { borderTopColor: theme.border }]}>
                  <View style={[styles.dot, { backgroundColor: info.authStatus.configured ? '#4CAF50' : theme.border }]} />
                  <Text style={[styles.providerName, { color: theme.text }]}>{id}</Text>
                  <Text style={[styles.badge, { color: theme.textFaint }]}>
                    {info.models.length} model{info.models.length !== 1 ? 's' : ''}
                  </Text>
                </View>
              ))}
            </View>

            {/* ── CHAT MODEL ────────────────────────────────────────── */}
            <Text style={[styles.sectionLabel, { color: theme.textDim }]}>CHAT MODEL</Text>
            <View style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}>
              <TouchableOpacity
                style={styles.providerRow}
                activeOpacity={0.7}
                onPress={() => setChatPickerOpen((v) => !v)}
              >
                <Text style={[styles.providerName, { color: theme.text }]}>{getModeName('mentor', modes)} & {getModeName('shapeshifter', modes)}</Text>
                <View style={styles.modelRight}>
                  <Text style={[styles.modelLabel, { color: theme.textDim }]} numberOfLines={1}>
                    {chatModel ? `${chatModel.provider} / ${chatModel.modelId}` : 'default'}
                  </Text>
                  <Text style={[styles.action, { color: theme.textDim }]}>
                    {chatPickerOpen ? '↑' : 'Change'}
                  </Text>
                </View>
              </TouchableOpacity>

              {chatPickerOpen && (
                <View style={[styles.pickerBox, { backgroundColor: theme.surfaceAlt, borderTopColor: theme.border }]}>
                  <TouchableOpacity style={styles.pickerRow} onPress={resetChatModel}>
                    <View style={styles.pickerRowLeft}>
                      <Text style={[styles.pickerName, { color: theme.text }]}>Default</Text>
                      <Text style={[styles.pickerSub, { color: theme.textFaint }]}>From server config</Text>
                    </View>
                    {!chatModel && <Text style={{ color: '#4CAF50' }}>✓</Text>}
                  </TouchableOpacity>

                  {sortedModels.map((model) => {
                    const info = providers[model.provider];
                    const available = info?.authStatus?.configured ?? false;
                    const isSelected = chatModel?.provider === model.provider && chatModel?.modelId === model.id;
                    return (
                      <TouchableOpacity
                        key={`${model.provider}/${model.id}`}
                        style={[styles.pickerRow, { borderTopColor: theme.border, opacity: available ? 1 : 0.45 }]}
                        onPress={() => available
                          ? saveChatModel(model.provider, model.id)
                          : Alert.alert('Not configured', `Set up ${model.provider} auth first`)}
                      >
                        <View style={styles.pickerRowLeft}>
                          <Text style={[styles.pickerName, { color: theme.text }]}>{model.name}</Text>
                          <Text style={[styles.pickerSub, { color: theme.textFaint }]}>
                            {model.provider} · {Math.round(model.contextWindow / 1000)}k ctx
                            {!available ? ' · not configured' : ''}
                          </Text>
                        </View>
                        {isSelected && <Text style={{ color: '#4CAF50' }}>✓</Text>}
                      </TouchableOpacity>
                    );
                  })}
                </View>
              )}
            </View>
            </>)}

            {/* ── SERVER ───────────────────────────────────────────── */}
            {!section && (<>
            <Text style={[styles.sectionLabel, { color: theme.textDim }]}>SERVER</Text>
            <View style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}>
              <View style={styles.providerRow}>
                <Text style={[styles.providerName, { color: theme.textDim }]} numberOfLines={1}>
                  {useStore.getState().serverUrl?.replace(/^wss?:\/\//i, '') ?? '—'}
                </Text>
              </View>
              <View style={[styles.divider, { backgroundColor: theme.border }]} />
              <TouchableOpacity
                style={styles.providerRow}
                activeOpacity={0.7}
                onPress={() => {
                  Alert.alert(
                    'Change server',
                    'This will disconnect and take you back to the setup screen.',
                    [
                      { text: 'Cancel', style: 'cancel' },
                      {
                        text: 'Disconnect',
                        style: 'destructive',
                        onPress: async () => {
                          wsService.disconnect();
                          await deleteItem('serverUrl');
                          await deleteItem('token');
                          useStore.getState().setCredentials('', '');
                          onClose();
                          router.replace('/setup');
                        },
                      },
                    ],
                  );
                }}
              >
                <Text style={[styles.providerName, { color: DANGER }]}>Change server…</Text>
              </TouchableOpacity>
            </View>
            </>)}

            <View style={{ height: 40 }} />
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { fontFamily: 'DMSans_700Bold', fontSize: 17 },
  closeBtn: { padding: 4 },
  closeBtnLabel: { fontFamily: 'DMSans_500Medium', fontSize: 16 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  errorText: { fontFamily: 'DMSans_400Regular', fontSize: 14 },
  scroll: { paddingHorizontal: 16, paddingTop: 20 },
  sectionLabel: { fontFamily: 'DMSans_700Bold', fontSize: 11, letterSpacing: 0.8, marginBottom: 6, marginTop: 20 },
  card: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: 16 },
  providerRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 14,
  },
  providerLeft: { flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  providerName: { fontFamily: 'DMSans_500Medium', fontSize: 15 },
  badge: { fontFamily: 'DMSans_400Regular', fontSize: 12 },
  action: { fontFamily: 'DMSans_400Regular', fontSize: 14 },
  // OAuth panel
  oauthPanel: {
    paddingHorizontal: 16, paddingVertical: 14, gap: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  oauthInstruction: { fontFamily: 'DMSans_500Medium', fontSize: 13 },
  oauthLink: { fontFamily: 'DMSans_400Regular', fontSize: 13, textDecorationLine: 'underline' },
  codeBox: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    borderWidth: StyleSheet.hairlineWidth, borderRadius: 8,
    paddingHorizontal: 14, paddingVertical: 10, marginTop: 4,
  },
  codeText: { fontFamily: 'DMSans_700Bold', fontSize: 20, letterSpacing: 3 },
  copyHint: { fontFamily: 'DMSans_400Regular', fontSize: 11 },
  oauthWaiting: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },
  oauthWaitText: { fontFamily: 'DMSans_400Regular', fontSize: 13 },
  cancelBtn: { alignSelf: 'flex-end', marginTop: 6, paddingVertical: 4, paddingHorizontal: 2 },
  cancelBtnLabel: { fontFamily: 'DMSans_400Regular', fontSize: 13 },
  // API key panel
  keyPanel: { paddingHorizontal: 16, paddingBottom: 14, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth },
  keyInput: {
    borderWidth: StyleSheet.hairlineWidth, borderRadius: 8,
    paddingHorizontal: 12, paddingVertical: 10,
    fontFamily: 'DMSans_400Regular', fontSize: 14, marginBottom: 10,
  },
  keyActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10 },
  removeBtn: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8, backgroundColor: DANGER + '22' },
  removeBtnLabel: { fontFamily: 'DMSans_500Medium', fontSize: 14, color: DANGER },
  saveBtn: { paddingHorizontal: 18, paddingVertical: 8, borderRadius: 8, backgroundColor: '#4CAF50' },
  saveBtnLabel: { fontFamily: 'DMSans_700Bold', fontSize: 14, color: '#fff' },
  // Local models
  localHint: { fontFamily: 'DMSans_400Regular', fontSize: 13, padding: 16, lineHeight: 20 },
  localRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 16, paddingVertical: 12, borderTopWidth: StyleSheet.hairlineWidth,
  },
  // Model picker
  modelRight: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
  modelLabel: { fontFamily: 'DMSans_400Regular', fontSize: 13, flexShrink: 1 },
  pickerBox: { borderTopWidth: StyleSheet.hairlineWidth },
  pickerRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 12, borderTopWidth: StyleSheet.hairlineWidth,
  },
  pickerRowLeft: { flex: 1 },
  pickerName: { fontFamily: 'DMSans_500Medium', fontSize: 14 },
  pickerSub: { fontFamily: 'DMSans_400Regular', fontSize: 12, marginTop: 2 },
  // Conversations
  convoSectionTitle: {
    fontFamily: 'DMSans_500Medium',
    fontSize: 12,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 4,
  },
  convoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 16,
    paddingRight: 4,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  convoRowMain: {
    flex: 1,
    marginRight: 4,
  },
  convoActions: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  convoActionBtn: {
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  convoActionLabel: {
    fontSize: 16,
  },
  convoRenameInput: {
    fontFamily: 'DMSans_400Regular',
    fontSize: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    marginTop: 2,
  },
  convoRowHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 2,
  },
  convoBadge: {
    fontFamily: 'DMSans_500Medium',
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  convoDate: {
    fontFamily: 'DMSans_400Regular',
    fontSize: 11,
    marginBottom: 2,
  },
  convoTitle: {
    fontFamily: 'DMSans_400Regular',
    fontSize: 14,
  },
  // Folder tree
  folderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  folderRowLabel: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 14,
    flex: 1,
  },
  folderRowCount: {
    fontFamily: 'DMSans_400Regular',
    fontSize: 12,
  },
  folderPicker: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingVertical: 4,
  },
  folderPickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  folderPickerLabel: {
    fontFamily: 'DMSans_400Regular',
    fontSize: 14,
  },
});
