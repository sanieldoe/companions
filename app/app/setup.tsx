import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { router } from 'expo-router';
import { getItem, setItem, deleteItem } from '../lib/storage';
import { useStore } from '../lib/store';
import { useTheme } from '../lib/theme';

const ACCENT = '#4CAF50';

export default function SetupScreen() {
  const [serverUrl, setServerUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setCredentials = useStore((s) => s.setCredentials);
  const theme = useTheme();

  async function handleConnect() {
    setError(null);
    const trimmedUrl = serverUrl.trim();
    const trimmedSecret = secret.trim();

    if (!trimmedUrl) {
      setError('Please enter a server address.');
      return;
    }
    if (!trimmedSecret) {
      setError('Please enter a secret key.');
      return;
    }

    // Normalise to ws:// / wss:// for storage (WebSocket URLs)
    // Accepts: bare host:port, ws://, wss://, http://, https://
    let normalised: string;
    if (trimmedUrl.match(/^wss?:\/\//i)) {
      normalised = trimmedUrl;
    } else if (trimmedUrl.match(/^https:\/\//i)) {
      normalised = trimmedUrl.replace(/^https:\/\//i, 'wss://');
    } else if (trimmedUrl.match(/^http:\/\//i)) {
      normalised = trimmedUrl.replace(/^http:\/\//i, 'ws://');
    } else {
      const isLocal = /^(localhost|127\.|192\.168\.|10\.|100\.|172\.(1[6-9]|2\d|3[01])\.)/.test(trimmedUrl)
        || trimmedUrl.endsWith('.local') || trimmedUrl.endsWith('.ts.net');
      normalised = (isLocal ? 'ws://' : 'wss://') + trimmedUrl;
    }

    // Convert ws:// → http:// for auth endpoint
    const httpBase = normalised
      .replace(/^ws:\/\//i, 'http://')
      .replace(/^wss:\/\//i, 'https://');

    setLoading(true);
    const authUrl = `${httpBase}/auth/token`;
    try {
      const response = await fetch(authUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: trimmedSecret }),
      });

      if (!response.ok) {
        const body = await response.text();
        setError(`Auth failed: ${response.status} ${body}`);
        return;
      }

      const data = await response.json() as { token?: string };
      if (!data.token) {
        setError('Server did not return a token.');
        return;
      }

      // Store credentials securely
      await setItem('serverUrl', normalised);
      await setItem('token', data.token);

      // Update store
      setCredentials(normalised, data.token);

      // Navigate to main
      router.replace('/');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Could not connect to ${authUrl}\n${msg}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={[styles.root, { backgroundColor: theme.bg }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={[styles.title, { color: theme.text }]}>Companion</Text>
        <Text style={[styles.subtitle, { color: theme.textDim }]}>Connect to your server</Text>

        <View style={styles.field}>
          <Text style={[styles.label, { color: theme.textDim }]}>Server address</Text>
          <TextInput
            style={[styles.input, { backgroundColor: theme.inputBg, color: theme.text }]}
            value={serverUrl}
            onChangeText={setServerUrl}
            placeholder="192.168.x.x:3000 or wss://host"
            placeholderTextColor={theme.textFaint}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />
        </View>

        <View style={styles.field}>
          <Text style={[styles.label, { color: theme.textDim }]}>Secret key</Text>
          <TextInput
            style={[styles.input, { backgroundColor: theme.inputBg, color: theme.text }]}
            value={secret}
            onChangeText={setSecret}
            placeholder="••••••••"
            placeholderTextColor={theme.textFaint}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>

        <TouchableOpacity
          style={[styles.button, { backgroundColor: ACCENT }, loading && styles.buttonDisabled]}
          onPress={handleConnect}
          disabled={loading}
          activeOpacity={0.8}
        >
          {loading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.buttonText}>Connect</Text>
          )}
        </TouchableOpacity>

        {error && <Text style={styles.error}>{error}</Text>}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  scroll: {
    flexGrow: 1,
    padding: 28,
    paddingTop: 80,
    gap: 20,
  },
  title: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 34,
    marginBottom: 4,
  },
  subtitle: {
    fontFamily: 'DMSans_400Regular',
    fontSize: 16,
    marginBottom: 16,
  },
  field: {
    gap: 6,
  },
  label: {
    fontFamily: 'DMSans_500Medium',
    fontSize: 13,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  input: {
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontFamily: 'DMSans_400Regular',
    fontSize: 16,
  },
  button: {
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 8,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonText: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 16,
    color: '#fff',
  },
  error: {
    fontFamily: 'DMSans_400Regular',
    fontSize: 14,
    color: '#FF6B6B',
    textAlign: 'center',
    marginTop: 4,
  },
});
