import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, Modal,
  TextInput, ScrollView, RefreshControl, ActivityIndicator,
  KeyboardAvoidingView, Platform, PanResponder, BackHandler, Keyboard, Alert,
} from 'react-native';
import Markdown from 'react-native-markdown-display';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useTheme } from '../../lib/theme';
import { apiFetch } from '../../lib/api';
import { useStore, MODE_ACCENTS, MODE_EMOJIS, MODE_NAMES, getModeName, getModeEmoji } from '../../lib/store';
import SettingsModal from '../../components/SettingsModal';
import GraphView from '../../components/GraphView';
import RawCards from '../../components/RawCards';

const BUZZ_ACCENT = MODE_ACCENTS.keeper;

type TopFolder = 'raw' | 'wiki' | 'journal' | 'projects';
const TOP_FOLDERS: TopFolder[] = ['projects', 'raw', 'wiki', 'journal'];

interface TreeEntry { name: string; path: string; size: number; mtime: string; isDir: boolean; }
interface FileDetail { path: string; content: string; mtime: string; }
interface MocEntry {
  id: string;
  name: string;
  path: string;
  exists: boolean;
  pageCount: number;
  preview: string;
  lastUpdated: string;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  } catch { return iso; }
}

function buildMarkdownStyles(theme: import('../../lib/theme').Theme) {
  const mono = Platform.OS === 'ios' ? 'Menlo' : 'monospace';
  return {
    body:        { color: theme.text, fontFamily: 'DMSans_400Regular', fontSize: 15, lineHeight: 26 },
    paragraph:   { marginTop: 0, marginBottom: 14 },
    heading1:    { fontFamily: 'DMSans_700Bold', fontSize: 26, lineHeight: 34, marginTop: 24, marginBottom: 10, color: theme.text },
    heading2:    { fontFamily: 'DMSans_700Bold', fontSize: 21, lineHeight: 28, marginTop: 20, marginBottom: 8,  color: theme.text },
    heading3:    { fontFamily: 'DMSans_700Bold', fontSize: 17, lineHeight: 24, marginTop: 16, marginBottom: 6,  color: theme.text },
    heading4:    { fontFamily: 'DMSans_700Bold', fontSize: 15, lineHeight: 22, marginTop: 12, marginBottom: 4,  color: theme.textDim },
    heading5:    { fontFamily: 'DMSans_500Medium', fontSize: 14, lineHeight: 20, marginTop: 10, marginBottom: 4, color: theme.textDim },
    heading6:    { fontFamily: 'DMSans_500Medium', fontSize: 13, lineHeight: 18, marginTop: 8,  marginBottom: 4, color: theme.textFaint },
    strong:      { fontFamily: 'DMSans_700Bold' },
    em:          { fontFamily: 'Lora_400Regular_Italic' },
    hr:          { backgroundColor: theme.border, height: 1, marginVertical: 20 },
    blockquote:  { backgroundColor: theme.surface, borderLeftColor: BUZZ_ACCENT, borderLeftWidth: 3, paddingHorizontal: 14, paddingVertical: 2, marginVertical: 8, borderRadius: 4 },
    code_inline: { fontFamily: mono, fontSize: 13, backgroundColor: theme.surfaceAlt, color: BUZZ_ACCENT, paddingHorizontal: 5, paddingVertical: 2, borderRadius: 4 },
    fence:       { fontFamily: mono, fontSize: 13, backgroundColor: theme.surface, color: theme.text, padding: 14, borderRadius: 8, marginVertical: 10 },
    code_block:  { fontFamily: mono, fontSize: 13, backgroundColor: theme.surface, color: theme.text, padding: 14, borderRadius: 8, marginVertical: 10 },
    bullet_list: { marginVertical: 6 },
    ordered_list:{ marginVertical: 6 },
    list_item:   { marginVertical: 3 },
    link:        { color: BUZZ_ACCENT, textDecorationLine: 'underline' as const },
    table:       { borderWidth: StyleSheet.hairlineWidth, borderColor: theme.border, borderRadius: 6, marginVertical: 10, overflow: 'hidden' as const },
    thead:       { backgroundColor: theme.surface },
    th:          { fontFamily: 'DMSans_700Bold', fontSize: 13, padding: 10, color: theme.text, borderRightWidth: StyleSheet.hairlineWidth, borderColor: theme.border },
    td:          { fontFamily: 'DMSans_400Regular', fontSize: 13, padding: 10, color: theme.text, borderRightWidth: StyleSheet.hairlineWidth, borderColor: theme.border },
    tr:          { borderBottomWidth: StyleSheet.hairlineWidth, borderColor: theme.border },
  };
}

function resolveWikiLinks(content: string): string {
  // [[wiki/path/slug|Title]] → [Title](wiki/path/slug)
  return content
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '[$2]($1)')
    .replace(/\[\[([^\]]+)\]\]/g, (_, ref) => {
      const label = ref.split('/').pop()?.replace(/\.md$/, '') ?? ref;
      return `[${label}](${ref})`;
    });
}

export default function WikiScreen() {
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const isDark = useStore((s) => s.isDark);
  const toggleTheme = useStore((s) => s.toggleTheme);
  const serverUrl = useStore((s) => s.serverUrl);
  const token = useStore((s) => s.token);
  const modes = useStore((s) => s.modes);
  const [hiveMode, setHiveMode] = useState(false);
  const [topFolder, setTopFolder] = useState<TopFolder>(TOP_FOLDERS[0]);
  const [pathStack, setPathStack] = useState<string[]>([TOP_FOLDERS[0]]);
  const currentPath = pathStack[pathStack.length - 1];
  const isSubfolder = pathStack.length > 1;
  const [entries, setEntries] = useState<TreeEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [fileModalVisible, setFileModalVisible] = useState(false);
  const [fileDetail, setFileDetail] = useState<FileDetail | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [ingestModalVisible, setIngestModalVisible] = useState(false);
  const [ingestText, setIngestText] = useState('');
  const [ingestSaving, setIngestSaving] = useState(false);
  const [ingestError, setIngestError] = useState<string | null>(null);
  const [captureProcessNow, setCaptureProcessNow] = useState(false);

  const [linting, setLinting] = useState(false);
  const [ingestRawRunning, setIngestRawRunning] = useState(false);
  const [toolsMsg, setToolsMsg] = useState<string | null>(null);
  const [rawPending, setRawPending] = useState<Set<string>>(new Set());
  const [rawPendingCount, setRawPendingCount] = useState(0);
  const [ingestingFile, setIngestingFile] = useState(false);
  const [ingestProgress, setIngestProgress] = useState<{ done: number; total: number; file: string } | null>(null);

  const [askModalVisible, setAskModalVisible] = useState(false);
  const [askQuestion, setAskQuestion] = useState('');
  const [askLoading, setAskLoading] = useState(false);
  const [askResults, setAskResults] = useState<{ path: string; heading: string; text: string }[]>([]);
  const [askError, setAskError] = useState<string | null>(null);
  const [askSearched, setAskSearched] = useState(false);

  const [chatKeyboardHeight, setChatKeyboardHeight] = useState(0);

  const [dupesModalVisible, setDupesModalVisible] = useState(false);
  const [dupesLoading, setDupesLoading] = useState(false);
  const [dupes, setDupes] = useState<{ fileA: string; fileB: string; similarity: number }[]>([]);
  const [dupesError, setDupesError] = useState<string | null>(null);

  // Overflow action sheet (Index / Compile / Dupes)
  const [toolsSheetVisible, setToolsSheetVisible] = useState(false);

  const [settingsVisible, setSettingsVisible] = useState(false);
  const [settingsSection, setSettingsSection] = useState<'model' | 'history' | undefined>(undefined);

  // Projects
  const [projectsData, setProjectsData] = useState<{ slug: string; name: string; preview: string; lastUpdated: string; fileCount: number }[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);

  // Journal
  const [journalData, setJournalData] = useState<{ date: string; path: string; preview: string; mtime: string }[]>([]);
  const [journalLoading, setJournalLoading] = useState(false);

  // MOCs
  const [mocData, setMocData] = useState<MocEntry[]>([]);
  const [mocsLoading, setMocsLoading] = useState(false);

  // Ask upgrades
  const [askAnswer, setAskAnswer] = useState<string | null>(null);
  const [askFilter, setAskFilter] = useState<'all' | 'wiki' | 'projects' | 'journal'>('all');
  const [askSourcesExpanded, setAskSourcesExpanded] = useState(false);

  // Ingest result
  const [ingestResult, setIngestResult] = useState<{ todos_added: number; pages_created: string[]; pages_updated: string[]; project_flag: string | null; failSaved?: boolean } | null>(null);

  // Ask: save to wiki
  const [askSaved, setAskSaved] = useState(false);

  const fetchProjects = useCallback(async () => {
    setProjectsLoading(true);
    try {
      const r = await apiFetch('/wiki/projects');
      const d = await r.json() as { ok: boolean; projects: { slug: string; name: string; preview: string; lastUpdated: string; fileCount: number }[] };
      setProjectsData(d.projects ?? []);
    } catch {} finally { setProjectsLoading(false); }
  }, []);

  const fetchJournal = useCallback(async () => {
    setJournalLoading(true);
    try {
      const r = await apiFetch('/wiki/journal');
      const d = await r.json() as { ok: boolean; entries: { date: string; path: string; preview: string; mtime: string }[] };
      setJournalData(d.entries ?? []);
    } catch {} finally { setJournalLoading(false); }
  }, []);

  const fetchMocs = useCallback(async () => {
    setMocsLoading(true);
    try {
      const r = await apiFetch('/wiki/mocs');
      const d = await r.json() as { ok: boolean; mocs: MocEntry[] };
      setMocData(d.mocs ?? []);
    } catch {} finally { setMocsLoading(false); }
  }, []);

  const fetchRawStatus = useCallback(async () => {
    try {
      const res = await apiFetch('/wiki/raw-status');
      const data = await res.json() as { pending?: string[]; total?: number };
      setRawPending(new Set(data.pending ?? []));
      setRawPendingCount(data.pending?.length ?? 0);
    } catch { /* non-fatal */ }
  }, []);

  const switchTopFolder = useCallback((f: TopFolder) => {
    setTopFolder(f);
    setPathStack([f]);
    if (f === 'projects') fetchProjects();
    if (f === 'journal') fetchJournal();
    if (f === 'wiki') fetchMocs();
    if (f === 'raw') fetchRawStatus();
  }, [fetchProjects, fetchJournal, fetchMocs, fetchRawStatus]);

  // Refs so the PanResponder closure always sees the current state
  const topFolderRef = useRef(topFolder);
  useEffect(() => { topFolderRef.current = topFolder; }, [topFolder]);

  const pathStackRef = useRef(pathStack);
  useEffect(() => { pathStackRef.current = pathStack; }, [pathStack]);

  const hiveModeRef = useRef(hiveMode);
  useEffect(() => { hiveModeRef.current = hiveMode; }, [hiveMode]);

  const swipe = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) =>
        !hiveModeRef.current && Math.abs(g.dx) > 12 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
      onPanResponderRelease: (_, g) => {
        if (Math.abs(g.dx) < 40) return;
        const cur = topFolderRef.current;
        const stack = pathStackRef.current;
        // Don't swipe-switch folders while inside a subfolder; user should use Back.
        if (stack.length > 1) return;

        const idx = TOP_FOLDERS.indexOf(cur);
        if (idx === -1) return;

        if (g.dx < 0) {
          // swipe left → next folder (Hive is rightmost, no spill)
          if (idx < TOP_FOLDERS.length - 1) {
            const next = TOP_FOLDERS[idx + 1];
            setTopFolder(next);
            setPathStack([next]);
          }
        } else {
          // swipe right → prev folder or spill to Ruse
          if (idx > 0) {
            const next = TOP_FOLDERS[idx - 1];
            setTopFolder(next);
            setPathStack([next]);
          } else {
            router.replace('/(tabs)/shapeshifter');
          }
        }
      },
    })
  ).current;

  const fetchTree = useCallback(async (isRefresh = false, overridePath?: string) => {
    if (isRefresh) setRefreshing(true);
    else { setLoading(true); setError(null); }
    try {
      const isRaw = (overridePath ?? currentPath).split('/')[0] === 'raw';
      const res = await apiFetch(`/wiki/tree?path=${encodeURIComponent(overridePath ?? currentPath)}${isRaw ? '&preview=1' : ''}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `Server error ${res.status}`);
      }
      const data = await res.json() as { entries: TreeEntry[] };
      setEntries(data.entries ?? []);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [currentPath]);

  useEffect(() => {
    if (topFolder === 'projects' && !isSubfolder) {
      fetchProjects();
    } else if (topFolder === 'journal' && !isSubfolder) {
      fetchJournal();
    } else if (topFolder === 'wiki' && !isSubfolder) {
      fetchMocs();
    } else {
      fetchTree();
    }
    fetchRawStatus();
  }, [fetchTree, fetchProjects, fetchJournal, fetchMocs, fetchRawStatus, topFolder, isSubfolder]);

  useEffect(() => {
    const id = setInterval(() => { fetchRawStatus(); }, 30000);
    return () => clearInterval(id);
  }, [fetchRawStatus]);

  useEffect(() => {
    const show = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
      (e) => setChatKeyboardHeight(e.endCoordinates.height),
    );
    const hide = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
      () => setChatKeyboardHeight(0),
    );
    return () => { show.remove(); hide.remove(); };
  }, []);

  // Android back button: navigate up folder stack / close modals before leaving screen
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (toolsSheetVisible) { setToolsSheetVisible(false); return true; }
      if (fileModalVisible) { setFileModalVisible(false); return true; }
      if (ingestModalVisible) { setIngestModalVisible(false); return true; }
      if (askModalVisible) { setAskModalVisible(false); return true; }
      if (dupesModalVisible) { setDupesModalVisible(false); return true; }
      if (pathStack.length > 1) { setPathStack((p) => p.slice(0, -1)); return true; }
      return false;
    });
    return () => sub.remove();
  }, [pathStack, fileModalVisible, ingestModalVisible, askModalVisible, dupesModalVisible, toolsSheetVisible]);

  const openFile = useCallback(async (entry: TreeEntry) => {
    if (entry.isDir) {
      setPathStack((prev) => [...prev, entry.path]);
      return;
    }
    setFileModalVisible(true);
    setFileDetail(null);
    setFileLoading(true);
    setEditMode(false);
    setSaveError(null);
    try {
      const res = await apiFetch(`/wiki/file?path=${encodeURIComponent(entry.path)}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `Server error ${res.status}`);
      }
      const data = await res.json() as FileDetail;
      setFileDetail(data);
      setEditContent(data.content);
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : 'Failed to load file');
    } finally {
      setFileLoading(false);
    }
  }, []);

  const saveFile = useCallback(async () => {
    if (!fileDetail) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await apiFetch('/wiki/file', {
        method: 'POST',
        body: JSON.stringify({ path: fileDetail.path, content: editContent }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `Server error ${res.status}`);
      }
      setFileDetail({ ...fileDetail, content: editContent });
      setEditMode(false);
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }, [fileDetail, editContent]);

  const closeFileModal = useCallback(() => {
    setFileModalVisible(false);
    setEditMode(false);
    setSaveError(null);
  }, []);

  const ingestFileFromRaw = useCallback(async () => {
    if (!fileDetail) return;
    setIngestingFile(true);
    try {
      const res = await apiFetch('/wiki/ingest', {
        method: 'POST',
        body: JSON.stringify({ text: fileDetail.content, existingRawPath: fileDetail.path }),
      });
      const data = await res.json() as { ok?: boolean; todos_added?: number; pages_created?: string[]; pages_updated?: string[]; project_flag?: string | null; failSaved?: boolean; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Failed');
      setFileModalVisible(false);
      setIngestResult({
        todos_added: data.todos_added ?? 0,
        pages_created: data.pages_created ?? [],
        pages_updated: data.pages_updated ?? [],
        project_flag: data.project_flag ?? null,
        failSaved: data.failSaved,
      });
      fetchRawStatus();
      if (topFolder === 'wiki') fetchTree(false, 'wiki');
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Ingest failed');
    } finally {
      setIngestingFile(false);
    }
  }, [fileDetail, fetchTree, topFolder, fetchRawStatus]);

  const deleteFile = useCallback(() => {
    if (!fileDetail) return;
    Alert.alert(
      'Delete file?',
      fileDetail.path,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              const res = await apiFetch(`/wiki/file?path=${encodeURIComponent(fileDetail.path)}`, { method: 'DELETE' });
              if (!res.ok) {
                const body = await res.json().catch(() => ({})) as { error?: string };
                throw new Error(body.error ?? `Server error ${res.status}`);
              }
              closeFileModal();
              if (fileDetail.path.startsWith('raw/')) fetchRawStatus();
              if (fileDetail.path.startsWith('wiki/')) fetchTree(false, 'wiki');
              if (fileDetail.path.startsWith('journal/')) fetchTree(false, 'journal');
            } catch (err) {
              Alert.alert('Error', err instanceof Error ? err.message : 'Failed to delete');
            }
          },
        },
      ]
    );
  }, [fileDetail, closeFileModal, fetchRawStatus, fetchTree]);

  const flashToolsMsg = useCallback((msg: string) => {
    setToolsMsg(msg);
    setTimeout(() => setToolsMsg(null), 3000);
  }, []);

  const submitCapture = useCallback(async () => {
    if (!ingestText.trim()) return;
    setIngestSaving(true);
    setIngestError(null);
    try {
      if (captureProcessNow) {
        // Full ingest: save to raw + LLM → wiki
        const res = await apiFetch('/wiki/ingest', {
          method: 'POST',
          body: JSON.stringify({ text: ingestText }),
        });
        const data = await res.json() as {
          ok?: boolean; todos_added?: number; pages_created?: string[];
          pages_updated?: string[]; project_flag?: string | null; failSaved?: boolean; error?: string;
        };
        if (!res.ok) throw new Error(data.error ?? 'Failed to process');
        setIngestText('');
        setCaptureProcessNow(false);
        setIngestModalVisible(false);
        setIngestResult({
          todos_added: data.todos_added ?? 0,
          pages_created: data.pages_created ?? [],
          pages_updated: data.pages_updated ?? [],
          project_flag: data.project_flag ?? null,
          failSaved: data.failSaved,
        });
        if (topFolder === 'wiki') fetchTree(false, 'wiki');
        fetchRawStatus();
      } else {
        // Dump only: fast save to raw/, no LLM
        const res = await apiFetch('/wiki/dump', {
          method: 'POST',
          body: JSON.stringify({ text: ingestText }),
        });
        const data = await res.json() as { ok?: boolean; error?: string; path?: string };
        if (!res.ok) throw new Error(data.error ?? 'Failed to save');
        setIngestText('');
        setCaptureProcessNow(false);
        setIngestModalVisible(false);
        flashToolsMsg(`Saved to raw/${data.path?.split('/').pop() ?? '…'}`);
        if (topFolder === 'raw') fetchTree(false, 'raw');
        fetchRawStatus();
      }
    } catch (err: unknown) {
      setIngestError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setIngestSaving(false);
    }
  }, [ingestText, captureProcessNow, fetchTree, topFolder, fetchRawStatus, flashToolsMsg]);

  const closeIngestModal = useCallback(() => {
    setIngestModalVisible(false);
    setIngestText('');
    setIngestError(null);
    setCaptureProcessNow(false);
  }, []);

  const runLint = useCallback(async () => {
    setLinting(true);
    try {
      const res = await apiFetch('/wiki/lint', { method: 'POST' });
      const data = await res.json() as { ok?: boolean; message?: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Lint failed');
      flashToolsMsg('Lint pass running… check .vault-health.md when done');
    } catch (err) {
      flashToolsMsg(err instanceof Error ? err.message : 'Lint failed');
    } finally {
      setLinting(false);
    }
  }, [flashToolsMsg]);

  const runAsk = useCallback(async () => {
    const q = askQuestion.trim();
    if (!q) return;
    setAskLoading(true);
    setAskError(null);
    setAskResults([]);
    setAskAnswer(null);
    setAskSearched(false);
    setAskSourcesExpanded(false);
    const filterMap: Record<string, string[]> = {
      wiki: ['wiki'],
      projects: ['projects'],
      journal: ['journal'],
      all: [],
    };
    try {
      const r = await apiFetch('/knowledge/ask', {
        method: 'POST',
        body: JSON.stringify({ question: q, topK: 6, filter: filterMap[askFilter] }),
      });
      const d = await r.json() as {
        ok: boolean;
        answer: string | null;
        sources: { path: string; heading: string; text: string }[];
        error?: string;
      };
      if (!r.ok || !d.ok) throw new Error(d.error ?? 'Ask failed');
      setAskAnswer(d.answer ?? null);
      setAskResults(d.sources ?? []);
      setAskSearched(true);
    } catch (err: unknown) {
      setAskError(err instanceof Error ? err.message : 'Could not query knowledge base. Try running Reindex.');
    } finally {
      setAskLoading(false);
    }
  }, [askQuestion, askFilter]);

  const runDupes = useCallback(async () => {
    setDupesLoading(true);
    setDupes([]);
    setDupesError(null);
    setDupesModalVisible(true);
    try {
      const r = await apiFetch('/knowledge/dupes');
      const d = await r.json() as { ok: boolean; dupes: { fileA: string; fileB: string; similarity: number }[]; error?: string };
      if (!r.ok || !d.ok) throw new Error(d.error ?? 'Dupe check failed');
      setDupes(d.dupes ?? []);
    } catch (err) {
      setDupesError(err instanceof Error ? err.message : 'Failed to check duplicates');
    } finally {
      setDupesLoading(false);
    }
  }, []);


  const runIngestRaw = useCallback(async () => {
    setIngestRawRunning(true);
    setIngestProgress(null);
    setToolsMsg(null);
    try {
      const res = await apiFetch('/wiki/ingest-raw?stream=1', { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `Server error ${res.status}`);
      }
      const reader = res.body?.getReader();
      if (!reader) throw new Error('No response body');
      const decoder = new TextDecoder();
      let buffer = '';
      let finalData: { processed?: string[]; skipped?: string[]; errors?: string[] } | null = null;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line.startsWith('progress:')) {
            try {
              const p = JSON.parse(line.slice('progress:'.length)) as { done: number; total: number; file: string };
              setIngestProgress(p);
            } catch {}
          } else if (line.startsWith('done:')) {
            try {
              finalData = JSON.parse(line.slice('done:'.length));
            } catch {}
          }
        }
      }
      setIngestProgress(null);
      if (finalData) {
        const msg = `Ingest raw: ${finalData.processed?.length ?? 0} processed, ${finalData.skipped?.length ?? 0} skipped${finalData.errors?.length ? `, ${finalData.errors.length} errors` : ''}`;
        setToolsMsg(msg);
        if ((finalData.processed?.length ?? 0) > 0 && topFolder === 'wiki') fetchTree(false, 'wiki');
      }
    } catch (err) {
      setIngestProgress(null);
      setToolsMsg(err instanceof Error ? err.message : 'Ingest raw failed');
    } finally {
      setIngestRawRunning(false);
    }
  }, [topFolder, fetchTree]);

  const renderEntry = ({ item }: { item: TreeEntry }) => {
    const isPendingRaw = topFolder === 'raw' && !item.isDir && rawPending.has(item.path);
    return (
      <TouchableOpacity
        style={[styles.row, { backgroundColor: theme.surface, borderBottomColor: theme.border }]}
        onPress={() => openFile(item)}
        activeOpacity={0.7}
      >
        <Text style={[styles.rowIcon, { color: theme.textDim }]}>{item.isDir ? '📁' : '📄'}</Text>
        <View style={styles.rowBody}>
          <Text style={[styles.rowName, { color: theme.text }]} numberOfLines={1}>{item.name}</Text>
          <Text style={[styles.rowMeta, { color: theme.textDim }]}>{formatDate(item.mtime)}</Text>
        </View>
        {isPendingRaw ? (
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: BUZZ_ACCENT, marginRight: 12 }} />
        ) : null}
      </TouchableOpacity>
    );
  };

  const toolsBusy = dupesLoading || linting;

  return (
    <View style={[styles.root, { paddingTop: insets.top, backgroundColor: theme.bg }]} {...swipe.panHandlers}>

      {/* Persona identity header */}
      <View style={[styles.personaHeader, { borderBottomColor: theme.border }]}>
        <TouchableOpacity
          onLongPress={() => { setSettingsSection('model'); setSettingsVisible(true); }}
          activeOpacity={0.7}
        >
          <Text style={[styles.personaTitle, { color: BUZZ_ACCENT }]}>
            {MODE_EMOJIS.keeper} {MODE_NAMES.keeper}
          </Text>
        </TouchableOpacity>
        <View style={styles.personaHeaderControls}>
          <TouchableOpacity onPress={() => setHiveMode((v) => !v)} style={styles.personaHeaderBtn} activeOpacity={0.7}>
            <Text style={styles.personaHeaderBtnLabel}>{hiveMode ? '📁' : '🕸️'}</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={toggleTheme} style={styles.personaHeaderBtn} activeOpacity={0.7}>
            <Text style={styles.personaHeaderBtnLabel}>{isDark ? '🌙' : '☀️'}</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Tab strip + single overflow button */}
      <View style={[styles.headerRow, { backgroundColor: theme.surface, borderBottomColor: theme.border }]}>
        {isSubfolder ? (
          <TouchableOpacity style={styles.backBtn} onPress={() => setPathStack((p) => p.slice(0, -1))}>
            <Text style={[styles.backBtnLabel, { color: theme.text }]}>‹ Back</Text>
          </TouchableOpacity>
        ) : (
          <View style={styles.tabs}>
            {TOP_FOLDERS.map((f) => (
              <TouchableOpacity
                key={f}
                style={[styles.tab, topFolder === f && { borderBottomColor: theme.text, borderBottomWidth: 2 }]}
                onPress={() => switchTopFolder(f)}
                activeOpacity={0.7}
              >
                <Text style={[styles.tabLabel, { color: topFolder === f ? theme.text : theme.textDim }]}>
                  {f.charAt(0).toUpperCase() + f.slice(1)}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        )}
        <TouchableOpacity
          style={styles.overflowBtn}
          onPress={() => setToolsSheetVisible(true)}
          activeOpacity={0.7}
          accessibilityLabel="Knowledge tools"
        >
          {toolsBusy ? (
            <ActivityIndicator size="small" color={BUZZ_ACCENT} />
          ) : (
            <Text style={[styles.overflowBtnLabel, { color: theme.textDim }]}>⋯</Text>
          )}
        </TouchableOpacity>
      </View>

      {/* Hive graph mode — replaces content area */}
      {hiveMode && serverUrl && token ? (
        <GraphView
          serverUrl={serverUrl}
          token={token}
          theme={theme}
          onOpenFile={(path) => {
            openFile({ name: path.split('/').pop() ?? path, path, size: 0, mtime: '', isDir: false });
          }}
        />
      ) : null}

      {/* Content area — tint varies per active tab */}
      <View style={[styles.contentArea, {
        display: hiveMode ? 'none' : 'flex',
        backgroundColor: isSubfolder ? BUZZ_ACCENT + '07' :
          topFolder === 'projects' ? BUZZ_ACCENT + '07' :
          topFolder === 'raw'      ? '#4CAF5007' :
          topFolder === 'wiki'     ? '#4285F407' :
          topFolder === 'journal'  ? '#9C27B007' : 'transparent',
      }]}>

      {toolsMsg ? (
        <View style={[styles.toolsMsgBar, { backgroundColor: theme.surface }]}>
          <Text style={[styles.toolsMsgText, { color: theme.textDim }]}>{toolsMsg}</Text>
        </View>
      ) : null}

      {topFolder === 'projects' && pathStack.length === 1 ? (
        projectsLoading ? (
          <View style={styles.centered}><ActivityIndicator color={theme.textDim} /></View>
        ) : (
          <FlatList
            data={projectsData}
            keyExtractor={item => item.slug}
            renderItem={({ item }) => (
              <TouchableOpacity
                style={[styles.row, { borderBottomColor: theme.border }]}
                onPress={() => setPathStack(['projects', `projects/${item.slug}`])}
                activeOpacity={0.7}
              >
                <Text style={styles.rowIcon}>📁</Text>
                <View style={styles.rowBody}>
                  <Text style={[styles.rowName, { color: theme.text }]}>{item.name}</Text>
                  {item.preview ? <Text style={[styles.rowMeta, { color: theme.textDim }]} numberOfLines={1}>{item.preview}</Text> : null}
                  <Text style={[styles.rowMeta, { color: theme.textFaint }]}>{item.fileCount} file{item.fileCount !== 1 ? 's' : ''}{item.lastUpdated ? ` · ${formatDate(item.lastUpdated)}` : ''}</Text>
                </View>
              </TouchableOpacity>
            )}
            refreshControl={<RefreshControl refreshing={projectsLoading} onRefresh={fetchProjects} tintColor={theme.textDim} />}
            ListEmptyComponent={<View style={styles.emptyContainer}><View style={styles.centered}><Text style={[styles.emptyText, { color: theme.textDim }]}>No projects yet{'\n'}Start one in a conversation with {getModeName('mentor', modes)} or {getModeName('shapeshifter', modes)}</Text></View></View>}
            contentContainerStyle={projectsData.length === 0 ? styles.emptyContainer : styles.listPad}
          />
        )
      ) : topFolder === 'journal' && pathStack.length === 1 ? (
        journalLoading ? (
          <View style={styles.centered}><ActivityIndicator color={theme.textDim} /></View>
        ) : (
          <FlatList
            data={journalData}
            keyExtractor={item => item.date}
            renderItem={({ item }) => (
              <TouchableOpacity
                style={[styles.row, { borderBottomColor: theme.border }]}
                onPress={() => openFile({ name: item.date, path: item.path, size: 0, mtime: item.mtime, isDir: false })}
                activeOpacity={0.7}
              >
                <Text style={styles.rowIcon}>📅</Text>
                <View style={styles.rowBody}>
                  <Text style={[styles.rowName, { color: theme.text }]}>{item.date}</Text>
                  {item.preview ? <Text style={[styles.rowMeta, { color: theme.textDim }]} numberOfLines={2}>{item.preview}</Text> : null}
                </View>
              </TouchableOpacity>
            )}
            refreshControl={<RefreshControl refreshing={journalLoading} onRefresh={fetchJournal} tintColor={theme.textDim} />}
            ListEmptyComponent={<View style={styles.emptyContainer}><View style={styles.centered}><Text style={[styles.emptyText, { color: theme.textDim }]}>No journal entries yet</Text></View></View>}
            contentContainerStyle={journalData.length === 0 ? styles.emptyContainer : styles.listPad}
          />
        )
      ) : topFolder === 'wiki' && pathStack.length === 1 ? (
        <View style={styles.flex}>
          {/* Pinned meta files */}
          <TouchableOpacity
            style={[styles.row, styles.wikiPinnedRow, { borderBottomColor: theme.border, backgroundColor: BUZZ_ACCENT + '10' }]}
            onPress={() => openFile({ name: '_index.md', path: 'wiki/_index.md', size: 0, mtime: '', isDir: false })}
            activeOpacity={0.7}
          >
            <Text style={styles.rowIcon}>📋</Text>
            <View style={styles.rowBody}>
              <Text style={[styles.rowName, { color: BUZZ_ACCENT }]}>Index</Text>
              <Text style={[styles.rowMeta, { color: theme.textDim }]}>Master page catalog</Text>
            </View>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.row, styles.wikiPinnedRow, { borderBottomColor: theme.border, backgroundColor: BUZZ_ACCENT + '10' }]}
            onPress={() => openFile({ name: 'log.md', path: 'wiki/log.md', size: 0, mtime: '', isDir: false })}
            activeOpacity={0.7}
          >
            <Text style={styles.rowIcon}>📜</Text>
            <View style={styles.rowBody}>
              <Text style={[styles.rowName, { color: BUZZ_ACCENT }]}>Log</Text>
              <Text style={[styles.rowMeta, { color: theme.textDim }]}>Chronological operation history</Text>
            </View>
          </TouchableOpacity>
          {/* MOC list */}
          {mocsLoading && mocData.length === 0 ? (
            <View style={styles.centered}><ActivityIndicator color={theme.textDim} /></View>
          ) : (
            <FlatList
              data={mocData}
              keyExtractor={(item) => item.id}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={[styles.row, { borderBottomColor: theme.border }]}
                  onPress={() => openFile({ name: `${item.id}.md`, path: item.path, size: 0, mtime: item.lastUpdated, isDir: false })}
                  activeOpacity={0.7}
                >
                  <Text style={styles.rowIcon}>{item.exists ? '📋' : '○'}</Text>
                  <View style={styles.rowBody}>
                    <Text style={[styles.rowName, { color: item.exists ? theme.text : theme.textDim }]}>{item.name}</Text>
                    {item.preview ? (
                      <Text style={[styles.rowMeta, { color: theme.textDim }]} numberOfLines={1}>{item.preview}</Text>
                    ) : null}
                    <Text style={[styles.rowMeta, { color: theme.textFaint }]}>
                      {item.pageCount > 0 ? `${item.pageCount} page${item.pageCount !== 1 ? 's' : ''}` : 'no pages yet'}
                      {item.lastUpdated ? ` · ${new Date(item.lastUpdated).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}` : ''}
                    </Text>
                  </View>
                </TouchableOpacity>
              )}
              refreshControl={<RefreshControl refreshing={mocsLoading} onRefresh={fetchMocs} tintColor={theme.textDim} />}
              contentContainerStyle={mocData.length === 0 ? styles.emptyContainer : styles.listPad}
              ListEmptyComponent={
                <View style={styles.centered}>
                  <Text style={[styles.emptyText, { color: theme.textDim }]}>No wiki pages yet{'\n'}Use Brain Dump to add content</Text>
                </View>
              }
            />
          )}
        </View>
      ) : (
        loading ? (
          <View style={styles.centered}><ActivityIndicator color={theme.text} /></View>
        ) : error ? (
          <View style={styles.centered}>
            <Text style={[styles.errorText, { color: theme.textDim }]}>{error}</Text>
            <TouchableOpacity style={[styles.retryBtn, { borderColor: theme.border }]} onPress={() => fetchTree()}>
              <Text style={[styles.retryLabel, { color: theme.text }]}>Retry</Text>
            </TouchableOpacity>
          </View>
        ) : topFolder === 'raw' ? (
          <View style={styles.flex}>
            <RawCards
              entries={entries.filter(e => e.name !== 'README.md').map(e => ({ ...e, isPending: rawPending.has(e.path) }))}
              refreshing={refreshing}
              onRefresh={() => fetchTree(true)}
              onOpen={(e) => openFile({ name: e.name, path: e.path, size: 0, mtime: e.mtime, isDir: false })}
              theme={theme}
              accent={BUZZ_ACCENT}
            />
            {entries.length > 0 ? (
              <Text style={[styles.underscoreNote, { color: theme.textFaint }]}>Files starting with _ are excluded from ingest.</Text>
            ) : null}
          </View>
        ) : (
          <View style={styles.flex}>
            <FlatList
              data={entries}
              keyExtractor={(item) => item.path}
              renderItem={renderEntry}
              refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => fetchTree(true)} tintColor={theme.textDim} />}
              ListEmptyComponent={<View style={styles.centered}><Text style={[styles.emptyText, { color: theme.textDim }]}>No files yet</Text></View>}
              contentContainerStyle={entries.length === 0 ? styles.emptyContainer : styles.listPad}
            />
          </View>
        )
      )}

      </View>{/* end content area */}

      {/* FAB row — hidden in Hive graph mode */}
      <View style={[styles.fabRow, hiveMode && { display: 'none' }]}>
        <TouchableOpacity
          style={[styles.fab, { backgroundColor: theme.surface, borderColor: theme.border }]}
          onPress={() => { setAskQuestion(''); setAskResults([]); setAskError(null); setAskSearched(false); setAskModalVisible(true); }}
          activeOpacity={0.8}
        >
          <Text style={[styles.fabLabel, { color: BUZZ_ACCENT }]}>? Ask</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.fab, { backgroundColor: theme.surface, borderColor: theme.border }]}
          onPress={() => setIngestModalVisible(true)}
          activeOpacity={0.8}
        >
          <Text style={[styles.fabLabel, { color: theme.text }]}>+ Brain Dump</Text>
        </TouchableOpacity>
      </View>

      {/* Tools action sheet */}
      <Modal
        visible={toolsSheetVisible}
        animationType="fade"
        transparent
        onRequestClose={() => setToolsSheetVisible(false)}
      >
        <TouchableOpacity
          style={styles.sheetBackdrop}
          activeOpacity={1}
          onPress={() => setToolsSheetVisible(false)}
        >
          <View />
        </TouchableOpacity>
        <View style={[styles.sheet, { backgroundColor: theme.surface, borderColor: theme.border, paddingBottom: insets.bottom + 12 }]}>
          <Text style={[styles.sheetTitle, { color: theme.textDim }]}>KNOWLEDGE TOOLS</Text>

          <TouchableOpacity
            style={[styles.sheetRow, { borderBottomColor: theme.border }]}
            onPress={() => { setToolsSheetVisible(false); runLint(); }}
            disabled={linting}
            activeOpacity={0.7}
          >
            <Text style={[styles.sheetRowIcon, { color: BUZZ_ACCENT }]}>🧠</Text>
            <View style={styles.sheetRowBody}>
              <Text style={[styles.sheetRowTitle, { color: theme.text }]}>Lint Vault</Text>
              <Text style={[styles.sheetRowDesc, { color: theme.textDim }]}>Check links, stale pages, missing concepts</Text>
            </View>
            {linting ? <ActivityIndicator size="small" color={theme.textDim} /> : null}
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.sheetRow, { borderBottomColor: theme.border }]}
            onPress={() => { setToolsSheetVisible(false); runIngestRaw(); }}
            disabled={ingestRawRunning}
            activeOpacity={0.7}
          >
            <Text style={[styles.sheetRowIcon, { color: BUZZ_ACCENT }]}>⬇</Text>
            <View style={styles.sheetRowBody}>
              <Text style={[styles.sheetRowTitle, { color: theme.text }]}>{rawPendingCount > 0 ? `Process Raw → Wiki (${rawPendingCount} pending)` : 'Process Raw → Wiki'}</Text>
              {ingestProgress ? (
                <Text style={[styles.sheetRowDesc, { color: theme.textDim }]}>
                  {`Processing ${ingestProgress.file.replace('raw/', '')} (${ingestProgress.done} / ${ingestProgress.total})`}
                </Text>
              ) : (
                <Text style={[styles.sheetRowDesc, { color: theme.textDim }]}>Run LLM ingest on uningested raw files</Text>
              )}
            </View>
            {ingestRawRunning ? <ActivityIndicator size="small" color={theme.textDim} /> : null}
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.sheetRow, styles.sheetRowLast]}
            onPress={() => { setToolsSheetVisible(false); runDupes(); }}
            disabled={dupesLoading}
            activeOpacity={0.7}
          >
            <Text style={[styles.sheetRowIcon, { color: BUZZ_ACCENT }]}>⊕</Text>
            <View style={styles.sheetRowBody}>
              <Text style={[styles.sheetRowTitle, { color: theme.text }]}>Find Duplicates</Text>
              <Text style={[styles.sheetRowDesc, { color: theme.textDim }]}>Surface near-duplicate wiki pages</Text>
            </View>
            {dupesLoading ? <ActivityIndicator size="small" color={theme.textDim} /> : null}
          </TouchableOpacity>
        </View>
      </Modal>

      {/* File viewer modal */}
      <Modal visible={fileModalVisible} animationType="slide" presentationStyle="pageSheet" onRequestClose={closeFileModal}>
        <View style={[styles.modalRoot, { backgroundColor: theme.bg, paddingTop: insets.top }]}>
          <View style={[styles.modalHeader, { borderBottomColor: theme.border }]}>
            <TouchableOpacity onPress={closeFileModal} style={styles.modalHeaderBtn}>
              <Text style={[styles.modalHeaderBtnLabel, { color: theme.text }]}>✕</Text>
            </TouchableOpacity>
            <Text style={[styles.modalTitle, { color: theme.text }]} numberOfLines={1}>{fileDetail?.path ?? '…'}</Text>
            {editMode ? (
              <TouchableOpacity onPress={saveFile} style={styles.modalHeaderBtn} disabled={saving || fileLoading}>
                <Text style={[styles.modalHeaderBtnLabel, { color: BUZZ_ACCENT }]}>{saving ? '…' : 'Save'}</Text>
              </TouchableOpacity>
            ) : (
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <TouchableOpacity onPress={deleteFile} style={styles.modalHeaderBtn} disabled={fileLoading || !fileDetail}>
                  <Text style={[styles.modalHeaderBtnLabel, { color: '#FF6135' }]}>Delete</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => setEditMode(true)} style={styles.modalHeaderBtn} disabled={fileLoading || !fileDetail}>
                  <Text style={[styles.modalHeaderBtnLabel, { color: theme.text }]}>Edit</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
          {fileLoading ? (
            <View style={styles.centered}><ActivityIndicator color={theme.text} /></View>
          ) : saveError && !fileDetail ? (
            <View style={styles.centered}><Text style={[styles.errorText, { color: theme.textDim }]}>{saveError}</Text></View>
          ) : editMode ? (
            <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
              <TextInput
                style={[styles.editor, { color: theme.text, backgroundColor: theme.inputBg }]}
                value={editContent}
                onChangeText={setEditContent}
                multiline autoFocus textAlignVertical="top" scrollEnabled
              />
              {saveError ? <Text style={[styles.saveError, { color: '#FF6135' }]}>{saveError}</Text> : null}
            </KeyboardAvoidingView>
          ) : (
            <ScrollView style={styles.flex} contentContainerStyle={styles.fileContentPad}>
              <Markdown
                style={buildMarkdownStyles(theme)}
                onLinkPress={(url) => {
                  if (url.startsWith('wiki/') || url.startsWith('raw/') || url.startsWith('journal/')) {
                    const name = url.split('/').pop() ?? url;
                    openFile({ name, path: url, size: 0, mtime: '', isDir: false });
                    return false;
                  }
                  return true;
                }}
              >
                {resolveWikiLinks(fileDetail?.content ?? '')}
              </Markdown>
              {fileDetail?.path.startsWith('raw/') && (
                <TouchableOpacity
                  onPress={ingestFileFromRaw}
                  disabled={ingestingFile}
                  style={{ margin: 16, padding: 12, borderRadius: 8, backgroundColor: BUZZ_ACCENT, alignItems: 'center' }}
                >
                  <Text style={{ color: '#fff', fontWeight: '600' }}>
                    {ingestingFile ? 'Ingesting…' : '↑ Process → Wiki'}
                  </Text>
                </TouchableOpacity>
              )}
            </ScrollView>
          )}
        </View>
      </Modal>

      {/* Brain Dump modal — chat-style */}
      <Modal visible={ingestModalVisible} animationType="slide" presentationStyle="pageSheet" onRequestClose={closeIngestModal}>
        <View style={[styles.modalRoot, { backgroundColor: theme.bg, paddingBottom: chatKeyboardHeight }]}>
          {/* Header */}
          <View style={[styles.chatModalHeader, { paddingTop: insets.top + 12, borderBottomColor: theme.border }]}>
            <TouchableOpacity onPress={closeIngestModal} style={styles.modalHeaderBtn}>
              <Text style={[styles.modalHeaderBtnLabel, { color: theme.text }]}>✕</Text>
            </TouchableOpacity>
            <View style={styles.chatModalTitleRow}>
              <Text style={styles.chatModalAvatar}>🐝</Text>
              <Text style={[styles.chatModalName, { color: theme.text }]}>Brain Dump</Text>
            </View>
            <View style={styles.modalHeaderBtn} />
          </View>

          {/* Bee bubble */}
          <View style={styles.chatBubbleRow}>
            <Text style={[styles.chatPersonaLabel, { color: BUZZ_ACCENT }]}>{getModeEmoji('keeper', modes)} {getModeName('keeper', modes)}</Text>
            <View style={[styles.chatBubble, { backgroundColor: theme.surface, borderColor: theme.border }]}>
              <Text style={[styles.chatBubbleText, { color: theme.text }]}>What's on your mind?</Text>
            </View>
          </View>

          {/* Spacer pushes input to bottom */}
          <View style={styles.flex} />

          {/* User reply input */}
          <View style={[styles.chatInputArea, { borderTopColor: theme.border, backgroundColor: theme.bg, paddingBottom: Math.max(insets.bottom, 16) }]}>
            <TextInput
              style={[styles.chatTextInput, { color: theme.text, backgroundColor: theme.inputBg }]}
              value={ingestText}
              onChangeText={setIngestText}
              multiline autoFocus
              placeholder="Dump it here…"
              placeholderTextColor={theme.textDim}
              textAlignVertical="top"
              maxLength={10000}
            />
            <View style={styles.chatInputFooter}>
              <TouchableOpacity
                style={{ flexDirection: 'row', alignItems: 'center' }}
                onPress={() => setCaptureProcessNow(v => !v)}
                activeOpacity={0.7}
              >
                <View style={{
                  width: 18, height: 18, borderRadius: 4, borderWidth: 1.5,
                  borderColor: captureProcessNow ? BUZZ_ACCENT : theme.border,
                  backgroundColor: captureProcessNow ? BUZZ_ACCENT : 'transparent',
                  marginRight: 8, alignItems: 'center', justifyContent: 'center',
                }}>
                  {captureProcessNow ? <Text style={{ color: '#000', fontSize: 11, fontWeight: '700' }}>✓</Text> : null}
                </View>
                <Text style={{ color: theme.textDim, fontSize: 13 }}>Process → wiki</Text>
              </TouchableOpacity>
              {ingestError ? <Text style={{ color: '#FF6135', fontSize: 12, marginLeft: 8 }}>{ingestError}</Text> : null}
              <TouchableOpacity
                style={[styles.chatSendBtn, { backgroundColor: BUZZ_ACCENT }, (!ingestText.trim() || ingestSaving) && { opacity: 0.4 }]}
                onPress={submitCapture}
                disabled={!ingestText.trim() || ingestSaving}
                activeOpacity={0.8}
              >
                <Text style={styles.chatSendBtnLabel}>{ingestSaving ? '…' : captureProcessNow ? 'Save & Process' : 'Save'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Ask modal — chat-style */}
      <Modal visible={askModalVisible} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setAskModalVisible(false)}>
        <View style={[styles.modalRoot, { backgroundColor: theme.bg, paddingBottom: chatKeyboardHeight }]}>
          {/* Header */}
          <View style={[styles.chatModalHeader, { paddingTop: insets.top + 12, borderBottomColor: theme.border }]}>
            <TouchableOpacity onPress={() => setAskModalVisible(false)} style={styles.modalHeaderBtn}>
              <Text style={[styles.modalHeaderBtnLabel, { color: theme.text }]}>✕</Text>
            </TouchableOpacity>
            <View style={styles.chatModalTitleRow}>
              <Text style={styles.chatModalAvatar}>🐝</Text>
              <Text style={[styles.chatModalName, { color: theme.text }]}>Ask</Text>
            </View>
            <View style={styles.modalHeaderBtn} />
          </View>

          {/* Bee bubble */}
          <View style={styles.chatBubbleRow}>
            <Text style={[styles.chatPersonaLabel, { color: BUZZ_ACCENT }]}>{getModeEmoji('keeper', modes)} {getModeName('keeper', modes)}</Text>
            <View style={[styles.chatBubble, { backgroundColor: theme.surface, borderColor: theme.border }]}>
              <Text style={[styles.chatBubbleText, { color: theme.text }]}>What do you want to know?</Text>
            </View>
          </View>

          {/* Filter chips */}
          <View style={[styles.askFilterRow, { paddingHorizontal: 16 }]}>
            {(['all', 'wiki', 'projects', 'journal'] as const).map(f => (
              <TouchableOpacity
                key={f}
                onPress={() => setAskFilter(f)}
                style={[styles.askFilterChip, askFilter === f && { backgroundColor: BUZZ_ACCENT }]}
                activeOpacity={0.7}
              >
                <Text style={[styles.askFilterLabel, { color: askFilter === f ? '#fff' : theme.textDim }]}>
                  {f.charAt(0).toUpperCase() + f.slice(1)}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* Results area */}
          <ScrollView style={styles.flex} keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 16 }}>
            {askLoading ? (
              <View style={[styles.centered, { paddingVertical: 32 }]}><ActivityIndicator color={theme.textDim} /></View>
            ) : askError ? (
              <View style={[styles.chatBubbleRow, { marginTop: 8 }]}>
                <View style={[styles.chatBubble, { backgroundColor: theme.surface, borderColor: theme.border }]}>
                  <Text style={[styles.chatBubbleText, { color: '#FF6135' }]}>{askError}</Text>
                </View>
              </View>
            ) : askSearched && !askAnswer && askResults.length === 0 ? (
              <View style={[styles.chatBubbleRow, { marginTop: 8 }]}>
                <View style={[styles.chatBubble, { backgroundColor: theme.surface, borderColor: theme.border }]}>
                  <Text style={[styles.chatBubbleText, { color: theme.textDim }]}>No matches found. Try adding more notes to your wiki.</Text>
                </View>
              </View>
            ) : askSearched && askAnswer ? (
              <>
                <View style={[styles.chatBubbleRow, { marginTop: 8 }]}>
                  <View style={[styles.chatBubble, { backgroundColor: theme.surface, borderColor: theme.border }]}>
                    <Markdown style={buildMarkdownStyles(theme)}>{askAnswer}</Markdown>
                  </View>
                </View>
                {askResults.length > 0 ? (
                  <>
                    <TouchableOpacity
                      style={[styles.askSourcesToggle, { borderBottomColor: theme.border, marginHorizontal: 16 }]}
                      onPress={() => setAskSourcesExpanded(e => !e)}
                      activeOpacity={0.7}
                    >
                      <Text style={[styles.askSourcesToggleLabel, { color: theme.textDim }]}>
                        {askSourcesExpanded ? '▾' : '▸'} {askResults.length} source{askResults.length !== 1 ? 's' : ''}
                      </Text>
                    </TouchableOpacity>
                    {askSourcesExpanded && askResults.map((chunk, i) => (
                      <View key={i} style={[styles.askChunk, { borderBottomColor: theme.border, marginHorizontal: 16 }]}>
                        <Text style={[styles.askChunkPath, { color: BUZZ_ACCENT }]}>{chunk.path}{chunk.heading ? ` › ${chunk.heading}` : ''}</Text>
                        <Text style={[styles.askChunkText, { color: theme.text }]}>{chunk.text}</Text>
                      </View>
                    ))}
                  </>
                ) : null}
                <TouchableOpacity
                  style={[styles.saveToWikiBtn, { backgroundColor: BUZZ_ACCENT + '18', borderColor: BUZZ_ACCENT + '40', marginHorizontal: 16 }]}
                  onPress={async () => {
                    try {
                      await apiFetch('/wiki/save-answer', {
                        method: 'POST',
                        body: JSON.stringify({ question: askQuestion, answer: askAnswer ?? askResults.map(r => r.text).join('\n') }),
                      });
                      setAskSaved(true);
                      setTimeout(() => setAskSaved(false), 3000);
                    } catch {}
                  }}
                  activeOpacity={0.8}
                >
                  <Text style={[styles.saveToWikiLabel, { color: BUZZ_ACCENT }]}>
                    {askSaved ? '✓ Saved to wiki' : '+ Save to wiki'}
                  </Text>
                </TouchableOpacity>
              </>
            ) : null}
          </ScrollView>

          {/* User reply input */}
          <View style={[styles.chatInputArea, { borderTopColor: theme.border, backgroundColor: theme.bg, paddingBottom: Math.max(insets.bottom, 16) }]}>
            <View style={styles.chatInputFooter}>
              <TextInput
                style={[styles.chatTextInputInline, { color: theme.text, backgroundColor: theme.inputBg, flex: 1, marginRight: 8 }]}
                value={askQuestion}
                onChangeText={setAskQuestion}
                placeholder="Ask something…"
                placeholderTextColor={theme.textDim}
                multiline={false}
                returnKeyType="search"
                onSubmitEditing={runAsk}
                autoFocus
              />
              <TouchableOpacity
                style={[styles.chatSendBtn, { backgroundColor: BUZZ_ACCENT }, (askLoading || !askQuestion.trim()) && { opacity: 0.4 }]}
                onPress={runAsk}
                disabled={askLoading || !askQuestion.trim()}
                activeOpacity={0.8}
              >
                <Text style={styles.chatSendBtnLabel}>{askLoading ? '…' : 'Ask'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Ingest result */}
      <Modal visible={!!ingestResult} animationType="fade" transparent onRequestClose={() => setIngestResult(null)}>
        <TouchableOpacity style={styles.sheetBackdrop} activeOpacity={1} onPress={() => setIngestResult(null)}>
          <View />
        </TouchableOpacity>
        <View style={[styles.ingestResultSheet, { backgroundColor: theme.surface, borderColor: theme.border, paddingBottom: insets.bottom + 16 }]}>
          <Text style={[styles.sheetTitle, { color: theme.textDim }]}>INGESTED</Text>
          {ingestResult && (
            <>
              {ingestResult.todos_added > 0 && (
                <Text style={[styles.ingestResultLine, { color: theme.text }]}>
                  ✓ {ingestResult.todos_added} todo{ingestResult.todos_added !== 1 ? 's' : ''} added to today's list
                </Text>
              )}
              {ingestResult.pages_created.length > 0 && (
                <Text style={[styles.ingestResultLine, { color: theme.text }]}>
                  ✓ Created: {ingestResult.pages_created.join(', ')}
                </Text>
              )}
              {ingestResult.pages_updated.length > 0 && (
                <Text style={[styles.ingestResultLine, { color: theme.text }]}>
                  ↑ Updated: {ingestResult.pages_updated.join(', ')}
                </Text>
              )}
              {ingestResult.project_flag && (
                <Text style={[styles.ingestResultNudge, { color: BUZZ_ACCENT }]}>
                  Sounds like it relates to "{ingestResult.project_flag}" — bring it up with {getModeName('mentor', modes)} or {getModeName('shapeshifter', modes)}.
                </Text>
              )}
              {ingestResult.todos_added === 0 && ingestResult.pages_created.length === 0 && ingestResult.pages_updated.length === 0 && (
                <Text style={[styles.ingestResultLine, { color: ingestResult.failSaved ? '#FF6135' : theme.textDim }]}>
                  {ingestResult.failSaved ? 'LLM returned nothing — saved debug file' : 'Nothing new to file.'}
                </Text>
              )}
            </>
          )}
          <TouchableOpacity onPress={() => setIngestResult(null)} style={[styles.ingestSaveBtn, { backgroundColor: theme.surfaceAlt, borderColor: theme.border, marginTop: 12, marginHorizontal: 0 }]}>
            <Text style={[styles.ingestSaveBtnLabel, { color: theme.text }]}>Done</Text>
          </TouchableOpacity>
        </View>
      </Modal>

      {/* Dupes modal */}
      <Modal visible={dupesModalVisible} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setDupesModalVisible(false)}>
        <View style={[styles.modalRoot, { backgroundColor: theme.bg }]}>
          <View style={[styles.modalHeader, { borderBottomColor: theme.border }]}>
            <TouchableOpacity onPress={() => setDupesModalVisible(false)} style={styles.modalHeaderBtn}>
              <Text style={[styles.modalHeaderBtnLabel, { color: theme.text }]}>✕</Text>
            </TouchableOpacity>
            <Text style={[styles.modalTitle, { color: theme.text }]}>Duplicate pages</Text>
            <View style={styles.modalHeaderBtn} />
          </View>
          <ScrollView style={styles.flex}>
            {dupesLoading ? (
              <View style={styles.centered}><ActivityIndicator color={theme.textDim} /></View>
            ) : dupesError ? (
              <Text style={[styles.toolsMsgText, { color: theme.textDim, padding: 20 }]}>{dupesError}</Text>
            ) : dupes.length === 0 ? (
              <Text style={[styles.emptyText, { color: theme.textDim, padding: 20 }]}>No near-duplicates found ✓</Text>
            ) : (
              dupes.map((d, i) => (
                <View key={i} style={[styles.askChunk, { borderBottomColor: theme.border }]}>
                  <Text style={[styles.askChunkPath, { color: BUZZ_ACCENT }]}>{Math.round(d.similarity * 100)}% similar</Text>
                  <Text style={[styles.askChunkText, { color: theme.text }]}>{d.fileA}</Text>
                  <Text style={[styles.askChunkText, { color: theme.textDim }]}>{d.fileB}</Text>
                </View>
              ))
            )}
          </ScrollView>
        </View>
      </Modal>

      <SettingsModal
        visible={settingsVisible}
        onClose={() => { setSettingsVisible(false); setSettingsSection(undefined); }}
        section={settingsSection}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  flex: { flex: 1 },
  personaHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  personaTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 18,
  },
  personaHeaderControls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  personaHeaderBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  personaHeaderBtnLabel: {
    fontSize: 16,
    fontFamily: 'DMSans_700Bold',
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth },
  tabs: { flex: 1, flexDirection: 'row' },
  tab: { flex: 1, paddingVertical: 12, alignItems: 'center', borderBottomWidth: 2, borderBottomColor: 'transparent' },
  tabLabel: { fontFamily: 'DMSans_500Medium', fontSize: 14 },
  backBtn: { flex: 1, paddingHorizontal: 16, paddingVertical: 12, justifyContent: 'center' },
  backBtnLabel: { fontFamily: 'DMSans_500Medium', fontSize: 15 },
  overflowBtn: {
    width: 48,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  overflowBtnLabel: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 22,
    lineHeight: 22,
  },
  toolsMsgBar: { paddingHorizontal: 16, paddingVertical: 6 },
  toolsMsgText: { fontFamily: 'DMSans_400Regular', fontSize: 12 },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, gap: 12 },
  rowIcon: { fontSize: 18 },
  rowBody: { flex: 1, gap: 2 },
  rowName: { fontFamily: 'DMSans_500Medium', fontSize: 15 },
  rowMeta: { fontFamily: 'DMSans_400Regular', fontSize: 12 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 12 },
  contentArea: { flex: 1 },
  emptyContainer: { flexGrow: 1 },
  listPad: { paddingBottom: 100 },
  emptyText: { fontFamily: 'DMSans_400Regular', fontSize: 15 },
  errorText: { fontFamily: 'DMSans_400Regular', fontSize: 14, textAlign: 'center' },
  retryBtn: { paddingHorizontal: 20, paddingVertical: 10, borderRadius: 8, borderWidth: 1 },
  retryLabel: { fontFamily: 'DMSans_500Medium', fontSize: 14 },
  fabRow: {
    flexDirection: 'row',
    position: 'absolute',
    bottom: 24,
    left: 16,
    right: 16,
    gap: 12,
  },
  fab: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
  },
  fabLabel: { fontFamily: 'DMSans_500Medium', fontSize: 15 },
  askChunk: {
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  askChunkPath: {
    fontFamily: 'DMSans_500Medium',
    fontSize: 11,
    letterSpacing: 0.5,
    marginBottom: 6,
    opacity: 0.8,
  },
  askChunkText: {
    fontFamily: 'DMSans_400Regular',
    fontSize: 14,
    lineHeight: 22,
  },
  modalRoot: { flex: 1 },
  modalHeader: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth },
  modalHeaderBtn: { minWidth: 44, alignItems: 'center' },
  modalHeaderBtnLabel: { fontFamily: 'DMSans_500Medium', fontSize: 16 },
  modalTitle: { flex: 1, fontFamily: 'DMSans_700Bold', fontSize: 16, textAlign: 'center' },
  fileContentPad: { padding: 16 },
  fileContent: { fontFamily: 'DMSans_400Regular', fontSize: 14, lineHeight: 22 },
  editor: { flex: 1, margin: 16, padding: 12, borderRadius: 8, fontFamily: 'DMSans_400Regular', fontSize: 14, lineHeight: 22 },
  saveError: { fontFamily: 'DMSans_400Regular', fontSize: 13, paddingHorizontal: 16, paddingBottom: 8 },
  ingestInput: { flex: 1, margin: 16, padding: 12, borderRadius: 8, fontFamily: 'DMSans_400Regular', fontSize: 15, lineHeight: 24 },
  ingestSaveBtn: { margin: 16, paddingVertical: 14, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center' },
  ingestSaveBtnDisabled: { opacity: 0.4 },
  ingestSaveBtnLabel: { fontFamily: 'DMSans_700Bold', fontSize: 15 },

  // Chat-style modal (Brain Dump / Ask)
  chatModalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 8,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  chatModalTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  chatModalAvatar: { fontSize: 22 },
  chatModalName: { fontFamily: 'DMSans_700Bold', fontSize: 16 },
  chatBubbleRow: { paddingHorizontal: 16, paddingTop: 16, alignItems: 'flex-start', flexDirection: 'column' },
  chatPersonaLabel: { fontFamily: 'DMSans_700Bold', fontSize: 12, marginBottom: 4, marginLeft: 2 },
  chatBubble: {
    maxWidth: '80%',
    borderRadius: 16,
    borderBottomLeftRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  chatBubbleText: { fontFamily: 'DMSans_400Regular', fontSize: 15, lineHeight: 22 },
  chatInputArea: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 16,
  },
  chatTextInput: {
    minHeight: 80,
    maxHeight: 200,
    borderRadius: 12,
    padding: 12,
    fontFamily: 'DMSans_400Regular',
    fontSize: 15,
    lineHeight: 22,
    marginBottom: 8,
  },
  chatTextInputInline: {
    height: 42,
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontFamily: 'DMSans_400Regular',
    fontSize: 15,
  },
  chatInputFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  chatSendBtn: {
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chatSendBtnLabel: { fontFamily: 'DMSans_700Bold', fontSize: 14, color: '#000' },

  // Tools action sheet
  sheetBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  sheet: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 8,
  },
  sheetTitle: {
    fontFamily: 'DMSans_500Medium',
    fontSize: 11,
    letterSpacing: 1.2,
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  sheetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  sheetRowLast: {
    borderBottomWidth: 0,
  },
  sheetRowIcon: {
    fontSize: 18,
    width: 24,
    textAlign: 'center',
  },
  sheetRowBody: {
    flex: 1,
    gap: 2,
  },
  sheetRowTitle: {
    fontFamily: 'DMSans_500Medium',
    fontSize: 15,
  },
  sheetRowDesc: {
    fontFamily: 'DMSans_400Regular',
    fontSize: 12,
  },
  askFilterRow: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  askFilterChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: 'transparent',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'transparent',
  },
  askFilterLabel: {
    fontFamily: 'DMSans_500Medium',
    fontSize: 13,
  },
  askInput: {
    margin: 16,
    marginTop: 8,
    padding: 12,
    borderRadius: 8,
    fontFamily: 'DMSans_400Regular',
    fontSize: 15,
  },
  askAnswerBlock: {
    margin: 16,
    padding: 16,
    borderRadius: 10,
    borderLeftWidth: 3,
  },
  askAnswerText: {
    fontFamily: 'DMSans_400Regular',
    fontSize: 15,
    lineHeight: 24,
  },
  askSourcesToggle: {
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  askSourcesToggleLabel: {
    fontFamily: 'DMSans_500Medium',
    fontSize: 13,
  },
  ingestResultSheet: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 8,
    paddingHorizontal: 20,
  },
  ingestResultLine: {
    fontFamily: 'DMSans_400Regular',
    fontSize: 15,
    lineHeight: 24,
    paddingVertical: 4,
  },
  ingestResultNudge: {
    fontFamily: 'Lora_400Regular_Italic',
    fontSize: 14,
    lineHeight: 22,
    marginTop: 8,
  },
  wikiPinnedRow: {
    paddingVertical: 14,
  },
  saveToWikiBtn: {
    marginHorizontal: 16,
    marginTop: 8,
    marginBottom: 4,
    padding: 12,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
  },
  saveToWikiLabel: {
    fontFamily: 'DMSans_500Medium',
    fontSize: 14,
  },
  underscoreNote: {
    fontFamily: 'DMSans_400Regular',
    fontSize: 11,
    textAlign: 'center',
    paddingVertical: 8,
    paddingHorizontal: 16,
    opacity: 0.6,
  },
});
