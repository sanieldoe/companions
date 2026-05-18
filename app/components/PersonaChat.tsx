import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, StyleSheet, KeyboardAvoidingView, Platform,
  PanResponder, TouchableOpacity, Modal, FlatList, TextInput,
  ActivityIndicator, RefreshControl, Alert,
} from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { getItem } from '../lib/storage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useStore, getAccent, MODE_EMOJIS, MODE_ACCENTS, getModeName, getModeEmoji, ConversationMeta } from '../lib/store';
import { apiFetch } from '../lib/api';
import { useTheme } from '../lib/theme';
import { wsService } from '../lib/ws';

import MessageList from './MessageList';
import InputBar from './InputBar';
import SleepingOverlay from './SleepingOverlay';
import SettingsModal from './SettingsModal';


interface PersonaChatProps {
  persona: 'mentor' | 'shapeshifter';
}

type ProjectLeaf = { type: 'leaf', slug: string, name: string }
type ProjectContainer = { type: 'container', isFolder?: boolean, slug: string, name: string, children: ProjectLeaf[] }
type ProjectNode = ProjectLeaf | ProjectContainer

export default function PersonaChat({ persona }: PersonaChatProps) {
  const insets = useSafeAreaInsets();

  const connected = useStore((s) => s.connected);
  const agentState = useStore((s) => s.agentState);
  const messages = useStore((s) => s.messages);
  const streamingText = useStore((s) => s.streamingText);
  const currentMode = useStore((s) => s.currentMode);
  const modes = useStore((s) => s.modes);
  const conversations = useStore((s) => s.conversations);
  const activeConversationId = useStore((s) => s.activeConversationId);
  const setCredentials = useStore((s) => s.setCredentials);
  const addUserMessage = useStore((s) => s.addUserMessage);
  const newConversation = useStore((s) => s.newConversation);
  const isDark = useStore((s) => s.isDark);
  const toggleTheme = useStore((s) => s.toggleTheme);
  const currentProjectSlug = useStore((s) => s.currentProjectSlug);
  const setCurrentProject = useStore((s) => s.setCurrentProject);
  const requestedChatPersona = useStore((s) => s.requestedChatPersona);
  const setRequestedChatPersona = useStore((s) => s.setRequestedChatPersona);

  const activeTitle = conversations.find((c) => c.id === activeConversationId)?.title ?? '';

  const [settingsVisible, setSettingsVisible] = useState(false);
  const [settingsSection, setSettingsSection] = useState<'model' | 'history' | undefined>(undefined);

  // Active persona toggle (Mentor tab can summon Shapeshifter)
  const [activePersona, setActivePersona] = useState<'mentor' | 'shapeshifter'>(persona);

  // Project picker state (Saniel only)
  const [projectPickerVisible, setProjectPickerVisible] = useState(false);
  const [projectTree, setProjectTree] = useState<ProjectNode[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [createType, setCreateType] = useState<'project' | 'folder'>('project');
  const [creatingProject, setCreatingProject] = useState(false);
  const [selectedParent, setSelectedParent] = useState<string | null>(null);
  const [expandedContainers, setExpandedContainers] = useState<Set<string>>(new Set());

  // True once the server has confirmed our mode — suppresses premature auto-routing
  const modeSynced = useRef(false);
  // Guard: consume requestedChatPersona at most once per mount
  const personaHandoffConsumed = useRef(false);

  const accent = getAccent(currentMode, modes);
  const theme = useTheme();
  const personaEmoji = getModeEmoji(activePersona, modes);
  const personaAccent = MODE_ACCENTS[activePersona] ?? accent;
  const personaName = getModeName(activePersona, modes);

  useEffect(() => {
    async function init() {
      const storedUrl = await getItem('serverUrl');
      const storedToken = await getItem('token');
      if (!storedUrl || !storedToken) { router.replace('/setup'); return; }
      setCredentials(storedUrl, storedToken);
      wsService.connect();
    }
    init();
    // Don't disconnect on unmount — sibling persona tab may still need the socket
  }, []);

  const switchModeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Lock to this persona on mount AND whenever this tab regains focus.
  // Debounced so rapid swipes don't flood the server with switch_mode messages.
  useFocusEffect(
    useCallback(() => {
      modeSynced.current = false;
      // If Ruse canvas navigated here requesting Ruse persona, honour it once.
      // Guard prevents double-fire on rapid focus events.
      let effectivePersona = persona;
      if (requestedChatPersona && !personaHandoffConsumed.current) {
        personaHandoffConsumed.current = true;
        effectivePersona = requestedChatPersona;
        setActivePersona(requestedChatPersona);
        setRequestedChatPersona(null);
      }
      if (switchModeTimer.current) clearTimeout(switchModeTimer.current);
      switchModeTimer.current = setTimeout(() => {
        if (useStore.getState().agentState === 'idle') {
          wsService.send({ type: 'switch_mode', mode: effectivePersona });
        }
      }, 150);
      return () => {
        if (switchModeTimer.current) clearTimeout(switchModeTimer.current);
      };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [persona, requestedChatPersona])
  );

  // Auto-route: if server switches to the other chat persona, navigate there.
  // Only fires after modeSynced to prevent bouncing during tab transitions.
  useEffect(() => {
    if (currentMode === persona) {
      modeSynced.current = true;
      return;
    }
    if (!modeSynced.current) return;
    if (currentMode === 'mentor') {
      router.replace('/(tabs)/mentor');
    } else if (currentMode === 'shapeshifter') {
      router.replace('/(tabs)/shapeshifter');
    }
  }, [currentMode, persona]);

  const handleSend = useCallback((text: string, file?: { name: string; content: string; mime: string }) => {
    const isImage = file?.mime.startsWith('image/');
    const fileIcon = isImage ? '🖼️' : '📄';
    const displayText = file ? `${text ? text + '\n' : ''}${fileIcon} ${file.name}`.trim() : text;
    addUserMessage(displayText);
    const convId = useStore.getState().ensureConversation();
    wsService.send({ type: 'message', text, project: currentProjectSlug, persona: activePersona, fileName: file?.name, fileContent: file?.content, fileMime: file?.mime, conversationId: convId });
  }, [addUserMessage, currentProjectSlug, activePersona]);

  const handleAbort = useCallback(() => { wsService.send({ type: 'abort' }); }, []);

  const loadProjects = useCallback(async () => {
    setProjectsLoading(true);
    try {
      const res = await apiFetch('/wiki/projects');
      const data = await res.json() as { ok: boolean; projects: ProjectNode[] };
      setProjectTree(data.projects ?? []);
    } catch {} finally {
      setProjectsLoading(false);
    }
  }, []);

  const handleCreateProject = useCallback(async () => {
    const name = newProjectName.trim();
    if (!name) return;
    setCreatingProject(true);
    try {
      const res = await apiFetch('/wiki/projects', {
        method: 'POST',
        body: JSON.stringify({ name, type: createType, ...(selectedParent ? { parent: selectedParent } : {}) }),
      });
      const data = await res.json() as { ok: boolean; slug: string; name: string; type: string };
      if (data.ok && data.slug) {
        setNewProjectName('');
        setSelectedParent(null);
        await loadProjects();
        if (createType === 'project') {
          setProjectPickerVisible(false);
          await setCurrentProject(data.slug);
        }
      }
    } catch (err: any) {
      Alert.alert("Couldn't save", err?.message ?? 'Please try again.');
    } finally {
      setCreatingProject(false);
    }
  }, [newProjectName, createType, selectedParent, setCurrentProject, loadProjects]);

  const handleSelectProject = useCallback(async (slug: string) => {
    setProjectPickerVisible(false);
    await setCurrentProject(slug);
  }, [setCurrentProject]);

  const handleRenameProject = useCallback((slug: string, currentName: string) => {
    Alert.prompt(
      'Rename Project',
      '',
      async (newName) => {
        if (!newName || !newName.trim() || newName.trim() === currentName) return;
        try {
          const res = await apiFetch(`/wiki/projects/${encodeURIComponent(slug)}`, {
            method: 'PATCH',
            body: JSON.stringify({ name: newName.trim() }),
          });
          const data = await res.json() as { ok: boolean; oldSlug: string; newSlug: string; name: string };
          if (data.ok) {
            await loadProjects();
            if (slug === currentProjectSlug) await setCurrentProject(data.newSlug);
          }
        } catch (err: any) {
          Alert.alert("Couldn't save", err?.message ?? 'Please try again.');
        }
      },
      'plain-text',
      currentName,
    );
  }, [currentProjectSlug, loadProjects, setCurrentProject]);

  const handleDeleteProject = useCallback((slug: string, name: string) => {
    Alert.alert(
      `Delete "${name}"?`,
      '',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            Alert.alert(
              'This cannot be undone.',
              `All conversations in "${name}" will be permanently removed.`,
              [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Yes, delete',
                  style: 'destructive',
                  onPress: async () => {
                    try {
                      await apiFetch(`/wiki/projects/${encodeURIComponent(slug)}`, { method: 'DELETE' });
                      await loadProjects();
                      if (slug === currentProjectSlug) {
                        await setCurrentProject('general');
                        setProjectPickerVisible(false);
                      }
                    } catch (err: any) {
                      Alert.alert("Couldn't save", err?.message ?? 'Please try again.');
                    }
                  },
                },
              ],
            );
          },
        },
      ],
    );
  }, [currentProjectSlug, loadProjects, setCurrentProject]);

  const isStreaming = agentState === 'thinking' || agentState === 'talking';

  // Swipe between mentor and shapeshifter only
  const swipe = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) =>
        Math.abs(g.dx) > 12 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
      onPanResponderRelease: (_, g) => {
        if (Math.abs(g.dx) < 40) return;
        if (persona === 'mentor' && g.dx > 0) {
          router.replace('/(tabs)/tracker');   // Tracker is left of Mentor
        } else if (persona === 'mentor' && g.dx < 0) {
          router.replace('/(tabs)/shapeshifter');
        } else if (persona === 'shapeshifter' && g.dx > 0) {
          router.replace('/(tabs)/mentor');
        } else if (persona === 'shapeshifter' && g.dx < 0) {
          router.replace('/(tabs)/keeper');    // Keeper is right of Shapeshifter
        }
      },
    })
  ).current;

  return (
    <KeyboardAvoidingView
      style={[styles.root, { paddingTop: insets.top, backgroundColor: theme.bg }]}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      {...swipe.panHandlers}
    >
      <View style={[styles.header, { borderBottomColor: theme.border }]}>
        <TouchableOpacity
          onLongPress={() => { setSettingsSection('model'); setSettingsVisible(true); }}
          style={styles.headerPersona}
          activeOpacity={0.7}
        >
          <Text style={[styles.headerPersonaLabel, { color: personaAccent }]}>
            {personaEmoji} {personaName}
          </Text>
        </TouchableOpacity>
        {persona === 'mentor' ? (
          <TouchableOpacity
            onPress={() => { loadProjects(); setProjectPickerVisible(true); }}
            style={styles.headerCentre}
            activeOpacity={0.7}
          >
            <Text style={[styles.headerProjectLabel, { color: theme.textDim }]} numberOfLines={1}>
              📁 {currentProjectSlug === 'general' ? 'General' : currentProjectSlug.split('/').pop()!.replace(/-/g, ' ')} ▾
            </Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            onPress={() => { setSettingsSection('history'); setSettingsVisible(true); }}
            style={styles.headerCentre}
            activeOpacity={0.7}
          >
            <Text style={[styles.headerConvoTitle, { color: theme.textDim }]} numberOfLines={1}>
              {activeTitle}
            </Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity
          onPress={() => { setSettingsSection('history'); setSettingsVisible(true); }}
          onLongPress={() => { setSettingsSection('history'); setSettingsVisible(true); }}
          style={styles.headerBtn}
          activeOpacity={0.7}
        >
          <Text style={styles.headerBtnLabel}>📋</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => { setSettingsSection('model'); setSettingsVisible(true); }}
          onLongPress={() => { setSettingsSection('model'); setSettingsVisible(true); }}
          style={styles.headerBtn}
          activeOpacity={0.7}
        >
          <Text style={styles.headerBtnLabel}>⚙️</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={toggleTheme}
          onLongPress={() => { setSettingsSection(undefined); setSettingsVisible(true); }}
          style={styles.headerBtn}
          activeOpacity={0.7}
        >
          <Text style={styles.headerBtnLabel}>{isDark ? '🌙' : '☀️'}</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.zoneB}>
        {messages.length === 0 && !isStreaming && (
          <View style={styles.emptyChat}>
            <Text style={[styles.emptyChatHint, { color: theme.textDim }]}>
              Send a message to start the conversation.
            </Text>
          </View>
        )}
        <MessageList
          messages={messages}
          streamingText={streamingText}
          accent={personaAccent}
          agentState={agentState}
        />
        {persona === 'mentor' && (
          <TouchableOpacity
            style={[styles.personaFab, { backgroundColor: activePersona === 'mentor' ? MODE_ACCENTS.shapeshifter : MODE_ACCENTS.mentor }]}
            onPress={() => setActivePersona(p => p === 'mentor' ? 'shapeshifter' : 'mentor')}
            activeOpacity={0.85}
          >
            <Text style={styles.personaFabLabel}>
              {activePersona === 'mentor'
                ? `Switch to ${getModeEmoji('shapeshifter', modes)} ${getModeName('shapeshifter', modes)}`
                : `Switch to ${getModeEmoji('mentor', modes)} ${getModeName('mentor', modes)}`}
            </Text>
          </TouchableOpacity>
        )}
      </View>

      <View style={styles.zoneC}>
        <InputBar
          accent={personaAccent}
          isStreaming={isStreaming}
          onSend={handleSend}
          onAbort={handleAbort}
        />
      </View>

      <SleepingOverlay visible={!connected} />
      <SettingsModal visible={settingsVisible} onClose={() => { setSettingsVisible(false); setSettingsSection(undefined); }} section={settingsSection} />

      {/* Project picker modal — Mentor only */}
      {persona === 'mentor' && (
        <Modal
          visible={projectPickerVisible}
          animationType="slide"
          presentationStyle="pageSheet"
          onRequestClose={() => setProjectPickerVisible(false)}
        >
          <View style={[styles.modalRoot, { backgroundColor: theme.bg, paddingTop: insets.top }]}>
            <View style={[styles.modalHeader, { borderBottomColor: theme.border }]}>
              <Text style={[styles.modalTitle, { color: theme.text }]}>Switch Project</Text>
              <TouchableOpacity onPress={() => setProjectPickerVisible(false)} style={styles.modalHeaderBtn}>
                <Text style={[styles.modalHeaderBtnLabel, { color: theme.text }]}>✕</Text>
              </TouchableOpacity>
            </View>

            {/* Create new project or folder */}
            <View style={[styles.createRow, { borderBottomColor: theme.border, backgroundColor: theme.surface }]}>
              <View style={{ flex: 1, gap: 8 }}>
                {/* Project / Folder toggle */}
                <View style={{ flexDirection: 'row', gap: 6 }}>
                  {(['project', 'folder'] as const).map(t => {
                    const active = createType === t;
                    return (
                      <TouchableOpacity
                        key={t}
                        onPress={() => setCreateType(t)}
                        style={[styles.typeToggle, { borderColor: active ? personaAccent : theme.border, backgroundColor: active ? personaAccent : 'transparent' }]}
                        activeOpacity={0.7}
                      >
                        <Text style={[styles.typeToggleLabel, { color: active ? '#fff' : theme.text }]}>
                          {t === 'project' ? '📄 Project' : '📁 Folder'}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
                {selectedParent != null && (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Text style={[styles.parentTag, { backgroundColor: theme.border, color: theme.textDim }]}>
                      under {projectTree.find(n => n.slug === selectedParent)?.name ?? selectedParent}
                    </Text>
                    <TouchableOpacity onPress={() => setSelectedParent(null)} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
                      <Text style={{ color: theme.textDim, fontSize: 13 }}>✕</Text>
                    </TouchableOpacity>
                  </View>
                )}
                <TextInput
                  style={[styles.createInput, { color: theme.text, backgroundColor: theme.inputBg }]}
                  value={newProjectName}
                  onChangeText={setNewProjectName}
                  placeholder={createType === 'folder' ? 'Folder name…' : 'Project name…'}
                  placeholderTextColor={theme.textDim}
                  returnKeyType="done"
                  onSubmitEditing={handleCreateProject}
                />
              </View>
              <TouchableOpacity
                style={[styles.createBtn, { backgroundColor: personaAccent }, (!newProjectName.trim() || creatingProject) && styles.createBtnDisabled]}
                onPress={handleCreateProject}
                disabled={!newProjectName.trim() || creatingProject}
                activeOpacity={0.8}
              >
                <Text style={styles.createBtnLabel}>{creatingProject ? '…' : 'Create'}</Text>
              </TouchableOpacity>
            </View>

            {/* Projects list */}
            {projectsLoading ? (
              <View style={styles.centeredFlex}>
                <ActivityIndicator color={theme.textDim} />
              </View>
            ) : (() => {
                type FlatRow =
                  | { kind: 'container', slug: string, name: string, expanded: boolean, isFolder: boolean }
                  | { kind: 'leaf', slug: string, name: string, indent: number }
                const flatRows: FlatRow[] = [];
                for (const node of projectTree) {
                  if (node.type === 'container') {
                    const expanded = expandedContainers.has(node.slug);
                    flatRows.push({ kind: 'container', slug: node.slug, name: node.name, expanded, isFolder: node.isFolder ?? false });
                    if (expanded) {
                      for (const child of node.children) {
                        flatRows.push({ kind: 'leaf', slug: child.slug, name: child.name, indent: 1 });
                      }
                    }
                  } else {
                    flatRows.push({ kind: 'leaf', slug: node.slug, name: node.name, indent: 0 });
                  }
                }
                return (
                  <FlatList
                    data={flatRows}
                    keyExtractor={item => item.slug}
                    refreshControl={<RefreshControl refreshing={projectsLoading} onRefresh={loadProjects} tintColor={theme.textDim} />}
                    renderItem={({ item }) => {
                      if (item.kind === 'container') {
                        const isActive = !item.isFolder && item.slug === currentProjectSlug;
                        const toggleExpand = () => setExpandedContainers(prev => {
                          const next = new Set(prev); next.has(item.slug) ? next.delete(item.slug) : next.add(item.slug); return next;
                        });
                        return (
                          <View style={[styles.projectRow, { borderBottomColor: theme.border }, isActive && { backgroundColor: theme.surface }]}>
                            <TouchableOpacity
                              style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12 }}
                              onPress={() => item.isFolder ? toggleExpand() : handleSelectProject(item.slug)}
                              activeOpacity={0.7}
                            >
                              <Text style={[styles.projectRowIcon, { color: isActive ? personaAccent : theme.textDim }]}>📁</Text>
                              <View style={styles.projectRowBody}>
                                <Text style={[styles.projectRowName, { color: isActive ? personaAccent : theme.text }]}>{item.name}</Text>
                                <Text style={[styles.projectRowSlug, { color: theme.textFaint }]}>{item.slug}</Text>
                              </View>
                            </TouchableOpacity>
                            {isActive && <Text style={[styles.projectRowCheck, { color: personaAccent }]}>✓</Text>}
                            {!item.isFolder && (
                              <TouchableOpacity hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} onPress={toggleExpand}>
                                <Text style={[styles.projectRowMenu, { color: theme.textDim }]}>{item.expanded ? '▼' : '▶'}</Text>
                              </TouchableOpacity>
                            )}
                            {item.isFolder && (
                              <Text style={[styles.projectRowMenu, { color: theme.textDim }]}>{item.expanded ? '▼' : '▶'}</Text>
                            )}
                            <TouchableOpacity
                              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                              onPress={() => setSelectedParent(item.slug)}
                            >
                              <Text style={[styles.projectRowMenu, { color: theme.textDim }]}>+</Text>
                            </TouchableOpacity>
                          </View>
                        );
                      }
                      // leaf
                      const isActive = item.slug === currentProjectSlug;
                      return (
                        <TouchableOpacity
                          style={[styles.projectRow, { borderBottomColor: theme.border, paddingLeft: 16 + item.indent * 16 }, isActive && { backgroundColor: theme.surface }]}
                          onPress={() => handleSelectProject(item.slug)}
                          activeOpacity={0.7}
                        >
                          <Text style={[styles.projectRowIcon, { color: isActive ? personaAccent : theme.textDim }]}>📁</Text>
                          <View style={styles.projectRowBody}>
                            <Text style={[styles.projectRowName, { color: isActive ? personaAccent : theme.text }]}>{item.name}</Text>
                            <Text style={[styles.projectRowSlug, { color: theme.textFaint }]}>{item.slug}</Text>
                          </View>
                          {isActive && <Text style={[styles.projectRowCheck, { color: personaAccent }]}>✓</Text>}
                          <TouchableOpacity
                            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                            onPress={() => Alert.alert(item.name, undefined, [
                              { text: 'Rename', onPress: () => handleRenameProject(item.slug, item.name) },
                              { text: 'Delete', style: 'destructive', onPress: () => handleDeleteProject(item.slug, item.name) },
                              { text: 'Cancel', style: 'cancel' },
                            ])}
                          >
                            <Text style={[styles.projectRowMenu, { color: theme.textDim }]}>⋯</Text>
                          </TouchableOpacity>
                        </TouchableOpacity>
                      );
                    }}
                    ListHeaderComponent={
                      <TouchableOpacity
                        style={[styles.projectRow, { borderBottomColor: theme.border }, currentProjectSlug === 'general' && { backgroundColor: theme.surface }]}
                        onPress={() => handleSelectProject('general')}
                        activeOpacity={0.7}
                      >
                        <Text style={[styles.projectRowIcon, { color: currentProjectSlug === 'general' ? personaAccent : theme.textDim }]}>💬</Text>
                        <View style={styles.projectRowBody}>
                          <Text style={[styles.projectRowName, { color: currentProjectSlug === 'general' ? personaAccent : theme.text }]}>General</Text>
                          <Text style={[styles.projectRowSlug, { color: theme.textFaint }]}>general</Text>
                        </View>
                        {currentProjectSlug === 'general' && <Text style={[styles.projectRowCheck, { color: personaAccent }]}>✓</Text>}
                      </TouchableOpacity>
                    }
                    ListEmptyComponent={
                      <View style={styles.centeredFlex}>
                        <Text style={[styles.emptyText, { color: theme.textDim }]}>No projects yet.{'\n'}Create one above.</Text>
                      </View>
                    }
                    contentContainerStyle={flatRows.length === 0 ? styles.emptyListContent : undefined}
                  />
                );
              })()}
          </View>
        </Modal>
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#0D0B08',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerPersona: {
    paddingVertical: 4,
    paddingRight: 8,
    flexShrink: 0,
  },
  headerPersonaLabel: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 17,
  },
  headerCentre: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  headerConvoTitle: {
    fontFamily: 'DMSans_400Regular',
    fontSize: 13,
  },
  headerProjectLabel: {
    fontFamily: 'DMSans_500Medium',
    fontSize: 13,
  },
  headerBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  headerBtnLabel: {
    fontSize: 16,
    fontFamily: 'DMSans_700Bold',
  },
  zoneB: {
    flex: 1,
  },
  zoneC: {},
  emptyChat: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    pointerEvents: 'none',
  },
  emptyChatHint: {
    fontFamily: 'DMSans_400Regular',
    fontSize: 14,
    textAlign: 'center',
    opacity: 0.5,
  },
  // Modal shared
  modalRoot: { flex: 1 },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  modalTitle: {
    flex: 1,
    fontFamily: 'DMSans_700Bold',
    fontSize: 16,
    textAlign: 'center',
  },
  modalHeaderBtn: { minWidth: 44, alignItems: 'flex-end' },
  modalHeaderBtnLabel: { fontFamily: 'DMSans_500Medium', fontSize: 16 },
  // Project/Folder type toggle
  typeToggle: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1,
  },
  typeToggleLabel: {
    fontFamily: 'DMSans_500Medium',
    fontSize: 13,
  },
  // Create project row
  createRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  createInput: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
    fontFamily: 'DMSans_400Regular',
    fontSize: 15,
  },
  createBtn: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  createBtnDisabled: { opacity: 0.4 },
  createBtnLabel: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 14,
    color: '#fff',
  },
  // Project rows
  projectRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 12,
  },
  projectRowIcon: { fontSize: 18 },
  projectRowBody: { flex: 1, gap: 2 },
  projectRowName: { fontFamily: 'DMSans_500Medium', fontSize: 15 },
  projectRowSlug: { fontFamily: 'DMSans_400Regular', fontSize: 12 },
  projectRowCheck: { fontFamily: 'DMSans_700Bold', fontSize: 16 },
  projectRowMenu: { fontFamily: 'DMSans_400Regular', fontSize: 20, paddingHorizontal: 4 },
  centeredFlex: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  emptyText: { fontFamily: 'DMSans_400Regular', fontSize: 15, textAlign: 'center' },
  emptyListContent: { flexGrow: 1 },
  parentTag: {
    fontFamily: 'DMSans_400Regular',
    fontSize: 12,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    overflow: 'hidden',
  },
  personaFab: {
    position: 'absolute',
    top: 12,
    left: 16,
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 22,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 4,
  },
  personaFabLabel: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 14,
    color: '#fff',
  },
});
