import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, RefreshControl, PanResponder, Platform, Modal, TextInput,
} from 'react-native';
import Markdown from 'react-native-markdown-display';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import HtmlBlock from '../../components/HtmlBlock';
import { router } from 'expo-router';
import { useTheme } from '../../lib/theme';
import { useStore, MODE_ACCENTS, getModeName, getModeEmoji } from '../../lib/store';
import { apiFetch } from '../../lib/api';
import { wsService } from '../../lib/ws';
import SettingsModal from '../../components/SettingsModal';

const RUSE_ACCENT = MODE_ACCENTS.shapeshifter; // '#FF6135'

// ─── Canvas types ─────────────────────────────────────────────────────────────

interface TaskItem { id: string; text: string; done: boolean }
interface LinkItem { id: string; label: string; url: string }
interface TabItem  { id: string; label: string; file: string }

interface CanvasBlock {
  id: string;
  type: 'markdown' | 'tasks' | 'note' | 'links' | 'code' | 'section' | 'button' | 'filetabs' | 'input' | 'html';
  content?: string;
  title?: string;
  items?: TaskItem[] | LinkItem[];
  tabs?: TabItem[];
  color?: 'amber' | 'blue' | 'green' | 'red';
  language?: string;
  label?: string;
  // button-specific
  action?: 'chat' | 'file';
  file?: string;   // vault-relative path, used when action === 'file'
  height?: number;
}

interface CanvasData {
  version: number;
  blocks: CanvasBlock[];
  updatedAt?: string;
}

// ─── Markdown styles ───────────────────────────────────────────────────────────

function buildMarkdownStyles(theme: import('../../lib/theme').Theme) {
  const mono = Platform.OS === 'ios' ? 'Menlo' : 'monospace';
  return {
    body:        { color: theme.text, fontFamily: 'DMSans_400Regular', fontSize: 15, lineHeight: 26 },
    paragraph:   { marginTop: 0, marginBottom: 14 },
    heading1:    { fontFamily: 'DMSans_700Bold', fontSize: 24, lineHeight: 32, marginTop: 20, marginBottom: 8, color: theme.text },
    heading2:    { fontFamily: 'DMSans_700Bold', fontSize: 19, lineHeight: 26, marginTop: 16, marginBottom: 6, color: theme.text },
    heading3:    { fontFamily: 'DMSans_700Bold', fontSize: 16, lineHeight: 22, marginTop: 12, marginBottom: 4, color: theme.text },
    heading4:    { fontFamily: 'DMSans_700Bold', fontSize: 15, lineHeight: 22, marginTop: 10, marginBottom: 4, color: theme.textDim },
    strong:      { fontFamily: 'DMSans_700Bold' },
    em:          { fontFamily: 'Lora_400Regular_Italic' },
    hr:          { backgroundColor: theme.border, height: 1, marginVertical: 16 },
    blockquote:  { backgroundColor: theme.surface, borderLeftColor: RUSE_ACCENT, borderLeftWidth: 3, paddingHorizontal: 12, paddingVertical: 2, marginVertical: 6, borderRadius: 4 },
    code_inline: { fontFamily: mono, fontSize: 13, backgroundColor: theme.surfaceAlt, color: RUSE_ACCENT, paddingHorizontal: 4, paddingVertical: 2, borderRadius: 4 },
    fence:       { fontFamily: mono, fontSize: 13, backgroundColor: '#1a1a1a', color: '#e0e0e0', padding: 14, borderRadius: 8, marginVertical: 8 },
    code_block:  { fontFamily: mono, fontSize: 13, backgroundColor: '#1a1a1a', color: '#e0e0e0', padding: 14, borderRadius: 8, marginVertical: 8 },
    bullet_list: { marginVertical: 4 },
    ordered_list:{ marginVertical: 4 },
    list_item:   { marginVertical: 2 },
    link:        { color: RUSE_ACCENT, textDecorationLine: 'underline' as const },
  };
}

// ─── Block components ─────────────────────────────────────────────────────────

function MarkdownBlock({ block, theme }: { block: CanvasBlock; theme: import('../../lib/theme').Theme }) {
  const mdStyles = buildMarkdownStyles(theme);
  return (
    <View style={[styles.blockContainer, { backgroundColor: theme.surface }]}>
      <Markdown style={mdStyles}>{block.content ?? ''}</Markdown>
    </View>
  );
}

function TasksBlock({
  block,
  theme,
  onToggle,
}: {
  block: CanvasBlock;
  theme: import('../../lib/theme').Theme;
  onToggle: (blockId: string, taskId: string, done: boolean) => void;
}) {
  const items = (block.items ?? []) as TaskItem[];
  return (
    <View style={[styles.blockContainer, { backgroundColor: theme.surface }]}>
      {block.title ? (
        <Text style={[styles.blockTitle, { color: theme.text }]}>{block.title}</Text>
      ) : null}
      {items.map((item) => (
        <TouchableOpacity
          key={item.id}
          style={styles.taskRow}
          onPress={() => onToggle(block.id, item.id, !item.done)}
          activeOpacity={0.7}
        >
          <View style={[styles.taskCircle, item.done && { backgroundColor: RUSE_ACCENT, borderColor: RUSE_ACCENT }]}>
            {item.done ? <Text style={styles.taskCheck}>✓</Text> : null}
          </View>
          <Text style={[styles.taskText, { color: item.done ? theme.textDim : theme.text }, item.done && styles.taskTextDone]}>
            {item.text}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

const NOTE_COLORS: Record<string, string> = {
  amber: '#FFB300',
  blue: '#2196F3',
  green: '#4CAF50',
  red: '#F44336',
};

function NoteBlock({ block, theme }: { block: CanvasBlock; theme: import('../../lib/theme').Theme }) {
  const borderColor = NOTE_COLORS[block.color ?? 'amber'] ?? NOTE_COLORS.amber;
  const bgColor = borderColor + '1F'; // ~12% opacity
  const mdStyles = buildMarkdownStyles(theme);
  return (
    <View style={[styles.blockContainer, styles.noteBlock, { borderLeftColor: borderColor, backgroundColor: bgColor }]}>
      {block.title ? (
        <Text style={[styles.blockTitle, { color: theme.text }]}>{block.title}</Text>
      ) : null}
      {block.content ? (
        <Markdown style={mdStyles}>{block.content}</Markdown>
      ) : null}
    </View>
  );
}

function LinksBlock({ block, theme }: { block: CanvasBlock; theme: import('../../lib/theme').Theme }) {
  const items = (block.items ?? []) as LinkItem[];
  return (
    <View style={[styles.blockContainer, { backgroundColor: theme.surface }]}>
      {block.title ? (
        <Text style={[styles.blockTitle, { color: theme.text }]}>{block.title}</Text>
      ) : null}
      {items.map((item) => (
        <View key={item.id} style={styles.linkRow}>
          <Text style={[styles.linkLabel, { color: RUSE_ACCENT }]}>{item.label} →</Text>
          <Text style={[styles.linkUrl, { color: theme.textDim }]} numberOfLines={1}>{item.url}</Text>
        </View>
      ))}
    </View>
  );
}

function CodeBlock({ block, theme }: { block: CanvasBlock; theme: import('../../lib/theme').Theme }) {
  const mono = Platform.OS === 'ios' ? 'Menlo' : 'monospace';
  return (
    <View style={[styles.blockContainer, styles.codeBlock]}>
      {block.language ? (
        <Text style={[styles.codeLanguage, { color: theme.textDim }]}>{block.language}</Text>
      ) : null}
      <Text style={[styles.codeContent, { fontFamily: mono }]}>{block.content ?? ''}</Text>
    </View>
  );
}

function SectionBlock({ block, theme }: { block: CanvasBlock; theme: import('../../lib/theme').Theme }) {
  return (
    <View style={styles.sectionBlock}>
      <View style={[styles.sectionLine, { backgroundColor: theme.border }]} />
      {block.label ? (
        <Text style={[styles.sectionLabel, { color: theme.textDim, backgroundColor: theme.bg }]}>{block.label}</Text>
      ) : null}
    </View>
  );
}

function ButtonBlock({
  block,
  theme,
  onChatPress,
}: {
  block: CanvasBlock;
  theme: import('../../lib/theme').Theme;
  onChatPress: () => void;
}) {
  const [fileOpen, setFileOpen] = useState(false);
  const isFile = block.action === 'file' && !!block.file;

  return (
    <View style={[styles.blockContainer, { backgroundColor: theme.surface }]}>
      {block.content ? (
        <Text style={[styles.buttonBlockDesc, { color: theme.textDim }]}>{block.content}</Text>
      ) : null}
      <TouchableOpacity
        style={[styles.buttonBlockBtn, { backgroundColor: RUSE_ACCENT }]}
        onPress={isFile ? () => setFileOpen(true) : onChatPress}
        activeOpacity={0.8}
      >
        <Text style={styles.buttonBlockLabel}>{block.label ?? (isFile ? 'Open file' : 'Open chat')}</Text>
      </TouchableOpacity>
      {isFile && (
        <FileViewerModal
          visible={fileOpen}
          file={block.file!}
          title={block.label ?? 'File'}
          theme={theme}
          onClose={() => setFileOpen(false)}
        />
      )}
    </View>
  );
}

function FileViewerModal({
  visible, file, title, theme, onClose,
}: {
  visible: boolean;
  file: string;
  title: string;
  theme: import('../../lib/theme').Theme;
  onClose: () => void;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const mdStyles = buildMarkdownStyles(theme);

  useEffect(() => {
    if (!visible || !file) return;
    let cancelled = false;
    setLoading(true);
    setContent(null);
    apiFetch(`/wiki/file?path=${encodeURIComponent(file)}`)
      .then((r) => r.json())
      .then((data: { content?: string }) => { if (!cancelled) setContent(data.content ?? ''); })
      .catch(() => { if (!cancelled) setContent('Failed to load file.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [visible, file]);

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={[styles.fileModalRoot, { backgroundColor: theme.bg }]}>
        <View style={[styles.fileModalHeader, { borderBottomColor: theme.border }]}>
          <Text style={[styles.fileModalTitle, { color: theme.text }]} numberOfLines={1}>{title}</Text>
          <TouchableOpacity onPress={onClose} activeOpacity={0.7} style={styles.fileModalClose}>
            <Text style={[styles.fileModalCloseLabel, { color: theme.textDim }]}>Done</Text>
          </TouchableOpacity>
        </View>
        <ScrollView style={styles.fileModalScroll} contentContainerStyle={styles.fileModalContent}>
          {loading ? (
            <ActivityIndicator color={theme.textDim} style={{ marginTop: 48 }} />
          ) : content !== null ? (
            <Markdown style={mdStyles}>{content}</Markdown>
          ) : null}
        </ScrollView>
      </View>
    </Modal>
  );
}

function InputBlock({
  block,
  theme,
  onSave,
}: {
  block: CanvasBlock;
  theme: import('../../lib/theme').Theme;
  onSave: (blockId: string, text: string) => void;
}) {
  const [value, setValue] = useState(block.content ?? '');
  return (
    <View style={[styles.blockContainer, { backgroundColor: theme.surface }]}>
      {block.title ? (
        <Text style={[styles.blockTitle, { color: theme.text }]}>{block.title}</Text>
      ) : null}
      <TextInput
        style={[
          styles.inputField,
          { color: theme.text, borderColor: theme.border, backgroundColor: theme.bg },
        ]}
        value={value}
        onChangeText={setValue}
        onBlur={() => onSave(block.id, value)}
        placeholder="Tap to take notes…"
        placeholderTextColor={theme.textFaint ?? theme.textDim}
        multiline
        scrollEnabled={false}
        textAlignVertical="top"
      />
    </View>
  );
}

function FileTabsBlock({ block, theme }: { block: CanvasBlock; theme: import('../../lib/theme').Theme }) {
  const tabs = (block.tabs ?? []) as TabItem[];
  const [activeId, setActiveId] = useState(tabs[0]?.id ?? '');
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const mdStyles = buildMarkdownStyles(theme);

  useEffect(() => {
    const tab = tabs.find((t) => t.id === activeId);
    if (!tab) return;
    let cancelled = false;
    setLoading(true);
    setContent(null);
    apiFetch(`/wiki/file?path=${encodeURIComponent(tab.file)}`)
      .then((r) => r.json())
      .then((data: { content?: string }) => {
        if (!cancelled) setContent(data.content ?? '');
      })
      .catch(() => { if (!cancelled) setContent('Failed to load file.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [activeId]);

  return (
    <View style={[styles.blockContainer, { backgroundColor: theme.surface, padding: 0, overflow: 'hidden' }]}>
      {/* Tab strip */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabStrip}>
        {tabs.map((tab) => {
          const isActive = tab.id === activeId;
          return (
            <TouchableOpacity
              key={tab.id}
              style={[styles.tabPill, isActive && { borderBottomColor: RUSE_ACCENT, borderBottomWidth: 2 }]}
              onPress={() => setActiveId(tab.id)}
              activeOpacity={0.7}
            >
              <Text style={[styles.tabLabel, { color: isActive ? RUSE_ACCENT : theme.textDim }]}>
                {tab.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
      {/* File content */}
      <View style={styles.tabContent}>
        {loading ? (
          <ActivityIndicator color={theme.textDim} style={{ marginVertical: 24 }} />
        ) : content !== null ? (
          <Markdown style={mdStyles}>{content}</Markdown>
        ) : null}
      </View>
    </View>
  );
}

// ─── Main screen ──────────────────────────────────────────────────────────────

function toTitleCase(slug: string): string {
  return slug
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export default function RuseScreen() {
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const isDark = useStore((s) => s.isDark);
  const toggleTheme = useStore((s) => s.toggleTheme);
  const currentProjectSlug = useStore((s) => s.currentProjectSlug);
  const setRequestedChatPersona = useStore((s) => s.setRequestedChatPersona);
  const modes = useStore((s) => s.modes);

  const [canvas, setCanvas] = useState<CanvasData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [settingsSection, setSettingsSection] = useState<'model' | 'history' | undefined>('model');

  const projectName =
    currentProjectSlug === 'inbox'
      ? 'Inbox'
      : toTitleCase(currentProjectSlug);

  const fetchCanvas = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else { setLoading(true); setError(null); }
    try {
      const res = await apiFetch(
        `/wiki/file?path=${encodeURIComponent(`projects/${currentProjectSlug}/canvas.json`)}`
      );
      if (res.status === 404) {
        setCanvas({ version: 1, blocks: [] });
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `Server error ${res.status}`);
      }
      const data = await res.json() as { content?: string };
      const parsed: CanvasData = data.content ? JSON.parse(data.content) : { version: 1, blocks: [] };
      setCanvas(parsed);
      setError(null);
    } catch (err: unknown) {
      if ((err as Error).message?.includes('404') || (err as Error).message?.includes('Not Found')) {
        setCanvas({ version: 1, blocks: [] });
      } else {
        setError(err instanceof Error ? err.message : 'Failed to load canvas');
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [currentProjectSlug]);

  // Fetch canvas on mount and project change
  useEffect(() => {
    fetchCanvas();
  }, [fetchCanvas]);

  // Listen for canvas_update WebSocket messages
  useEffect(() => {
    const listener = (event: unknown) => {
      const e = event as { type?: string; slug?: string; canvas?: CanvasData };
      if (e.type === 'canvas_update' && e.slug === currentProjectSlug && e.canvas) {
        setCanvas(e.canvas);
      }
    };
    wsService.addListener(listener);
    return () => { wsService.removeListener(listener); };
  }, [currentProjectSlug]);

  // Save input block text to server
  const handleInputSave = useCallback(async (blockId: string, text: string) => {
    if (!canvas) return;
    const updatedCanvas: CanvasData = {
      ...canvas,
      blocks: canvas.blocks.map((b) =>
        b.id === blockId ? { ...b, content: text } : b
      ),
      updatedAt: new Date().toISOString(),
    };
    setCanvas(updatedCanvas);
    try {
      await apiFetch('/wiki/file', {
        method: 'POST',
        body: JSON.stringify({
          path: `projects/${currentProjectSlug}/canvas.json`,
          content: JSON.stringify(updatedCanvas, null, 2),
        }),
      });
    } catch {
      setCanvas(canvas);
    }
  }, [canvas, currentProjectSlug]);

  // Toggle a task done/undone and save to server
  const handleTaskToggle = useCallback(async (blockId: string, taskId: string, done: boolean) => {
    if (!canvas) return;

    const updatedCanvas: CanvasData = {
      ...canvas,
      blocks: canvas.blocks.map((b) => {
        if (b.id !== blockId) return b;
        return {
          ...b,
          items: (b.items as TaskItem[]).map((t) =>
            t.id === taskId ? { ...t, done } : t
          ),
        };
      }),
      updatedAt: new Date().toISOString(),
    };

    // Optimistic update
    setCanvas(updatedCanvas);

    try {
      await apiFetch('/wiki/file', {
        method: 'POST',
        body: JSON.stringify({
          path: `projects/${currentProjectSlug}/canvas.json`,
          content: JSON.stringify(updatedCanvas, null, 2),
        }),
      });
    } catch {
      // Revert on error
      setCanvas(canvas);
    }
  }, [canvas, currentProjectSlug]);

  // Swipe navigation: right → mentor, left → keeper
  const swipe = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) =>
        Math.abs(g.dx) > 12 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
      onPanResponderRelease: (_, g) => {
        if (Math.abs(g.dx) < 40) return;
        if (g.dx > 0) {
          router.replace('/(tabs)/mentor');
        } else {
          router.replace('/(tabs)/keeper');
        }
      },
    })
  ).current;

  const renderBlock = (block: CanvasBlock) => {
    switch (block.type) {
      case 'markdown':
        return <MarkdownBlock key={block.id} block={block} theme={theme} />;
      case 'tasks':
        return <TasksBlock key={block.id} block={block} theme={theme} onToggle={handleTaskToggle} />;
      case 'note':
        return <NoteBlock key={block.id} block={block} theme={theme} />;
      case 'links':
        return <LinksBlock key={block.id} block={block} theme={theme} />;
      case 'code':
        return <CodeBlock key={block.id} block={block} theme={theme} />;
      case 'section':
        return <SectionBlock key={block.id} block={block} theme={theme} />;
      case 'button':
        return (
          <ButtonBlock
            key={block.id}
            block={block}
            theme={theme}
            onChatPress={() => {
              setRequestedChatPersona('shapeshifter');
              router.replace('/(tabs)/mentor');
            }}
          />
        );
      case 'filetabs':
        return <FileTabsBlock key={block.id} block={block} theme={theme} />;
      case 'input':
        return <InputBlock key={block.id} block={block} theme={theme} onSave={handleInputSave} />;
      case 'html':
        return <HtmlBlock key={block.id} block={block} theme={theme} />;
      default:
        return null;
    }
  };

  return (
    <View style={[styles.root, { paddingTop: insets.top, backgroundColor: theme.bg }]} {...swipe.panHandlers}>
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: theme.border }]}>
        <TouchableOpacity
          onPress={() => {
            setRequestedChatPersona('shapeshifter');
            router.replace('/(tabs)/mentor');
          }}
          onLongPress={() => { setSettingsSection('model'); setSettingsVisible(true); }}
          activeOpacity={0.7}
        >
          <Text style={[styles.headerPersona, { color: RUSE_ACCENT }]}>{getModeEmoji('shapeshifter', modes)} {getModeName('shapeshifter', modes)}</Text>
        </TouchableOpacity>
        <Text style={[styles.headerProject, { color: theme.textDim }]} numberOfLines={1}>
          {projectName}
        </Text>
        <TouchableOpacity onPress={toggleTheme} style={styles.headerBtn} activeOpacity={0.7}>
          <Text style={styles.headerBtnLabel}>{isDark ? '🌙' : '☀️'}</Text>
        </TouchableOpacity>
      </View>

      <SettingsModal
        visible={settingsVisible}
        onClose={() => setSettingsVisible(false)}
        section={settingsSection}
      />

      {/* Content */}
      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator color={theme.textDim} />
        </View>
      ) : error ? (
        <View style={styles.centered}>
          <Text style={[styles.errorText, { color: theme.textDim }]}>{error}</Text>
          <TouchableOpacity
            style={[styles.retryBtn, { borderColor: theme.border }]}
            onPress={() => fetchCanvas()}
          >
            <Text style={[styles.retryLabel, { color: theme.text }]}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => fetchCanvas(true)}
              tintColor={theme.textDim}
            />
          }
        >
          {!canvas || canvas.blocks.length === 0 ? (
            <View style={styles.emptyState}>
              <Text style={[styles.emptyTitle, { color: theme.textDim }]}>
                This canvas is empty
              </Text>
              <Text style={[styles.emptyHint, { color: theme.textFaint }]}>
                Talk to {getModeName('mentor', modes)} to start building this space.{'\n'}
                {projectName !== 'Inbox' ? `Current project: ${projectName}` : 'No project selected.'}
              </Text>
            </View>
          ) : (
            canvas.blocks.map(renderBlock)
          )}
        </ScrollView>
      )}

      {/* Chat FAB */}
      <TouchableOpacity
        style={[styles.fab, { backgroundColor: RUSE_ACCENT }]}
        onPress={() => {
          setRequestedChatPersona('shapeshifter');
          router.replace('/(tabs)/mentor');
        }}
        activeOpacity={0.85}
      >
        <Text style={styles.fabLabel}>✏ Chat</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerPersona: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 18,
    flexShrink: 0,
  },
  headerProject: {
    flex: 1,
    fontFamily: 'DMSans_500Medium',
    fontSize: 14,
    textAlign: 'center',
    paddingHorizontal: 8,
  },
  headerBtn: {
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  headerBtnLabel: {
    fontSize: 16,
    fontFamily: 'DMSans_700Bold',
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    gap: 12,
  },
  errorText: {
    fontFamily: 'DMSans_400Regular',
    fontSize: 14,
    textAlign: 'center',
  },
  retryBtn: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
  },
  retryLabel: {
    fontFamily: 'DMSans_500Medium',
    fontSize: 14,
  },
  fab: {
    position: 'absolute',
    bottom: 28,
    right: 20,
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 24,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 4,
  },
  fabLabel: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 15,
    color: '#fff',
  },
  scroll: { flex: 1 },
  scrollContent: {
    paddingTop: 12,
    paddingBottom: 100,
  },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 40,
    paddingTop: 80,
    gap: 12,
  },
  emptyTitle: {
    fontFamily: 'DMSans_500Medium',
    fontSize: 16,
    textAlign: 'center',
  },
  emptyHint: {
    fontFamily: 'DMSans_400Regular',
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 22,
  },
  // Block shared
  blockContainer: {
    marginHorizontal: 16,
    marginVertical: 6,
    padding: 16,
    borderRadius: 10,
  },
  blockTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 14,
    marginBottom: 10,
  },
  // Tasks
  taskRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 8,
  },
  taskCircle: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: '#666',
    alignItems: 'center',
    justifyContent: 'center',
  },
  taskCheck: {
    color: '#fff',
    fontSize: 11,
    fontFamily: 'DMSans_700Bold',
  },
  taskText: {
    flex: 1,
    fontFamily: 'DMSans_400Regular',
    fontSize: 15,
    lineHeight: 22,
  },
  taskTextDone: {
    textDecorationLine: 'line-through',
    opacity: 0.5,
  },
  // Note
  noteBlock: {
    borderLeftWidth: 4,
    borderRadius: 0,
    borderTopRightRadius: 8,
    borderBottomRightRadius: 8,
  },
  noteContent: {
    fontFamily: 'DMSans_400Regular',
    fontSize: 15,
    lineHeight: 24,
  },
  // Links
  linkRow: {
    paddingVertical: 8,
    gap: 2,
  },
  linkLabel: {
    fontFamily: 'DMSans_500Medium',
    fontSize: 15,
  },
  linkUrl: {
    fontFamily: 'DMSans_400Regular',
    fontSize: 12,
  },
  // Code
  codeBlock: {
    backgroundColor: '#1a1a1a',
    borderRadius: 10,
  },
  codeLanguage: {
    fontFamily: 'DMSans_500Medium',
    fontSize: 11,
    letterSpacing: 0.5,
    marginBottom: 8,
    opacity: 0.7,
  },
  codeContent: {
    fontSize: 13,
    color: '#e0e0e0',
    lineHeight: 20,
  },
  // Button
  buttonBlockDesc: {
    fontFamily: 'DMSans_400Regular',
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 12,
  },
  buttonBlockBtn: {
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
  },
  buttonBlockLabel: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 15,
    color: '#fff',
  },
  // File viewer modal
  fileModalRoot: { flex: 1 },
  fileModalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  fileModalTitle: {
    flex: 1,
    fontFamily: 'DMSans_700Bold',
    fontSize: 16,
  },
  fileModalClose: { paddingLeft: 16 },
  fileModalCloseLabel: {
    fontFamily: 'DMSans_500Medium',
    fontSize: 15,
  },
  fileModalScroll: { flex: 1 },
  fileModalContent: { padding: 20, paddingBottom: 60 },
  // File tabs
  tabStrip: {
    flexDirection: 'row',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.08)',
  },
  tabPill: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  tabLabel: {
    fontFamily: 'DMSans_500Medium',
    fontSize: 13,
  },
  tabContent: {
    padding: 16,
  },
  // Input
  inputField: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    padding: 12,
    fontSize: 15,
    fontFamily: 'DMSans_400Regular',
    lineHeight: 24,
    minHeight: 100,
  },
  // Section
  sectionBlock: {
    marginHorizontal: 16,
    marginVertical: 14,
    alignItems: 'center',
    flexDirection: 'row',
  },
  sectionLine: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
  },
  sectionLabel: {
    fontFamily: 'DMSans_500Medium',
    fontSize: 11,
    letterSpacing: 0.8,
    paddingHorizontal: 12,
    position: 'absolute',
    alignSelf: 'center',
  },
});
