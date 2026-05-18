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
  Alert,
} from 'react-native';
import { router } from 'expo-router';
import { getItem, setItem, deleteItem } from '../lib/storage';
import { useStore } from '../lib/store';
import { useTheme } from '../lib/theme';

const ACCENT = '#4CAF50';

function friendlyError(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.includes('401') || lower.includes('bad secret') || lower.includes('auth failed')) {
    return 'Wrong secret key. Check the key shown in your server dashboard.';
  }
  if (
    lower.includes('econnrefused') ||
    lower.includes('fetch failed') ||
    lower.includes('network') ||
    lower.includes('enotfound') ||
    lower.includes('timeout')
  ) {
    return "Couldn't reach the server. Make sure you're on the same network (or Tailscale) and the address is correct.";
  }
  if (lower.includes('invalid url') || lower.includes('url')) {
    return 'Invalid server address. It should look like http://192.168.1.x:3000';
  }
  return `Connection failed: ${raw}`;
}

export default function SetupScreen() {
  const [serverUrl, setServerUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setCredentials = useStore((s) => s.setCredentials);
  const theme = useTheme();

  function handleScanQR() {
    Alert.alert(
      'Scan QR Code',
      'Open your server dashboard and tap the QR code to launch the app automatically, or copy the address and secret key manually.',
      [{ text: 'OK' }],
    );
  }

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
        setError(friendlyError(`Auth failed: ${response.status} ${body}`));
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
      setError(friendlyError(msg));
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

        <Text style={[styles.description, { color: theme.textDim }]}>
          Connect to your Companion server to get started.{'\n'}
          Scan the QR code from your server's dashboard, or enter the address and secret key manually.
        </Text>

        <TouchableOpacity
          style={[styles.qrButton, { borderColor: ACCENT }]}
          onPress={handleScanQR}
          activeOpacity={0.7}
        >
          <Text style={[styles.qrButtonText, { color: ACCENT }]}>Scan QR code</Text>
        </TouchableOpacity>

        <View style={styles.dividerRow}>
          <View style={[styles.dividerLine, { backgroundColor: theme.textFaint }]} />
          <Text style={[styles.dividerLabel, { color: theme.textFaint }]}>or enter manually</Text>
          <View style={[styles.dividerLine, { backgroundColor: theme.textFaint }]} />
        </View>

        <View style={styles.field}>
          <Text style={[styles.label, { color: theme.textDim }]}>Server address</Text>
          <TextInput
            style={[styles.input, { backgroundColor: theme.inputBg, color: theme.text }]}
            value={serverUrl}
            onChangeText={setServerUrl}
            placeholder="e.g. http://192.168.1.100:3000"
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
            placeholder="From your server dashboard"
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
    marginBottom: 4,
  },
  description: {
    fontFamily: 'DMSans_400Regular',
    fontSize: 15,
    lineHeight: 22,
    marginBottom: 4,
  },
  qrButton: {
    borderRadius: 14,
    borderWidth: 1.5,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  qrButtonText: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 16,
  },
  dividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    opacity: 0.4,
  },
  dividerLabel: {
    fontFamily: 'DMSans_400Regular',
    fontSize: 13,
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
