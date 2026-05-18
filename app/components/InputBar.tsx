import React, { useState, useRef } from 'react';
import {
  View,
  TextInput,
  Text,
  TouchableOpacity,
  ActivityIndicator,
  Animated,
  StyleSheet,
  Alert,
} from 'react-native';
import { pickFile } from '../lib/filePicker';
import { useTheme } from '../lib/theme';

export interface AttachedFile {
  name: string;
  content: string;
  mime: string;
  size?: string;
}

interface InputBarProps {
  accent: string;
  isStreaming: boolean;
  onSend: (text: string, file?: AttachedFile) => void;
  onAbort: () => void;
}

export default function InputBar({ accent, isStreaming, onSend, onAbort }: InputBarProps) {
  const [text, setText] = useState('');
  const [file, setFile] = useState<AttachedFile | null>(null);
  const [isPickingFile, setIsPickingFile] = useState(false);
  const inputRef = useRef<TextInput>(null);
  const canSend = (text.trim().length > 0 || file !== null) && !isStreaming;
  const theme = useTheme();

  function formatBytes(bytes: number): string {
    if (bytes >= 1024 * 1024) {
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }
    return `${Math.round(bytes / 1024)} KB`;
  }

  async function handlePickFile() {
    setIsPickingFile(true);
    try {
      const picked = await pickFile();
      if (!picked) return;
      const approxBytes = picked.base64.length * 0.75;
      const size = formatBytes(approxBytes);
      setFile({ name: picked.name, content: picked.base64, mime: picked.mimeType, size });
    } catch (err: any) {
      const message = err?.message ?? String(err);
      console.error('[InputBar] pickFile failed:', err);
      Alert.alert("Couldn't attach file", message || 'Something went wrong reading the file.');
    } finally {
      setIsPickingFile(false);
    }
  }

  function handleSend() {
    if (!canSend) return;
    onSend(text.trim(), file ?? undefined);
    setText('');
    setFile(null);
  }

  return (
    <View style={styles.wrapper}>
      {file && (
        <View style={[styles.fileChip, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <Text style={[styles.fileChipText, { color: theme.text }]} numberOfLines={1}>
            📄 {file.name}{file.size ? ` · ${file.size}` : ''}
          </Text>
          <TouchableOpacity onPress={() => setFile(null)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Text style={[styles.fileChipRemove, { color: theme.textDim }]}>✕</Text>
          </TouchableOpacity>
        </View>
      )}
      <View style={styles.inputRow}>
        <TouchableOpacity style={styles.attachBtn} onPress={handlePickFile} disabled={isStreaming || isPickingFile}>
          {isPickingFile ? (
            <ActivityIndicator size="small" color={theme.textDim} />
          ) : (
            <Text style={[styles.attachIcon, { color: file ? accent : theme.textDim }]}>⊕</Text>
          )}
        </TouchableOpacity>
        <TextInput
          ref={inputRef}
          style={[styles.input, { backgroundColor: theme.inputBg, color: theme.text }]}
          value={text}
          onChangeText={setText}
          placeholder={file ? 'Add a message...' : 'Say something...'}
          placeholderTextColor={theme.textDim}
          multiline
          maxLength={2000}
          onSubmitEditing={handleSend}
          blurOnSubmit={false}
          returnKeyType="send"
        />
        {isStreaming ? (
          <TouchableOpacity
            style={[styles.actionBtn, { backgroundColor: theme.surfaceAlt }]}
            onPress={onAbort}
          >
            <View style={[styles.stopIcon, { backgroundColor: theme.textDim }]} />
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={[styles.actionBtn, { backgroundColor: accent }, !canSend && styles.disabled]}
            onPress={handleSend}
            disabled={!canSend}
          >
            <Text style={styles.sendArrow}>↑</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    paddingHorizontal: 12,
    paddingBottom: 12,
    paddingTop: 8,
  },
  fileChip: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 5,
    marginBottom: 6,
    maxWidth: '85%',
    gap: 6,
  },
  fileChipText: {
    fontSize: 13,
    fontFamily: 'DMSans_400Regular',
    flexShrink: 1,
  },
  fileChipRemove: {
    fontSize: 12,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
  },
  attachBtn: {
    width: 36,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  attachIcon: {
    fontSize: 24,
    lineHeight: 28,
  },
  input: {
    flex: 1,
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 16,
    fontFamily: 'DMSans_400Regular',
    maxHeight: 120,
  },
  actionBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  disabled: {
    opacity: 0.4,
  },
  sendArrow: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '700',
    lineHeight: 22,
  },
  stopIcon: {
    width: 14,
    height: 14,
    borderRadius: 2,
  },
});
