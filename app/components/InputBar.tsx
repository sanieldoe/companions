import React, { useState, useRef } from 'react';
import {
  View,
  TextInput,
  Text,
  TouchableOpacity,
  Animated,
  StyleSheet,
} from 'react-native';
import { useTheme } from '../lib/theme';

interface InputBarProps {
  accent: string;
  isStreaming: boolean;
  onSend: (text: string) => void;
  onAbort: () => void;
}

export default function InputBar({ accent, isStreaming, onSend, onAbort }: InputBarProps) {
  const [text, setText] = useState('');
  const inputRef = useRef<TextInput>(null);
  const canSend = text.trim().length > 0 && !isStreaming;
  const theme = useTheme();

  function handleSend() {
    if (!canSend) return;
    const trimmed = text.trim();
    setText('');
    onSend(trimmed);
  }

  return (
    <View style={styles.wrapper}>
      <View style={styles.inputRow}>
        <TextInput
          ref={inputRef}
          style={[styles.input, { backgroundColor: theme.inputBg, color: theme.text }]}
          value={text}
          onChangeText={setText}
          placeholder="Say something..."
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
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
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
