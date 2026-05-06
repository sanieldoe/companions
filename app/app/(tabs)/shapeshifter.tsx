import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, RefreshControl, PanResponder, Platform,
} from 'react-native';
import Markdown from 'react-native-markdown-display';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useTheme } from '../../lib/theme';
import { useStore, getPersonaEmoji, getPersonaName, MODE_ACCENTS } from '../../lib/store';
import { apiFetch } from '../../lib/api';
import { wsService } from '../../lib/ws';
import SettingsModal from '../../components/SettingsModal';

const SHAPESHIFTER_ACCENT = MODE_ACCENTS.shapeshifter; // '#FF6135'

// ─── Canvas types ─────────────────────────────────────────────────────────────

interface TaskItem { id: string; text: string; done: boolean }
interface LinkItem { id: string; label: string; url: string }

interface CanvasBlock {
  id: string;
  type: 'markdown' | 'tasks' | 'note' | 'links' | 'code' | 'section' | 'button';
  content?: string;
  title?: string;
  items?: TaskItem[] | LinkItem[];
  color?: 'amber' | 'blue' | 'green' | 'red';
  language?: string;
  label?: string;
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
    blockquote:  { backgroundColor: theme.surface, borderLeftColor: SHAPESHIFTER_ACCENT, borderLeftWidth: 3, paddingHorizontal: 12, paddingVertical: 2, marginVertical: 6, borderRadius: 4 },
    code_inline: { fontFamily: mono, fontSize: 13, backgroundColor: theme.surfaceAlt, color: SHAPESHIFTER_ACCENT, paddingHorizontal: 4, paddingVertical: 2, borderRadius: 4 },
    fence:       { fontFamily: mono, fontSize: 13, backgroundColor: '#1a1a1a', color: '#e0e0e0', padding: 14, borderRadius: 8, marginVertical: 8 },
    code_block:  { fontFamily: mono, fontSize: 13, backgroundColor: '#1a1a1a', color: '#e0e0e0', padding: 14, borderRadius: 8, marginVertical: 8 },
    bullet_list: { marginVertical: 4 },
    ordered_list:{ marginVertical: 4 },
    list_item:   { marginVertical: 2 },
    link:        { color: SHAPESHIFTER_ACCENT, textDecorationLine: 'underline' as const },
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
          <View style={[styles.taskCircle, item.done && { backgroundColor: SHAPESHIFTER_ACCENT, borderColor: SHAPESHIFTER_ACCENT }]}>
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
  return (
    <View style={[styles.blockContainer, styles.noteBlock, { borderLeftColor: borderColor, backgroundColor: bgColor }]}>
      {block.title ? (
        <Text style={[styles.blockTitle, { color: theme.text }]}>{block.title}</Text>
      ) : null}
      {block.content ? (
        <Text style={[styles.noteContent, { color: theme.text }]}>{block.content}</Text>
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
          <Text style={[styles.linkLabel, { color: SHAPESHIFTER_ACCENT }]}>{item.label} →</Text>
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
  onPress,
}: {
  block: CanvasBlock;
  theme: import('../../lib/theme').Theme;
  onPress: () => void;
}) {
  return (
    <View style={[styles.blockContainer, { backgroundColor: theme.surface }]}>
      {block.content ? (
        <Text style={[styles.buttonBlockDesc, { color: theme.textDim }]}>{block.content}</Text>
      ) : null}
      <TouchableOpacity
        style={[styles.buttonBlockBtn, { backgroundColor: SHAPESHIFTER_ACCENT }]}
        onPress={onPress}
        activeOpacity={0.8}
      >
        <Text style={styles.buttonBlockLabel}>{block.label ?? 'Open chat'}</Text>
      </TouchableOpacity>
    </View>
  );
}

// ─── Main screen ──────────────────────────────────────────────────────────────

function toTitleCase(slug: string): string {
  return slug
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export default function ShapeshifterScreen() {
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const isDark = useStore((s) => s.isDark);
  const toggleTheme = useStore((s) => s.toggleTheme);
  const currentProjectSlug = useStore((s) => s.currentProjectSlug);
  const personas = useStore((s) => s.personas);
  const setRequestedChatPersona = useStore((s) => s.setRequestedChatPersona);

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
            onPress={() => {
              setRequestedChatPersona('shapeshifter');
              router.replace('/(tabs)/mentor');
            }}
          />
        );
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
          <Text style={[styles.headerPersona, { color: SHAPESHIFTER_ACCENT }]}>{`${getPersonaEmoji('shapeshifter', personas)} ${getPersonaName('shapeshifter', personas)}`}</Text>
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
                Talk to Mentor to start building this space.{'\n'}
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
        style={[styles.fab, { backgroundColor: SHAPESHIFTER_ACCENT }]}
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
