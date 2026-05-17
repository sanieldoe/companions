import React, {
  useState,
  useCallback,
  useEffect,
  useRef,
} from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  Alert,
  ScrollView,
  FlatList,
  Modal,
  Animated,
  Dimensions,
  KeyboardAvoidingView,
  Platform,
  PanResponder,
  NativeSyntheticEvent,
  NativeScrollEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, useFocusEffect } from 'expo-router';
import { impact } from '../../lib/haptics';
import { useTheme } from '../../lib/theme';
import { apiFetch } from '../../lib/api';
import { useStore, MODE_EMOJIS, MODE_NAMES, getModeName, getModeEmoji } from '../../lib/store';
import SettingsModal from '../../components/SettingsModal';

// ─── Constants ────────────────────────────────────────────────────────────────

const CAL_PANEL_HEIGHT = 150;
const CAL_SCROLL_HEIGHT = 110;
const HAIKU_PANEL_HEIGHT = 165;
const ACCENT = '#42A5F5';
const { width: SCREEN_WIDTH } = Dimensions.get('window');

const PLACEHOLDER_HAIKU = "Do you realise,\nthat placeholders shouldn't be,\nthis exciting right?";

const PRIORITY_COLORS: Record<number, string> = { 1: '#FF5252', 2: '#FFB300', 3: '#42A5F5' };
const RHYTHM_COLOR = '#66BB6A';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Task {
  text: string;
  done: boolean;
  carriedOver?: boolean;
  priority?: 1 | 2 | 3;
}

interface AgendaEvent {
  title: string;
  time: string;
  location?: string | null;
  allDay?: boolean;
}

interface AgendaDay {
  date: string;
  label: string;
  shortLabel: string;
  events: AgendaEvent[];
}

interface RhythmDue {
  id: string;
  title: string;
  type: 'daily' | 'weekly' | 'monthly' | 'annual';
  dueDate: string;
  completed: boolean;
  schedule: {
    days?: number[];
    dayOfMonth?: number;
    month?: number;
    day?: number;
  };
}

interface Rhythm {
  id: string;
  title: string;
  description?: string;
  type: 'daily' | 'weekly' | 'monthly' | 'annual';
  schedule: {
    days?: number[];
    dayOfMonth?: number;
    month?: number;
    day?: number;
  };
  notifyMinutes: number;
  active: boolean;
  createdAt: string;
  source: 'manual' | 'ingest';
  completions: string[];
  calEventId?: string;
}

// ─── Utility functions ────────────────────────────────────────────────────────

function todayKey(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function weekKey(): string {
  const now = new Date();
  // Snap to Monday of the current ISO week
  const day = now.getDay(); // 0=Sun
  const toMonday = day === 0 ? -6 : 1 - day;
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + toMonday);
  // ISO week number: find Thursday of this week (ISO week owner), then derive week
  const thursday = new Date(monday);
  thursday.setDate(monday.getDate() + 3);
  const yearStart = new Date(thursday.getFullYear(), 0, 1);
  const weekNo = Math.ceil(((thursday.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${thursday.getFullYear()}-${String(weekNo).padStart(2, '0')}`;
}

function formatLabel(dateKey: string): string {
  try {
    const [y, m, d] = dateKey.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, {
      month: 'long', day: 'numeric', year: 'numeric',
    });
  } catch { return dateKey; }
}

function formatHeaderDate(): string {
  const d = new Date();
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function currentTimeString(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function extractHaiku(content: string): string {
  return content.split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !l.startsWith('- ['))
    .slice(0, 3).join('\n');
}

function extractTasks(content: string): Task[] {
  const lines = content.split('\n');
  const taskStart = lines.findIndex((l) => l.trim() === '## Tasks');
  if (taskStart === -1) return [];
  return lines.slice(taskStart + 1)
    .filter((l) => /^- \[[ x]\]/.test(l.trim()))
    .map((l) => {
      const raw = l.replace(/^- \[[ x]\]\s*/, '').trim();
      const prioMatch = raw.match(/^\[p([123])\]\s*/);
      const priority = prioMatch ? (Number(prioMatch[1]) as 1 | 2 | 3) : undefined;
      const text = prioMatch ? raw.slice(prioMatch[0].length) : raw;
      return { text, done: l.includes('- [x]'), priority };
    });
}

function extractInboxTasks(content: string): Task[] {
  return content.split('\n')
    .filter((l) => /^- \[[ x]\]/.test(l.trim()))
    .map((l) => {
      const raw = l.replace(/^- \[[ x]\]\s*/, '').trim();
      const prioMatch = raw.match(/^\[p([123])\]\s*/);
      const priority = prioMatch ? (Number(prioMatch[1]) as 1 | 2 | 3) : undefined;
      const text = prioMatch ? raw.slice(prioMatch[0].length) : raw;
      return { text, done: l.includes('[x]'), priority };
    });
}

function buildInboxContent(tasks: Task[]): string {
  if (!tasks.length) return '';
  return tasks.map((t) => {
    const prioPrefix = t.priority ? `[p${t.priority}] ` : '';
    return `- [${t.done ? 'x' : ' '}] ${prioPrefix}${t.text}`;
  }).join('\n') + '\n';
}

function buildFileContent(dateKey: string, haiku: string, tasks: Task[]): string {
  const label = formatLabel(dateKey);
  let content = `# ${label}\n\n${haiku.trim()}\n`;
  if (tasks.length > 0) {
    content += `\n## Tasks\n`;
    for (const t of tasks) {
      const prioPrefix = t.priority ? `[p${t.priority}] ` : '';
      content += `- [${t.done ? 'x' : ' '}] ${prioPrefix}${t.text}\n`;
    }
  }
  return content;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function LendaScreen() {
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const isDark = useStore((s) => s.isDark);
  const toggleTheme = useStore((s) => s.toggleTheme);
  const calDigest = useStore((s) => s.calDigest);
  const setCalDigest = useStore((s) => s.setCalDigest);
  const connected = useStore((s) => s.connected);
  const modes = useStore((s) => s.modes);
  const today = todayKey();

  // ── State ───────────────────────────────────────────────────────────────────

  const [haiku, setHaiku] = useState('');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [newTaskText, setNewTaskText] = useState('');
  const [inboxTasks, setInboxTasks] = useState<Task[]>([]);
  const [editingTaskIndex, setEditingTaskIndex] = useState<number | null>(null);
  const [editingText, setEditingText] = useState('');
  const [pastHaikuMap, setPastHaikuMap] = useState<Record<string, string>>({});
  const [agendaDays, setAgendaDays] = useState<AgendaDay[]>([]);
  const [calendarConnected, setCalendarConnected] = useState(false);
  const [calendarView, setCalendarView] = useState<'day' | 'week'>('day');
  const [calRefreshing, setCalRefreshing] = useState(false);
  const calendarVersion = useStore(s => s.calendarVersion);

  // Phrase of the week
  const [phraseOfWeek, setPhraseOfWeek] = useState('');
  const [editingPhrase, setEditingPhrase] = useState(false);
  const [phraseDraft, setPhraseDraft] = useState('');

  // Rhythms
  const [dueRhythms, setDueRhythms] = useState<RhythmDue[]>([]);
  const [rhythmsModalVisible, setRhythmsModalVisible] = useState(false);
  const [allRhythms, setAllRhythms] = useState<Rhythm[]>([]);
  const [rhythmForm, setRhythmForm] = useState<{
    visible: boolean;
    title: string;
    type: 'daily' | 'every-n-days' | 'every-n-weeks' | 'weekly' | 'monthly' | 'annual';
    days: number[];
    dayOfMonth: number;
    month: number;
    day: number;
    n: number;
    description: string;
  }>({ visible: false, title: '', type: 'weekly', days: [], dayOfMonth: 1, month: 1, day: 1, n: 2, description: '' });

  // Settings modal
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [settingsSection, setSettingsSection] = useState<'model' | 'history' | undefined>(undefined);

  // Device-code connect flow
  const [connectModal, setConnectModal] = useState(false);
  const [deviceCode, setDeviceCode] = useState<{ user_code: string; verification_url: string } | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const connectPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [loading, setLoading] = useState(true);

  // Haiku horizontal scroll page (0 = today, 1+ = past years newest→oldest)
  const [haikuPage, setHaikuPage] = useState(0);
  const haikuScrollRef = useRef<ScrollView>(null);

  // Cal view paged scroll ref
  const calViewScrollRef = useRef<ScrollView>(null);

  // After 8pm, default to showing tomorrow
  const isAfter8pm = new Date().getHours() >= 20;
  const agendaStartKey = isAfter8pm
    ? (() => { const d = new Date(); d.setDate(d.getDate() + 1); return d.toISOString().slice(0, 10); })()
    : today;

  // Write mode
  const [writing, setWriting] = useState(false);
  const [haikuLines, setHaikuLines] = useState(['', '', '']);
  const [saving, setSaving] = useState(false);

  // Animations
  const writeBgOpacity = useRef(new Animated.Value(0)).current;
  const writeContentOpacity = useRef(new Animated.Value(0)).current;
  const mainOpacity = useRef(new Animated.Value(1)).current;

  // Haiku breathing animation (for empty state)
  const breathAnim = useRef(new Animated.Value(0.3)).current;

  // ── Effects ─────────────────────────────────────────────────────────────────

  // Haiku breathing animation (3s loop)
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(breathAnim, { toValue: 0.5, duration: 1500, useNativeDriver: true }),
        Animated.timing(breathAnim, { toValue: 0.3, duration: 1500, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [breathAnim]);

  // ── Calendar connect (device code flow) ──────────────────────────────────────

  const startCalendarConnect = useCallback(async () => {
    setConnectError(null);
    setDeviceCode(null);
    setConnectModal(true);
    try {
      const r = await apiFetch('/calendar/auth/device/start', { method: 'POST' });
      const d = await r.json() as { user_code?: string; verification_url?: string; error?: string };
      if (!r.ok || d.error) { setConnectError(d.error ?? 'Failed to start'); return; }
      setDeviceCode({ user_code: d.user_code!, verification_url: d.verification_url! });

      // Poll until connected
      if (connectPollRef.current) clearInterval(connectPollRef.current);
      connectPollRef.current = setInterval(async () => {
        try {
          const sr = await apiFetch('/calendar/auth/device/status');
          const sd = await sr.json() as { connected: boolean };
          if (sd.connected) {
            clearInterval(connectPollRef.current!); connectPollRef.current = null;
            setConnectModal(false);
            setCalendarConnected(true);
            // Reload events
            const cr = await apiFetch(`/calendar/range?start=${agendaStartKey}&days=7`);
            if (cr.ok) {
              const cd = await cr.json() as { days: AgendaDay[] };
              setAgendaDays(cd.days ?? []);
            }
          }
        } catch {}
      }, 3000);
    } catch (err: any) {
      setConnectError(err?.message === 'Not connected' ? 'App not connected to server yet. Try again in a moment.' : 'Could not reach server');
    }
  }, [agendaStartKey]);

  // ── Save journal ────────────────────────────────────────────────────────────

  const saveJournal = useCallback(async (currentHaiku: string, currentTasks: Task[]) => {
    const content = buildFileContent(today, currentHaiku, currentTasks);
    try {
      await apiFetch('/wiki/file', {
        method: 'POST',
        body: JSON.stringify({ path: `journal/${today}.md`, content }),
      });
    } catch {
      // silently fail on background saves
    }
  }, [today]);

  // ── Calendar refresh ────────────────────────────────────────────────────────

  const refreshCalendar = useCallback(async () => {
    setCalRefreshing(true);
    try {
      const r = await apiFetch(`/calendar/range?start=${agendaStartKey}&days=7`);
      if (!r.ok) { setCalendarConnected(false); return; }
      const d = await r.json() as { days: AgendaDay[] };
      setAgendaDays(d.days ?? []);
      setCalendarConnected(true);
    } catch { setCalendarConnected(false); }
    finally { setCalRefreshing(false); }
  }, [agendaStartKey]);

  // Auto-refresh when agent creates/updates/deletes a calendar event
  useEffect(() => {
    if (calendarVersion > 0) refreshCalendar();
  }, [calendarVersion]);

  // ── Save phrase ─────────────────────────────────────────────────────────────

  const savePhrase = useCallback(async (text: string) => {
    if (!text.trim()) return;
    try {
      await apiFetch('/wiki/file', {
        method: 'POST',
        body: JSON.stringify({ path: `phrases/week-${weekKey()}.md`, content: text.trim() }),
      });
      setPhraseOfWeek(text.trim());
    } catch {}
  }, []);

  // ── Rhythms (fetchDueRhythms declared here so it's available to the mount effect) ──

  const fetchDueRhythms = useCallback(async () => {
    try {
      const r = await apiFetch(`/rhythms/due?date=${todayKey()}`);
      const d = await r.json();
      setDueRhythms(d.rhythms ?? []);
    } catch {}
  }, []);

  // ── Load data ───────────────────────────────────────────────────────────────

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const todayMM_DD = today.slice(5); // MM-DD

      // yesterday using local date methods (not toISOString which is UTC)
      const yesterdayKey = (() => {
        const d = new Date();
        d.setDate(d.getDate() - 1);
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
      })();

      const carryOverTasks = async () => {
        const yr = await apiFetch(`/wiki/file?path=${encodeURIComponent(`journal/${yesterdayKey}.md`)}`).catch(() => null);
        if (!yr?.ok) return;
        const yd = await yr.json() as { content: string };
        const carried = extractTasks(yd.content).filter((t) => !t.done).map((t) => ({ ...t, carriedOver: true as const }));
        if (carried.length > 0) setTasks(carried);
      };

      const todayPromise = apiFetch(`/wiki/file?path=${encodeURIComponent(`journal/${today}.md`)}`)
        .then(async (r) => {
          if (!r.ok) {
            await carryOverTasks();
            return;
          }
          const d = await r.json() as { content: string };
          setHaiku(extractHaiku(d.content));
          const todayTasks = extractTasks(d.content);
          if (todayTasks.length > 0) {
            setTasks(todayTasks);
          } else {
            await carryOverTasks();
          }
        })
        .catch(() => {});

      const treePromise = apiFetch('/wiki/tree?path=journal')
        .then(async (r) => {
          if (!r.ok) return;
          const d = await r.json() as { entries: { name: string; path: string; isDir: boolean }[] };
          const pastFiles = d.entries.filter((e) =>
            !e.isDir &&
            e.name.endsWith('.md') &&
            e.name !== 'README.md' &&
            !e.name.startsWith('_') &&
            e.name.replace('.md', '') !== today &&
            e.name.slice(5, 10) === todayMM_DD,
          );
          const pastResults = await Promise.all(
            pastFiles.map(async (f) => {
              const year = f.name.slice(0, 4);
              try {
                const fr = await apiFetch(`/wiki/file?path=${encodeURIComponent(f.path)}`);
                const fd = await fr.json() as { content: string };
                const text = extractHaiku(fd.content);
                return text ? { year, text } : null;
              } catch {
                return null;
              }
            }),
          );
          const map: Record<string, string> = {};
          for (const r of pastResults) {
            if (r) map[r.year] = r.text;
          }
          setPastHaikuMap(map);
        })
        .catch(() => {});

      const calPromise = apiFetch(`/calendar/range?start=${agendaStartKey}&days=7`)
        .then(async (r) => {
          if (!r.ok) { setCalendarConnected(false); return; }
          const d = await r.json() as { days: AgendaDay[] };
          setAgendaDays(d.days ?? []);
          setCalendarConnected(true);
        })
        .catch(() => { setCalendarConnected(false); });

      const inboxPromise = apiFetch(`/wiki/file?path=${encodeURIComponent('tasks/inbox.md')}`)
        .then(async (r) => {
          if (!r.ok) return;
          const d = await r.json() as { content: string };
          setInboxTasks(extractInboxTasks(d.content));
        })
        .catch(() => {});

      const phrasePromise = apiFetch(`/wiki/file?path=${encodeURIComponent(`phrases/week-${weekKey()}.md`)}`)
        .then(async (r) => {
          if (!r.ok) return;
          const d = await r.json() as { content: string };
          setPhraseOfWeek(d.content.trim());
        })
        .catch(() => {});

      await Promise.all([todayPromise, treePromise, calPromise, inboxPromise, phrasePromise]);
    } finally {
      setLoading(false);
    }
  }, [today]);

  useEffect(() => { if (connected) { loadData(); fetchDueRhythms(); } }, [connected, loadData, fetchDueRhythms]);

  // Fallback for web: reload on focus in case the connected effect fired before the component settled
  useFocusEffect(useCallback(() => {
    if (connected) { loadData(); fetchDueRhythms(); }
  }, [connected, loadData, fetchDueRhythms]));

  useEffect(() => {
    return () => {
      if (connectPollRef.current) {
        clearInterval(connectPollRef.current);
        connectPollRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!loading) {
      // Scroll to today (rightmost page)
      const lastIdx = 2; // year-2, year-1, today
      haikuScrollRef.current?.scrollTo({ x: lastIdx * SCREEN_WIDTH, animated: false });
      setHaikuPage(lastIdx);
    }
  }, [loading]);

  // ── Derived data ─────────────────────────────────────────────────────────────

  const currentYear = new Date().getFullYear();

  // Today is rightmost (page 2); swipe right to reveal older years on the left
  const haikuPages = [
    { year: String(currentYear - 2), haiku: pastHaikuMap[String(currentYear - 2)] ?? '', isPlaceholder: !pastHaikuMap[String(currentYear - 2)] },
    { year: String(currentYear - 1), haiku: pastHaikuMap[String(currentYear - 1)] ?? '', isPlaceholder: !pastHaikuMap[String(currentYear - 1)] },
    { year: '', haiku: haiku, isPlaceholder: false },
  ];

  const taskDone = tasks.filter((t) => t.done).length;
  const taskTotal = tasks.length;

  // Current time string for the "now" indicator in day view
  const nowStr = currentTimeString();

  // ── Write mode ──────────────────────────────────────────────────────────────

  const openWriteMode = useCallback(() => {
    const lines = haiku.split('\n');
    setHaikuLines([lines[0] ?? '', lines[1] ?? '', lines[2] ?? '']);
    setSaving(false);
    setWriting(true);
    Animated.parallel([
      Animated.timing(writeBgOpacity, { toValue: 1, duration: 300, useNativeDriver: true }),
      Animated.timing(mainOpacity, { toValue: 0, duration: 250, useNativeDriver: true }),
    ]).start(() => {
      Animated.timing(writeContentOpacity, { toValue: 1, duration: 200, useNativeDriver: true }).start();
    });
  }, [haiku, writeBgOpacity, mainOpacity, writeContentOpacity]);

  const closeWriteMode = useCallback(() => {
    Animated.parallel([
      Animated.timing(writeContentOpacity, { toValue: 0, duration: 180, useNativeDriver: true }),
      Animated.timing(writeBgOpacity, { toValue: 0, duration: 300, useNativeDriver: true }),
      Animated.timing(mainOpacity, { toValue: 1, duration: 300, useNativeDriver: true }),
    ]).start(() => {
      setWriting(false);
    });
  }, [writeContentOpacity, writeBgOpacity, mainOpacity]);

  const saveHaiku = useCallback(async () => {
    const newHaiku = haikuLines.join('\n');
    if (!newHaiku.trim()) { closeWriteMode(); return; }
    setSaving(true);
    try {
      await saveJournal(newHaiku, tasks);
      setHaiku(newHaiku);
      await impact();
    } catch {
      // silently fail
    } finally {
      setSaving(false);
      closeWriteMode();
    }
  }, [haikuLines, tasks, saveJournal, closeWriteMode]);

  // ── Tasks ───────────────────────────────────────────────────────────────────

  const toggleTask = useCallback(async (index: number) => {
    await impact();
    const updated = tasks.map((t, i) => i === index ? { ...t, done: !t.done } : t);
    setTasks(updated);
    await saveJournal(haiku, updated);
  }, [tasks, haiku, saveJournal]);

  const addTask = useCallback(async () => {
    const text = newTaskText.trim();
    if (!text) return;
    const updated = [...tasks, { text, done: false }];
    setTasks(updated);
    setNewTaskText('');
    await saveJournal(haiku, updated);
  }, [newTaskText, tasks, haiku, saveJournal]);

  const startEditTask = useCallback((index: number) => {
    setEditingText(tasks[index].text);
    setEditingTaskIndex(index);
  }, [tasks]);

  const saveEditTask = useCallback(async (index: number) => {
    if (editingTaskIndex !== index) return; // guard against double-fire
    const text = editingText.trim();
    if (!text) { setEditingTaskIndex(null); return; }
    const updated = tasks.map((t, i) => i === index ? { ...t, text } : t);
    setTasks(updated);
    setEditingTaskIndex(null);
    await saveJournal(haiku, updated);
  }, [editingTaskIndex, editingText, tasks, haiku, saveJournal]);

  const deleteTask = useCallback(async (index: number) => {
    await impact();
    const updated = tasks.filter((_, i) => i !== index);
    setTasks(updated);
    setEditingTaskIndex(null);
    await saveJournal(haiku, updated);
  }, [tasks, haiku, saveJournal]);

  const cyclePriority = useCallback(async (index: number) => {
    await impact();
    const current = tasks[index].priority;
    const next: 1 | 2 | 3 | undefined = current === undefined ? 1 : current === 1 ? 2 : current === 2 ? 3 : undefined;
    const updated = tasks.map((t, i) => i === index ? { ...t, priority: next } : t);
    setTasks(updated);
    await saveJournal(haiku, updated);
  }, [tasks, haiku, saveJournal]);

  const saveInbox = useCallback(async (current: Task[]) => {
    try {
      await apiFetch('/wiki/file', {
        method: 'POST',
        body: JSON.stringify({ path: 'tasks/inbox.md', content: buildInboxContent(current) }),
      });
    } catch {}
  }, []);

  const deleteInboxTask = useCallback(async (index: number) => {
    await impact();
    const updated = inboxTasks.filter((_, i) => i !== index);
    setInboxTasks(updated);
    await saveInbox(updated);
  }, [inboxTasks, saveInbox]);

  const clearDone = useCallback(async () => {
    const remaining = tasks.filter(t => !t.done);
    if (remaining.length === tasks.length) return;
    await impact();
    setTasks(remaining);
    await saveJournal(haiku, remaining);
  }, [tasks, haiku, saveJournal]);

  const toggleInboxTask = useCallback(async (index: number) => {
    await impact();
    const updated = inboxTasks.map((t, i) => i === index ? { ...t, done: !t.done } : t);
    setInboxTasks(updated);
    await saveInbox(updated);
  }, [inboxTasks, saveInbox]);

  const moveToToday = useCallback(async (index: number) => {
    await impact();
    const task = inboxTasks[index];
    const updatedInbox = inboxTasks.filter((_, i) => i !== index);
    const updatedTasks = [...tasks, { text: task.text, done: false }];
    setInboxTasks(updatedInbox);
    setTasks(updatedTasks);
    await Promise.all([saveInbox(updatedInbox), saveJournal(haiku, updatedTasks)]);
  }, [inboxTasks, tasks, haiku, saveInbox, saveJournal]);

  const resetTasks = useCallback(() => {
    Alert.alert(
      'Reset tasks',
      'Clear all tasks for today? This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Reset', style: 'destructive', onPress: async () => {
          await impact();
          setTasks([]);
          await saveJournal(haiku, []);
        }},
      ]
    );
  }, [haiku, saveJournal]);

  // ── Rhythms (remaining callbacks) ───────────────────────────────────────────

  const fetchAllRhythms = useCallback(async () => {
    try {
      const r = await apiFetch('/rhythms');
      const d = await r.json();
      setAllRhythms(Array.isArray(d) ? d : []);
    } catch {}
  }, []);

  const completeRhythm = useCallback(async (id: string) => {
    try {
      await apiFetch(`/rhythms/${id}/complete`, { method: 'POST' });
      fetchDueRhythms();
    } catch {}
  }, [fetchDueRhythms]);

  const deleteRhythm = useCallback(async (id: string) => {
    try {
      await apiFetch(`/rhythms/${id}`, { method: 'DELETE' });
      fetchAllRhythms();
      fetchDueRhythms();
    } catch {}
  }, [fetchAllRhythms, fetchDueRhythms]);

  const saveRhythm = useCallback(async () => {
    if (!rhythmForm.title.trim()) return;
    const schedule =
      rhythmForm.type === 'daily' ? {} :
      rhythmForm.type === 'every-n-days' ? { n: rhythmForm.n } :
      rhythmForm.type === 'every-n-weeks' ? { n: rhythmForm.n } :
      rhythmForm.type === 'weekly' ? { days: rhythmForm.days.length ? rhythmForm.days : [0] } :
      rhythmForm.type === 'monthly' ? { dayOfMonth: rhythmForm.dayOfMonth } :
      { month: rhythmForm.month, day: rhythmForm.day };
    try {
      await apiFetch('/rhythms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: rhythmForm.title.trim(), type: rhythmForm.type, schedule, description: rhythmForm.description }),
      });
      setRhythmForm(f => ({ ...f, visible: false, title: '', description: '' }));
      fetchAllRhythms();
      fetchDueRhythms();
    } catch {}
  }, [rhythmForm, fetchAllRhythms, fetchDueRhythms]);

  // ── Haiku scroll handler ─────────────────────────────────────────────────────

  const handleHaikuScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const page = Math.round(e.nativeEvent.contentOffset.x / SCREEN_WIDTH);
    setHaikuPage(page);
  }, []);

  // ── Cal view scroll handler (swipeable day/week) ─────────────────────────────

  const handleCalViewScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const page = Math.round(e.nativeEvent.contentOffset.x / SCREEN_WIDTH);
    setCalendarView(page === 0 ? 'day' : 'week');
  }, []);

  const switchCalView = useCallback((view: 'day' | 'week') => {
    setCalendarView(view);
    calViewScrollRef.current?.scrollTo({ x: view === 'week' ? SCREEN_WIDTH : 0, animated: true });
  }, []);

  const todoSwipe = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) =>
        Math.abs(g.dx) > 12 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
      onPanResponderRelease: (_, g) => {
        if (g.dx < -40) router.replace('/(tabs)/mentor');
      },
    })
  ).current;

  // ── Loading state ───────────────────────────────────────────────────────────

  if (loading) {
    return (
      <View style={[styles.root, { paddingTop: insets.top, backgroundColor: theme.bg }]}>
        <View style={[styles.centered, { backgroundColor: theme.bg }]}>
          <ActivityIndicator color={ACCENT} />
        </View>
      </View>
    );
  }

  // ── Sorted tasks for rendering ───────────────────────────────────────────────

  const sortedTasks = tasks
    .map((t, i) => ({ ...t, _i: i }))
    .filter(t => !t.carriedOver)
    .sort((a, b) => {
      if (a.done !== b.done) return a.done ? 1 : -1;
      const pa = a.priority ?? 99;
      const pb = b.priority ?? 99;
      return pa - pb;
    });

  const sortedCarriedOver = tasks
    .map((t, i) => ({ ...t, _i: i }))
    .filter(t => t.carriedOver)
    .sort((a, b) => {
      if (a.done !== b.done) return a.done ? 1 : -1;
      const pa = a.priority ?? 99;
      const pb = b.priority ?? 99;
      return pa - pb;
    });

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <View style={[styles.root, { paddingTop: insets.top, backgroundColor: theme.bg }]}>
      {/* ── Fixed persona header (always visible, outside fade) ───── */}
      <View style={[styles.header, { borderBottomColor: theme.border }]}>
        <TouchableOpacity
          onLongPress={() => { setSettingsSection('model'); setSettingsVisible(true); }}
          activeOpacity={0.7}
        >
          <Text style={styles.headerTitle}>{`${getModeEmoji('tracker', modes)} ${getModeName('tracker', modes)}`}</Text>
        </TouchableOpacity>
        <View style={styles.headerTitleWrap} pointerEvents="none">
          <Text style={[styles.headerDate, { color: theme.textDim }]}>{formatHeaderDate()}</Text>
        </View>
        <View style={styles.headerControls}>
          <TouchableOpacity onPress={toggleTheme} style={styles.headerBtn} activeOpacity={0.7}>
            <Text style={styles.headerBtnLabel}>{isDark ? '🌙' : '☀️'}</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* ── Hourly digest banner ───────────────────────────────── */}
      {calDigest ? (
        <TouchableOpacity
          style={[styles.digestBanner, { backgroundColor: ACCENT + '18', borderColor: ACCENT + '40' }]}
          onPress={() => setCalDigest(null)}
          activeOpacity={0.8}
        >
          <Text style={[styles.digestText, { color: theme.text }]}>{calDigest}</Text>
          <Text style={[styles.digestDismiss, { color: ACCENT }]}>dismiss</Text>
        </TouchableOpacity>
      ) : null}

      {/* ── Phrase of the week ───────────────────────────────────── */}
      <View style={[styles.phraseRow, { backgroundColor: ACCENT + '18', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: ACCENT + '40' }]}>
        {editingPhrase ? (
          <TextInput
            style={[styles.phraseInput, { color: theme.text, borderBottomColor: ACCENT }]}
            value={phraseDraft}
            onChangeText={setPhraseDraft}
            placeholder="phrase of the week…"
            placeholderTextColor={theme.textFaint}
            autoFocus
            returnKeyType="done"
            onSubmitEditing={async () => {
              await savePhrase(phraseDraft);
              setEditingPhrase(false);
            }}
            onBlur={async () => {
              if (phraseDraft.trim()) await savePhrase(phraseDraft);
              setEditingPhrase(false);
            }}
            multiline={false}
          />
        ) : (
          <TouchableOpacity
            onPress={() => { setPhraseDraft(phraseOfWeek); setEditingPhrase(true); }}
            activeOpacity={0.7}
            style={styles.phraseTouchable}
          >
            <Text style={[styles.phraseText, { color: phraseOfWeek ? theme.text : theme.textFaint }]}>
              {phraseOfWeek || 'phrase of the week…'}
            </Text>
          </TouchableOpacity>
        )}
      </View>

      {/* ── Main content (fades out in write mode) ─────────────────── */}
      <Animated.View style={[styles.flex, { opacity: mainOpacity }]}>

        {/* ════════════════════════════════════════════════════════════
            PANEL 1 — CALENDAR  (fixed height)
        ════════════════════════════════════════════════════════════ */}
        <View style={[styles.calPanel, { backgroundColor: ACCENT + '07' }]}>
          {calendarConnected ? (
            <View style={[styles.calViewToggle, { justifyContent: 'space-between' }]}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <TouchableOpacity onPress={() => switchCalView('day')} activeOpacity={0.7}>
                  <Text style={[styles.calViewToggleLabel, { color: calendarView === 'day' ? ACCENT : theme.textDim }]}>day</Text>
                </TouchableOpacity>
                <Text style={[styles.calViewToggleSep, { color: theme.textFaint }]}>·</Text>
                <TouchableOpacity onPress={() => switchCalView('week')} activeOpacity={0.7}>
                  <Text style={[styles.calViewToggleLabel, { color: calendarView === 'week' ? ACCENT : theme.textDim }]}>week</Text>
                </TouchableOpacity>
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                <TouchableOpacity onPress={refreshCalendar} activeOpacity={0.7} disabled={calRefreshing}>
                  {calRefreshing
                    ? <ActivityIndicator size="small" color={ACCENT} />
                    : <Text style={{ color: theme.textDim, fontSize: 16 }}>↻</Text>}
                </TouchableOpacity>
                <TouchableOpacity onPress={async () => {
                  await apiFetch('/calendar/auth', { method: 'DELETE' });
                  setCalendarConnected(false);
                  setAgendaDays([]);
                }} activeOpacity={0.7}>
                  <Text style={{ color: theme.textFaint, fontSize: 11 }}>disconnect</Text>
                </TouchableOpacity>
              </View>
            </View>
          ) : null}
          {/* Calendar scroll area — horizontal paged: page 0 = day, page 1 = week */}
          <ScrollView
            ref={calViewScrollRef}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            onScroll={handleCalViewScroll}
            scrollEventThrottle={16}
            style={styles.calScroll}
          >
            {/* Page 0: day view */}
            <ScrollView
              style={{ width: SCREEN_WIDTH }}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
            >
              {!calendarConnected ? (
                <TouchableOpacity onPress={startCalendarConnect} activeOpacity={0.7}>
                  <Text style={[styles.connectCalendar, { color: ACCENT, opacity: 0.7 }]}>connect calendar</Text>
                </TouchableOpacity>
              ) : agendaDays.slice(0, 1).length === 0 ? (
                <Text style={[styles.nothingScheduled, { color: theme.textFaint }]}>nothing scheduled</Text>
              ) : (
                agendaDays.slice(0, 1).map((day) => {
                  let nowInsertedBefore: number | null = null;
                  if (day.events.length > 0) {
                    const idx = day.events.findIndex((ev) => ev.time >= nowStr);
                    if (idx > 0) nowInsertedBefore = idx;
                  }
                  return (
                    <View key={day.date}>
                      {day.events.length === 0 ? (
                        <Text style={[styles.nothingScheduled, { color: theme.textFaint }]}>nothing scheduled</Text>
                      ) : (
                        day.events.map((ev, i) => (
                          <View key={i}>
                            {nowInsertedBefore === i && (
                              <View style={styles.nowRow}>
                                <View style={styles.nowLine} />
                                <Text style={styles.nowLabel}>▸ now</Text>
                              </View>
                            )}
                            <View style={styles.agendaRow}>
                              <Text style={[styles.agendaTime, { color: theme.textDim }]}>{ev.time}</Text>
                              <Text style={[styles.agendaTitle, { color: theme.text }]}>{ev.title}</Text>
                            </View>
                          </View>
                        ))
                      )}
                    </View>
                  );
                })
              )}
            </ScrollView>

            {/* Page 1: week view */}
            <ScrollView
              style={{ width: SCREEN_WIDTH }}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
            >
              {!calendarConnected ? (
                <TouchableOpacity onPress={startCalendarConnect} activeOpacity={0.7}>
                  <Text style={[styles.connectCalendar, { color: ACCENT, opacity: 0.7 }]}>connect calendar</Text>
                </TouchableOpacity>
              ) : agendaDays.length === 0 ? (
                <Text style={[styles.nothingScheduled, { color: theme.textFaint }]}>nothing scheduled</Text>
              ) : (
                agendaDays.map((day) => (
                  <View key={day.date}>
                    <Text
                      style={[
                        styles.dayLabel,
                        { color: theme.textDim },
                        day.date === today && { color: ACCENT },
                      ]}
                    >
                      {day.shortLabel}
                    </Text>
                    {day.events.length === 0 ? (
                      <Text style={[styles.nothingScheduled, { color: theme.textFaint }]}>nothing scheduled</Text>
                    ) : (
                      day.events.map((ev, i) => (
                        <View key={i} style={styles.agendaRow}>
                          <Text style={[styles.agendaTime, { color: theme.textDim }]}>{ev.time}</Text>
                          <Text style={[styles.agendaTitle, { color: theme.text }]}>{ev.title}</Text>
                        </View>
                      ))
                    )}
                  </View>
                ))
              )}
            </ScrollView>
          </ScrollView>
        </View>

        {/* Hairline between calendar and todo */}
        <View style={[styles.panelHairline, { backgroundColor: theme.border }]} />

        {/* ════════════════════════════════════════════════════════════
            PANEL 2 — TO-DO  (flex: 1)
        ════════════════════════════════════════════════════════════ */}
        <View style={[styles.todoPanel, { backgroundColor: ACCENT + '0D' }]} {...todoSwipe.panHandlers}>
          {/* Section header */}
          <View style={styles.todoPanelHeader}>
            <Text style={[styles.sectionLabel, { color: theme.textDim }]}>to-do</Text>
            <View style={styles.todoActions}>
              {taskTotal > 0 && <Text style={[styles.taskCount, { color: theme.textFaint }]}>{taskDone}/{taskTotal}</Text>}
              {tasks.some(t => t.done) && (
                <TouchableOpacity onPress={clearDone} activeOpacity={0.7}>
                  <Text style={styles.todoActionBtn}>clear</Text>
                </TouchableOpacity>
              )}
              {taskTotal > 0 && (
                <TouchableOpacity onPress={resetTasks} activeOpacity={0.7}>
                  <Text style={styles.todoActionBtn}>reset</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>

          {/* Scrollable task list + add input */}
          <ScrollView
            style={styles.flex}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
            {/* Prioritized tasks (p1–p3) */}
            {sortedTasks.filter(t => t.priority !== undefined).map((item) => (
              <View key={item._i} style={styles.taskRow}>
                <TouchableOpacity onPress={() => cyclePriority(item._i)} activeOpacity={0.7} style={styles.priorityDot}>
                  <View style={[styles.priorityDotInner, { backgroundColor: item.priority ? PRIORITY_COLORS[item.priority] : 'transparent', borderColor: item.priority ? PRIORITY_COLORS[item.priority] : theme.border }]} />
                </TouchableOpacity>
                <TouchableOpacity onPress={() => editingTaskIndex !== item._i && toggleTask(item._i)} activeOpacity={0.7}>
                  <Text style={[styles.taskCircle, { color: theme.text }, item.done && styles.taskCircleDone]}>
                    {item.done ? '●' : '◯'}
                  </Text>
                </TouchableOpacity>
                {editingTaskIndex === item._i ? (
                  <>
                    <TextInput
                      style={[styles.taskText, styles.taskTextFlex, styles.taskEditInput, { color: theme.text }]}
                      value={editingText}
                      onChangeText={setEditingText}
                      onBlur={() => saveEditTask(item._i)}
                      onSubmitEditing={() => saveEditTask(item._i)}
                      autoFocus
                      returnKeyType="done"
                    />
                    <TouchableOpacity onPress={() => deleteTask(item._i)} activeOpacity={0.7} style={styles.taskDeleteBtn}>
                      <Text style={[styles.taskDeleteLabel, { color: theme.textFaint }]}>✕</Text>
                    </TouchableOpacity>
                  </>
                ) : (
                  <TouchableOpacity
                    style={styles.flex}
                    onPress={() => toggleTask(item._i)}
                    onLongPress={() => startEditTask(item._i)}
                    activeOpacity={0.7}
                  >
                    <Text style={[
                      styles.taskText,
                      { color: item.priority && !item.done ? PRIORITY_COLORS[item.priority] : theme.text },
                      item.done && styles.taskTextDone
                    ]}>
                      {item.text}
                    </Text>
                  </TouchableOpacity>
                )}
              </View>
            ))}

            {/* Rhythms section — between prioritized and unprioritized */}
            <View>
              <View style={[styles.sectionDivider, { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }]}>
                <Text style={[styles.sectionDividerLabel, { color: theme.textFaint }]}>rhythms</Text>
                <TouchableOpacity onPress={() => { setRhythmsModalVisible(true); fetchAllRhythms(); }}>
                  <Text style={{ fontSize: 12, color: RHYTHM_COLOR }}>Manage →</Text>
                </TouchableOpacity>
              </View>
              {dueRhythms.length === 0 && (
                <TouchableOpacity onPress={() => { setRhythmsModalVisible(true); fetchAllRhythms(); }} style={{ paddingVertical: 6 }}>
                  <Text style={[styles.taskText, { color: theme.textDim, opacity: 0.35 }]}>No rhythms due — tap Manage to add</Text>
                </TouchableOpacity>
              )}
              {dueRhythms.map(r => (
                <View key={r.id} style={styles.taskRow}>
                  <View style={styles.priorityDot}>
                    <View style={[styles.priorityDotInner, { backgroundColor: RHYTHM_COLOR, borderColor: RHYTHM_COLOR }]} />
                  </View>
                  <TouchableOpacity onPress={() => completeRhythm(r.id)} activeOpacity={0.7}>
                    <Text style={[styles.taskCircle, { color: theme.text }, r.completed && styles.taskCircleDone]}>
                      {r.completed ? '●' : '◯'}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.flex} onPress={() => completeRhythm(r.id)} activeOpacity={0.7}>
                    <Text style={[styles.taskText, { color: RHYTHM_COLOR }, r.completed && styles.taskTextDone]}>
                      {r.title}
                    </Text>
                  </TouchableOpacity>
                </View>
              ))}
            </View>

            {/* Backlog (unprioritized tasks) */}
            {sortedTasks.filter(t => t.priority === undefined).length > 0 && (
              <View style={styles.sectionDivider}>
                <Text style={[styles.sectionDividerLabel, { color: theme.textFaint }]}>backlog</Text>
              </View>
            )}
            {sortedTasks.filter(t => t.priority === undefined).map((item) => (
              <View key={item._i} style={styles.taskRow}>
                <TouchableOpacity onPress={() => cyclePriority(item._i)} activeOpacity={0.7} style={styles.priorityDot}>
                  <View style={[styles.priorityDotInner, { backgroundColor: 'transparent', borderColor: theme.border }]} />
                </TouchableOpacity>
                <TouchableOpacity onPress={() => editingTaskIndex !== item._i && toggleTask(item._i)} activeOpacity={0.7}>
                  <Text style={[styles.taskCircle, { color: theme.text }, item.done && styles.taskCircleDone]}>
                    {item.done ? '●' : '◯'}
                  </Text>
                </TouchableOpacity>
                {editingTaskIndex === item._i ? (
                  <>
                    <TextInput
                      style={[styles.taskText, styles.taskTextFlex, styles.taskEditInput, { color: theme.text }]}
                      value={editingText}
                      onChangeText={setEditingText}
                      onBlur={() => saveEditTask(item._i)}
                      onSubmitEditing={() => saveEditTask(item._i)}
                      autoFocus
                      returnKeyType="done"
                    />
                    <TouchableOpacity onPress={() => deleteTask(item._i)} activeOpacity={0.7} style={styles.taskDeleteBtn}>
                      <Text style={[styles.taskDeleteLabel, { color: theme.textFaint }]}>✕</Text>
                    </TouchableOpacity>
                  </>
                ) : (
                  <TouchableOpacity
                    style={styles.flex}
                    onPress={() => toggleTask(item._i)}
                    onLongPress={() => startEditTask(item._i)}
                    activeOpacity={0.7}
                  >
                    <Text style={[styles.taskText, { color: theme.text }, item.done && styles.taskTextDone]}>
                      {item.text}
                    </Text>
                  </TouchableOpacity>
                )}
              </View>
            ))}

            {/* Carried-over section */}
            {sortedCarriedOver.length > 0 && (
              <>
                <View style={styles.sectionDivider}>
                  <Text style={[styles.sectionDividerLabel, { color: theme.textFaint }]}>from yesterday</Text>
                </View>
                {sortedCarriedOver.map((item) => (
                  <View key={item._i} style={styles.taskRow}>
                    <TouchableOpacity onPress={() => cyclePriority(item._i)} activeOpacity={0.7} style={styles.priorityDot}>
                      <View style={[styles.priorityDotInner, { backgroundColor: item.priority ? PRIORITY_COLORS[item.priority] : 'transparent', borderColor: item.priority ? PRIORITY_COLORS[item.priority] : theme.border }]} />
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => editingTaskIndex !== item._i && toggleTask(item._i)} activeOpacity={0.7}>
                      <Text style={[styles.taskCircle, { color: theme.text }, item.done && styles.taskCircleDone]}>
                        {item.done ? '●' : '◯'}
                      </Text>
                    </TouchableOpacity>
                    {editingTaskIndex === item._i ? (
                      <>
                        <TextInput
                          style={[styles.taskText, styles.taskTextFlex, styles.taskEditInput, { color: theme.text }]}
                          value={editingText}
                          onChangeText={setEditingText}
                          onBlur={() => saveEditTask(item._i)}
                          onSubmitEditing={() => saveEditTask(item._i)}
                          autoFocus
                          returnKeyType="done"
                        />
                        <TouchableOpacity onPress={() => deleteTask(item._i)} activeOpacity={0.7} style={styles.taskDeleteBtn}>
                          <Text style={[styles.taskDeleteLabel, { color: theme.textFaint }]}>✕</Text>
                        </TouchableOpacity>
                      </>
                    ) : (
                      <TouchableOpacity
                        style={styles.flex}
                        onPress={() => toggleTask(item._i)}
                        onLongPress={() => startEditTask(item._i)}
                        activeOpacity={0.7}
                      >
                        <Text style={[
                          styles.taskText,
                          { color: item.priority && !item.done ? PRIORITY_COLORS[item.priority] : theme.text },
                          item.done && styles.taskTextDone
                        ]}>
                          {item.text}
                        </Text>
                      </TouchableOpacity>
                    )}
                  </View>
                ))}
              </>
            )}

            {/* Inbox section */}
            {inboxTasks.length > 0 && (
              <>
                <View style={styles.sectionDivider}>
                  <Text style={[styles.sectionDividerLabel, { color: theme.textFaint }]}>inbox</Text>
                </View>
                {inboxTasks.map((task, i) => (
                  <View key={i} style={styles.taskRow}>
                    <TouchableOpacity onPress={() => toggleInboxTask(i)} activeOpacity={0.7}>
                      <Text style={[styles.taskCircle, { color: theme.text }, task.done && styles.taskCircleDone]}>
                        {task.done ? '●' : '◯'}
                      </Text>
                    </TouchableOpacity>
                    <Text style={[styles.taskText, { color: theme.text }, task.done && styles.taskTextDone, styles.taskTextFlex]}>
                      {task.text}
                    </Text>
                    <TouchableOpacity onPress={() => moveToToday(i)} activeOpacity={0.7} style={styles.inboxMoveBtn}>
                      <Text style={[styles.inboxMoveBtnLabel, { color: ACCENT }]}>→ today</Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => deleteInboxTask(i)} activeOpacity={0.7} style={styles.taskDeleteBtn}>
                      <Text style={[styles.taskDeleteLabel, { color: theme.textFaint }]}>✕</Text>
                    </TouchableOpacity>
                  </View>
                ))}
              </>
            )}

            <TextInput
              style={[styles.addInput, { color: theme.text }]}
              value={newTaskText}
              onChangeText={setNewTaskText}
              placeholder="+ add a task"
              placeholderTextColor={theme.textFaint}
              returnKeyType="done"
              onSubmitEditing={addTask}
            />
          </ScrollView>
        </View>

        {/* Hairline between todo and haiku */}
        <View style={[styles.panelHairline, { backgroundColor: theme.border }]} />

        {/* ════════════════════════════════════════════════════════════
            PANEL 3 — HAIKU  (fixed height, horizontal paging)
        ════════════════════════════════════════════════════════════ */}
        <View style={[styles.haikuPanel, { backgroundColor: ACCENT + '05' }]}>
          {/* Horizontal paged ScrollView */}
          <ScrollView
            ref={haikuScrollRef}
            horizontal
            pagingEnabled
            scrollEnabled
            showsHorizontalScrollIndicator={false}
            onScroll={handleHaikuScroll}
            scrollEventThrottle={16}
            style={styles.haikuScrollView}
          >
            {haikuPages.map((page, pageIdx) => {
              const isToday = pageIdx === haikuPages.length - 1;
              const hasRealHaiku = page.haiku.trim().length > 0;
              const prevYearHaiku = pastHaikuMap[String(currentYear - 1)];
              const hasPastYears = !!prevYearHaiku;

              return (
                <View key={pageIdx} style={[styles.haikuPage, { position: 'relative' }]}>
                  {/* Year label in top-right corner for past pages */}
                  {page.year ? (
                    <Text style={[styles.haikuYearCorner, { color: ACCENT }]}>{page.year}</Text>
                  ) : null}

                  {isToday ? (
                    hasRealHaiku ? (
                      /* Today: real haiku exists — show it, tap to edit */
                      <TouchableOpacity onPress={openWriteMode} activeOpacity={0.8} style={styles.haikuTouchable}>
                        <Text style={[styles.haikuText, { color: theme.text }]}>{page.haiku}</Text>
                      </TouchableOpacity>
                    ) : hasPastYears ? (
                      /* Today: empty, but past year exists — ghost the most recent */
                      <TouchableOpacity onPress={openWriteMode} activeOpacity={0.8} style={styles.haikuTouchable}>
                        <Text style={[styles.haikuItalic, { color: theme.text, opacity: 0.35 }]}>{prevYearHaiku}</Text>
                      </TouchableOpacity>
                    ) : (
                      /* Today: empty, no past years — breathing prompt */
                      <TouchableOpacity onPress={openWriteMode} activeOpacity={0.8} style={styles.haikuTouchable}>
                        <Animated.Text style={[styles.haikuEmpty, { opacity: breathAnim }]}>
                          write tonight's haiku
                        </Animated.Text>
                      </TouchableOpacity>
                    )
                  ) : (
                    /* Past year page */
                    <View style={styles.haikuTouchable}>
                      {page.isPlaceholder ? (
                        <Text style={[styles.haikuItalic, { color: theme.text, opacity: 0.2 }]}>{PLACEHOLDER_HAIKU}</Text>
                      ) : (
                        <Text style={[styles.haikuItalic, { color: theme.text, opacity: 0.7 }]}>{page.haiku}</Text>
                      )}
                    </View>
                  )}
                </View>
              );
            })}
          </ScrollView>

          {/* Page indicator dots */}
          {haikuPages.length > 1 && (
            <View style={styles.haikuDots}>
              {haikuPages.map((_, i) => (
                <View
                  key={i}
                  style={[
                    styles.haikuDot,
                    { backgroundColor: i === haikuPage ? ACCENT : theme.textFaint },
                  ]}
                />
              ))}
            </View>
          )}
        </View>

      </Animated.View>

      {/* ── Calendar connect modal ─────────────────────────────────────── */}
      {connectModal && (
        <View style={[StyleSheet.absoluteFill, styles.connectOverlay, { backgroundColor: theme.bg }]}>
          <TouchableOpacity style={styles.connectClose} onPress={() => {
            if (connectPollRef.current) { clearInterval(connectPollRef.current); connectPollRef.current = null; }
            setConnectModal(false);
          }} activeOpacity={0.7}>
            <Text style={[styles.connectCloseLabel, { color: theme.textDim }]}>cancel</Text>
          </TouchableOpacity>
          <Text style={[styles.connectTitle, { color: theme.text }]}>Connect Google Calendar</Text>
          {connectError ? (
            <Text style={[styles.connectHint, { color: '#FF6135' }]}>{connectError}</Text>
          ) : !deviceCode ? (
            <ActivityIndicator color={ACCENT} style={{ marginTop: 24 }} />
          ) : (
            <>
              <Text style={[styles.connectHint, { color: theme.textDim }]}>
                Open this URL in any browser:
              </Text>
              <Text style={[styles.connectUrl, { color: ACCENT }]}>{deviceCode.verification_url}</Text>
              <Text style={[styles.connectHint, { color: theme.textDim, marginTop: 20 }]}>
                Then enter this code:
              </Text>
              <Text style={[styles.connectCode, { color: theme.text, borderColor: theme.border }]}>
                {deviceCode.user_code}
              </Text>
              <Text style={[styles.connectWaiting, { color: theme.textFaint }]}>
                Waiting for approval…
              </Text>
            </>
          )}
        </View>
      )}

      {/* ── Write mode overlay ─────────────────────────────────────────── */}
      {writing && (
        <Animated.View style={[StyleSheet.absoluteFill, styles.writeOverlay, { opacity: writeBgOpacity, backgroundColor: theme.bg }]}>
          <KeyboardAvoidingView
            style={styles.flex}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          >
            <Animated.View style={[styles.writeContent, { opacity: writeContentOpacity }]}>
              {/* Done button */}
              <TouchableOpacity
                style={[styles.writeDoneBtn, { top: insets.top + 16 }]}
                onPress={saveHaiku}
                disabled={saving}
              >
                <Text style={styles.writeDoneLabel}>{saving ? '…' : 'done'}</Text>
              </TouchableOpacity>

              {/* Line 1 (5 syllables) */}
              <View style={styles.writeLineBlock}>
                <TextInput
                  style={[styles.writeInput, { color: theme.text }]}
                  value={haikuLines[0]}
                  onChangeText={(v) => setHaikuLines((l) => [v, l[1], l[2]])}
                  placeholder=""
                  placeholderTextColor={theme.textFaint}
                  autoFocus
                  returnKeyType="next"
                  multiline={false}
                  textAlign="center"
                />
                <Text style={[styles.syllableDots, { color: theme.textFaint }]}>· · · · ·</Text>
              </View>

              {/* Line 2 (7 syllables) */}
              <View style={styles.writeLineBlock}>
                <TextInput
                  style={[styles.writeInput, { color: theme.text }]}
                  value={haikuLines[1]}
                  onChangeText={(v) => setHaikuLines((l) => [l[0], v, l[2]])}
                  placeholder=""
                  placeholderTextColor={theme.textFaint}
                  returnKeyType="next"
                  multiline={false}
                  textAlign="center"
                />
                <Text style={[styles.syllableDots, { color: theme.textFaint }]}>· · · · · · ·</Text>
              </View>

              {/* Line 3 (5 syllables) */}
              <View style={styles.writeLineBlock}>
                <TextInput
                  style={[styles.writeInput, { color: theme.text }]}
                  value={haikuLines[2]}
                  onChangeText={(v) => setHaikuLines((l) => [l[0], l[1], v])}
                  placeholder=""
                  placeholderTextColor={theme.textFaint}
                  returnKeyType="done"
                  onSubmitEditing={saveHaiku}
                  multiline={false}
                  textAlign="center"
                />
                <Text style={[styles.syllableDots, { color: theme.textFaint }]}>· · · · ·</Text>
              </View>
            </Animated.View>
          </KeyboardAvoidingView>
        </Animated.View>
      )}

      {/* ── Rhythms modal ──────────────────────────────────────────────────── */}
      <Modal visible={rhythmsModalVisible} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setRhythmsModalVisible(false)}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <View style={{ flex: 1, backgroundColor: theme.bg }}>
          {/* Header */}
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16, paddingTop: 20, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border }}>
            <Text style={{ fontSize: 17, fontWeight: '600', color: theme.text }}>Rhythms</Text>
            <TouchableOpacity onPress={() => setRhythmsModalVisible(false)}>
              <Text style={{ fontSize: 15, color: ACCENT }}>Done</Text>
            </TouchableOpacity>
          </View>

          {/* List */}
          <FlatList
            data={allRhythms}
            keyExtractor={r => r.id}
            ListEmptyComponent={<Text style={{ textAlign: 'center', color: theme.text, opacity: 0.4, marginTop: 40 }}>No rhythms yet</Text>}
            renderItem={({ item: r }) => {
              const typeLabel = r.type === 'daily' ? 'D' : r.type === 'every-n-days' ? `${r.schedule.n ?? 2}d` : r.type === 'every-n-weeks' ? `${r.schedule.n ?? 2}w` : r.type === 'weekly' ? 'W' : r.type === 'monthly' ? 'M' : 'Y';
              return (
                <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border + '33' }}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 15, color: theme.text }}>{r.title}</Text>
                    {r.description ? <Text style={{ fontSize: 12, color: theme.text, opacity: 0.5, marginTop: 2 }}>{r.description}</Text> : null}
                  </View>
                  <View style={{ paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, backgroundColor: ACCENT + '22', marginRight: 12 }}>
                    <Text style={{ fontSize: 11, fontWeight: '700', color: ACCENT }}>{typeLabel}</Text>
                  </View>
                  <TouchableOpacity onPress={() => Alert.alert('Delete rhythm?', r.title, [{ text: 'Cancel', style: 'cancel' }, { text: 'Delete', style: 'destructive', onPress: () => deleteRhythm(r.id) }])}>
                    <Text style={{ color: '#FF6135', fontSize: 13 }}>Delete</Text>
                  </TouchableOpacity>
                </View>
              );
            }}
          />

          {/* Add Rhythm form or button */}
          {rhythmForm.visible ? (
            <View style={{ padding: 16, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.border }}>
              <TextInput
                value={rhythmForm.title}
                onChangeText={t => setRhythmForm(f => ({ ...f, title: t }))}
                placeholder="Rhythm title"
                placeholderTextColor={theme.textDim}
                style={{ borderWidth: 1, borderColor: theme.border, borderRadius: 8, padding: 10, color: theme.text, marginBottom: 10, fontSize: 15 }}
              />
              {/* Type selector */}
              <View style={{ gap: 6, marginBottom: 10 }}>
                <View style={{ flexDirection: 'row', gap: 6 }}>
                  {(['daily', 'weekly', 'monthly', 'annual'] as const).map(t => (
                    <TouchableOpacity key={t} onPress={() => setRhythmForm(f => ({ ...f, type: t }))} style={{ flex: 1, paddingVertical: 8, borderRadius: 8, backgroundColor: rhythmForm.type === t ? ACCENT : ACCENT + '22', alignItems: 'center' }}>
                      <Text style={{ fontSize: 12, fontWeight: '600', color: rhythmForm.type === t ? '#fff' : ACCENT }}>{t[0].toUpperCase() + t.slice(1)}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <View style={{ flexDirection: 'row', gap: 6 }}>
                  {(['every-n-days', 'every-n-weeks'] as const).map(t => (
                    <TouchableOpacity key={t} onPress={() => setRhythmForm(f => ({ ...f, type: t }))} style={{ flex: 1, paddingVertical: 8, borderRadius: 8, backgroundColor: rhythmForm.type === t ? ACCENT : ACCENT + '22', alignItems: 'center' }}>
                      <Text style={{ fontSize: 12, fontWeight: '600', color: rhythmForm.type === t ? '#fff' : ACCENT }}>{t === 'every-n-days' ? 'Every N Days' : 'Every N Weeks'}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
              {/* Schedule by type */}
              {rhythmForm.type === 'weekly' && (
                <View style={{ flexDirection: 'row', gap: 6, marginBottom: 10 }}>
                  {['S','M','T','W','T','F','S'].map((label, i) => (
                    <TouchableOpacity key={i} onPress={() => setRhythmForm(f => ({ ...f, days: f.days.includes(i) ? f.days.filter(d => d !== i) : [...f.days, i] }))} style={{ flex: 1, paddingVertical: 6, borderRadius: 6, backgroundColor: rhythmForm.days.includes(i) ? ACCENT : ACCENT + '22', alignItems: 'center' }}>
                      <Text style={{ fontSize: 12, fontWeight: '600', color: rhythmForm.days.includes(i) ? '#fff' : ACCENT }}>{label}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              )}
              {rhythmForm.type === 'monthly' && (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 10 }}>
                  <Text style={{ color: theme.text, fontSize: 14 }}>Day of month:</Text>
                  <TouchableOpacity onPress={() => setRhythmForm(f => ({ ...f, dayOfMonth: Math.max(1, f.dayOfMonth - 1) }))} style={{ padding: 8 }}><Text style={{ color: ACCENT, fontSize: 18 }}>−</Text></TouchableOpacity>
                  <Text style={{ color: theme.text, fontSize: 16, minWidth: 24, textAlign: 'center' }}>{rhythmForm.dayOfMonth}</Text>
                  <TouchableOpacity onPress={() => setRhythmForm(f => ({ ...f, dayOfMonth: Math.min(31, f.dayOfMonth + 1) }))} style={{ padding: 8 }}><Text style={{ color: ACCENT, fontSize: 18 }}>+</Text></TouchableOpacity>
                </View>
              )}
              {rhythmForm.type === 'annual' && (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
                  <Text style={{ color: theme.text, fontSize: 14 }}>Month:</Text>
                  <TouchableOpacity onPress={() => setRhythmForm(f => ({ ...f, month: Math.max(1, f.month - 1) }))} style={{ padding: 6 }}><Text style={{ color: ACCENT, fontSize: 16 }}>−</Text></TouchableOpacity>
                  <Text style={{ color: theme.text, fontSize: 14, minWidth: 30, textAlign: 'center' }}>{['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][rhythmForm.month - 1]}</Text>
                  <TouchableOpacity onPress={() => setRhythmForm(f => ({ ...f, month: Math.min(12, f.month + 1) }))} style={{ padding: 6 }}><Text style={{ color: ACCENT, fontSize: 16 }}>+</Text></TouchableOpacity>
                  <Text style={{ color: theme.text, fontSize: 14, marginLeft: 8 }}>Day:</Text>
                  <TouchableOpacity onPress={() => setRhythmForm(f => ({ ...f, day: Math.max(1, f.day - 1) }))} style={{ padding: 6 }}><Text style={{ color: ACCENT, fontSize: 16 }}>−</Text></TouchableOpacity>
                  <Text style={{ color: theme.text, fontSize: 14, minWidth: 24, textAlign: 'center' }}>{rhythmForm.day}</Text>
                  <TouchableOpacity onPress={() => setRhythmForm(f => ({ ...f, day: Math.min(31, f.day + 1) }))} style={{ padding: 6 }}><Text style={{ color: ACCENT, fontSize: 16 }}>+</Text></TouchableOpacity>
                </View>
              )}
              {(rhythmForm.type === 'every-n-days' || rhythmForm.type === 'every-n-weeks') && (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 10 }}>
                  <Text style={{ color: theme.text, fontSize: 14 }}>Every</Text>
                  <TouchableOpacity onPress={() => setRhythmForm(f => ({ ...f, n: Math.max(2, f.n - 1) }))} style={{ padding: 8 }}><Text style={{ color: ACCENT, fontSize: 18 }}>−</Text></TouchableOpacity>
                  <Text style={{ color: theme.text, fontSize: 16, minWidth: 28, textAlign: 'center' }}>{rhythmForm.n}</Text>
                  <TouchableOpacity onPress={() => setRhythmForm(f => ({ ...f, n: Math.min(365, f.n + 1) }))} style={{ padding: 8 }}><Text style={{ color: ACCENT, fontSize: 18 }}>+</Text></TouchableOpacity>
                  <Text style={{ color: theme.text, fontSize: 14 }}>{rhythmForm.type === 'every-n-days' ? 'days' : 'weeks'}</Text>
                </View>
              )}
              <TextInput
                value={rhythmForm.description}
                onChangeText={t => setRhythmForm(f => ({ ...f, description: t }))}
                placeholder="Description (optional)"
                placeholderTextColor={theme.textDim}
                style={{ borderWidth: 1, borderColor: theme.border, borderRadius: 8, padding: 10, color: theme.text, marginBottom: 10, fontSize: 14 }}
              />
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <TouchableOpacity onPress={() => setRhythmForm(f => ({ ...f, visible: false }))} style={{ flex: 1, padding: 12, borderRadius: 8, borderWidth: 1, borderColor: theme.border, alignItems: 'center' }}>
                  <Text style={{ color: theme.text, fontSize: 14 }}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={saveRhythm} style={{ flex: 2, padding: 12, borderRadius: 8, backgroundColor: ACCENT, alignItems: 'center' }}>
                  <Text style={{ color: '#fff', fontWeight: '600', fontSize: 14 }}>Save Rhythm</Text>
                </TouchableOpacity>
              </View>
            </View>
          ) : (
            <TouchableOpacity onPress={() => setRhythmForm(f => ({ ...f, visible: true }))} style={{ margin: 16, padding: 14, borderRadius: 10, backgroundColor: ACCENT, alignItems: 'center' }}>
              <Text style={{ color: '#fff', fontWeight: '600', fontSize: 15 }}>+ Add Rhythm</Text>
            </TouchableOpacity>
          )}
        </View>
        </KeyboardAvoidingView>
      </Modal>

      <SettingsModal
        visible={settingsVisible}
        onClose={() => { setSettingsVisible(false); setSettingsSection(undefined); }}
        section={settingsSection}
      />
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  digestBanner: {
    marginHorizontal: 16,
    marginTop: 8,
    padding: 12,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 6,
  },
  digestText: {
    fontFamily: 'DMSans_400Regular',
    fontSize: 13,
    lineHeight: 20,
  },
  digestDismiss: {
    fontFamily: 'DMSans_400Regular',
    fontSize: 11,
    letterSpacing: 0.5,
    opacity: 0.7,
  },
  root: {
    flex: 1,
  },
  flex: { flex: 1 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  // ── Panel hairlines ──────────────────────────────────────────────────────────

  panelHairline: {
    height: StyleSheet.hairlineWidth,
  },

  // ── Phrase of the week ──────────────────────────────────────────────────────

  phraseRow: {
    paddingHorizontal: 24,
    paddingTop: 12,
    paddingBottom: 4,
    alignItems: 'center',
  },
  phraseTouchable: {
    alignSelf: 'center',
  },
  phraseText: {
    fontFamily: 'Lora_400Regular_Italic',
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'center',
  },
  phraseInput: {
    fontFamily: 'Lora_400Regular_Italic',
    fontSize: 15,
    lineHeight: 22,
    paddingVertical: 2,
    borderBottomWidth: StyleSheet.hairlineWidth,
    width: '100%',
    textAlign: 'center',
  },

  // ── Panel 1: Calendar ───────────────────────────────────────────────────────

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerTitleWrap: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 18,
    color: ACCENT,
  },
  headerDate: {
    fontFamily: 'DMSans_400Regular',
    fontSize: 13,
  },
  headerControls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  headerBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  headerBtnLabel: {
    fontSize: 16,
    fontFamily: 'DMSans_700Bold',
  },
  calPanel: {
    height: CAL_PANEL_HEIGHT,
    paddingHorizontal: 24,
    paddingTop: 8,
  },
  calViewToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 6,
  },
  calViewToggleLabel: {
    fontFamily: 'DMSans_400Regular',
    fontSize: 11,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  calViewToggleSep: {
    fontFamily: 'DMSans_400Regular',
    fontSize: 11,
  },
  calScroll: {
    height: CAL_SCROLL_HEIGHT,
  },
  connectCalendar: {
    fontFamily: 'DMSans_400Regular',
    fontSize: 14,
    paddingVertical: 12,
  },
  nothingScheduled: {
    fontFamily: 'DMSans_400Regular',
    fontSize: 13,
    paddingVertical: 6,
    paddingLeft: 4,
  },
  dayLabel: {
    fontFamily: 'DMSans_500Medium',
    fontSize: 12,
    marginTop: 12,
    marginBottom: 2,
  },
  agendaRow: {
    flexDirection: 'row',
    gap: 16,
    paddingVertical: 8,
    alignItems: 'flex-start',
  },
  agendaTime: {
    fontFamily: 'DMSans_400Regular',
    fontSize: 12,
    width: 52,
    lineHeight: 20,
  },
  agendaTitle: {
    fontFamily: 'DMSans_400Regular',
    fontSize: 14,
    flex: 1,
    lineHeight: 20,
  },
  nowRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginVertical: 2,
  },
  nowLine: {
    flex: 1,
    height: 1,
    backgroundColor: ACCENT,
    opacity: 0.5,
  },
  nowLabel: {
    fontFamily: 'DMSans_400Regular',
    fontSize: 10,
    color: ACCENT,
    opacity: 0.7,
    letterSpacing: 0.3,
  },
  // ── Panel 2: To-do ──────────────────────────────────────────────────────────

  todoPanel: {
    flex: 1,
    paddingHorizontal: 24,
    paddingTop: 12,
    paddingBottom: 8,
  },
  todoPanelHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  sectionLabel: {
    fontFamily: 'DMSans_400Regular',
    fontSize: 11,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    marginBottom: 4,
  },
  taskCount: {
    fontFamily: 'DMSans_400Regular',
    fontSize: 11,
    letterSpacing: 0.5,
  },
  todoActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  todoActionBtn: {
    fontFamily: 'DMSans_400Regular',
    fontSize: 11,
    color: ACCENT,
    opacity: 0.7,
    letterSpacing: 0.5,
  },
  taskRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    paddingVertical: 10,
  },
  taskCircle: {
    fontSize: 16,
    lineHeight: 20,
    opacity: 0.7,
  },
  taskCircleDone: {
    color: ACCENT,
    opacity: 0.6,
  },
  taskText: {
    fontFamily: 'DMSans_400Regular',
    fontSize: 14,
    flex: 1,
    lineHeight: 20,
  },
  taskTextDone: {
    textDecorationLine: 'line-through' as const,
    opacity: 0.4,
  },
  taskTextFlex: {
    flex: 1,
  },
  taskEditInput: {
    paddingVertical: 0,
    paddingHorizontal: 0,
    margin: 0,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: ACCENT,
  },
  taskDeleteBtn: {
    paddingLeft: 12,
    paddingVertical: 4,
    justifyContent: 'center',
  },
  taskDeleteLabel: {
    fontSize: 14,
    fontFamily: 'DMSans_400Regular',
    opacity: 0.5,
  },
  addInput: {
    fontFamily: 'DMSans_400Regular',
    fontSize: 14,
    paddingVertical: 10,
    marginTop: 2,
  },
  priorityDot: {
    paddingVertical: 4,
    justifyContent: 'center',
    alignItems: 'center',
  },
  priorityDotInner: {
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 1.5,
  },

  // ── Panel 3: Haiku ──────────────────────────────────────────────────────────

  haikuPanel: {
    height: HAIKU_PANEL_HEIGHT,
    overflow: 'hidden',
  },
  haikuScrollView: {
    flex: 1,
  },
  haikuPage: {
    width: SCREEN_WIDTH,
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 40,
    paddingTop: 8,
    paddingBottom: 4,
  },
  haikuYearCorner: {
    position: 'absolute',
    top: 8,
    right: 8,
    fontFamily: 'DMSans_400Regular',
    fontSize: 11,
    opacity: 0.6,
    letterSpacing: 0.8,
  },
  haikuTouchable: {
    alignItems: 'center',
    width: '100%',
    flex: 1,
    justifyContent: 'center',
  },
  haikuText: {
    fontFamily: 'Lora_400Regular',
    fontSize: 18,
    lineHeight: 30,
    textAlign: 'center',
    letterSpacing: 0.3,
  },
  haikuItalic: {
    fontFamily: 'Lora_400Regular_Italic',
    fontSize: 18,
    lineHeight: 30,
    textAlign: 'center',
    letterSpacing: 0.3,
  },
  haikuEmpty: {
    fontFamily: 'DMSans_400Regular',
    fontSize: 14,
    color: ACCENT,
    textAlign: 'center',
  },
  haikuDots: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 6,
    height: 24,
    paddingBottom: 4,
  },
  haikuDot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
  },

  sectionDivider: {
    paddingTop: 12,
    paddingBottom: 4,
  },
  sectionDividerLabel: {
    fontFamily: 'DMSans_400Regular',
    fontSize: 10,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  inboxMoveBtn: {
    paddingLeft: 10,
    paddingVertical: 4,
  },
  inboxMoveBtnLabel: {
    fontFamily: 'DMSans_400Regular',
    fontSize: 12,
  },

  // ── Calendar connect overlay ────────────────────────────────────────────────

  connectOverlay: {
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 32,
    zIndex: 10,
  },
  connectClose: {
    position: 'absolute',
    top: 56,
    right: 24,
  },
  connectCloseLabel: {
    fontFamily: 'DMSans_400Regular',
    fontSize: 14,
  },
  connectTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 20,
    marginBottom: 24,
    textAlign: 'center',
  },
  connectHint: {
    fontFamily: 'DMSans_400Regular',
    fontSize: 13,
    textAlign: 'center',
    marginBottom: 8,
  },
  connectUrl: {
    fontFamily: 'DMSans_500Medium',
    fontSize: 15,
    textAlign: 'center',
  },
  connectCode: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 28,
    letterSpacing: 4,
    textAlign: 'center',
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 20,
    paddingVertical: 10,
    marginTop: 4,
  },
  connectWaiting: {
    fontFamily: 'DMSans_400Regular',
    fontSize: 12,
    marginTop: 20,
  },

  // ── Write mode overlay ──────────────────────────────────────────────────────

  writeOverlay: {
    justifyContent: 'center',
  },
  writeContent: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 40,
    gap: 4,
    position: 'relative',
  },
  writeDoneBtn: {
    position: 'absolute',
    right: 24,
  },
  writeDoneLabel: {
    fontFamily: 'DMSans_500Medium',
    fontSize: 15,
    color: ACCENT,
  },
  writeLineBlock: {
    width: '100%',
    alignItems: 'center',
    marginBottom: 16,
  },
  writeInput: {
    fontFamily: 'Lora_400Regular',
    fontSize: 22,
    lineHeight: 34,
    letterSpacing: 0.3,
    width: '100%',
    textAlign: 'center',
    paddingVertical: 4,
  },
  syllableDots: {
    fontFamily: 'DMSans_400Regular',
    fontSize: 14,
    marginTop: 4,
    letterSpacing: 3,
  },
});
