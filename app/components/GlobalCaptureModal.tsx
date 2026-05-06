import React, { useState, useCallback } from 'react';
import {
  Modal, View, Text, TextInput, TouchableOpacity,
  KeyboardAvoidingView, Platform, StyleSheet,
} from 'react-native';
import { useStore } from '../lib/store';
import { useTheme } from '../lib/theme';
import { apiFetch } from '../lib/api';

export function GlobalCaptureModal() {
  const theme = useTheme();
  const captureSheetVisible = useStore(s => s.captureSheetVisible);
  const closeCapture = useStore(s => s.closeCapture);

  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const dismiss = useCallback(() => {
    closeCapture();
    setText('');
    setError(null);
    setSaved(false);
  }, [closeCapture]);

  const save = useCallback(async () => {
    if (!text.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch('/wiki/dump', {
        method: 'POST',
        body: JSON.stringify({ text }),
      });
      const data = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Failed to save');
      setSaved(true);
      setTimeout(dismiss, 800);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }, [text, dismiss]);

  return (
    <Modal
      visible={captureSheetVisible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={dismiss}
    >
      <KeyboardAvoidingView
        style={[styles.root, { backgroundColor: theme.bg }]}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={[styles.header, { borderBottomColor: theme.border }]}>
          <TouchableOpacity onPress={dismiss} style={styles.headerBtn}>
            <Text style={[styles.headerBtnLabel, { color: theme.text }]}>✕</Text>
          </TouchableOpacity>
          <Text style={[styles.title, { color: theme.text }]}>Quick Capture</Text>
          <View style={styles.headerBtn} />
        </View>
        <Text style={[styles.hint, { color: theme.textDim }]}>Saved to raw/ — process to wiki later in Keeper</Text>
        <TextInput
          style={[styles.input, { color: theme.text, backgroundColor: theme.inputBg }]}
          value={text}
          onChangeText={setText}
          multiline
          autoFocus
          placeholder="What's on your mind?"
          placeholderTextColor={theme.textDim}
          textAlignVertical="top"
          maxLength={10000}
        />
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <TouchableOpacity
          style={[styles.saveBtn, { backgroundColor: theme.surface, borderColor: theme.border },
            (!text.trim() || saving) && styles.saveBtnDisabled]}
          onPress={save}
          disabled={!text.trim() || saving}
          activeOpacity={0.8}
        >
          <Text style={[styles.saveBtnLabel, { color: theme.text }]}>
            {saved ? '✓ Saved' : saving ? 'Saving…' : 'Save to Raw'}
          </Text>
        </TouchableOpacity>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: 8, height: 52,
  },
  headerBtn: { width: 52, alignItems: 'center', justifyContent: 'center' },
  headerBtnLabel: { fontSize: 18 },
  title: { fontSize: 16, fontFamily: 'DMSans_500Medium' },
  hint: { fontSize: 12, fontFamily: 'DMSans_400Regular', paddingHorizontal: 16, paddingTop: 10, paddingBottom: 4 },
  input: {
    flex: 1, margin: 12, padding: 12, borderRadius: 10,
    fontSize: 15, fontFamily: 'DMSans_400Regular',
  },
  error: { color: '#FF6135', fontSize: 13, paddingHorizontal: 16, paddingBottom: 8 },
  saveBtn: {
    margin: 12, marginTop: 0, padding: 14, borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth, alignItems: 'center',
  },
  saveBtnDisabled: { opacity: 0.4 },
  saveBtnLabel: { fontSize: 15, fontFamily: 'DMSans_500Medium' },
});
