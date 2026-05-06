import React, { useMemo, useRef, useState } from 'react';
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
import * as SecureStore from 'expo-secure-store';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useStore } from '../lib/store';
import { useTheme } from '../lib/theme';

const ACCENT = '#4CAF50';

type Method = 'manual' | 'scan';

function normalizeServerUrl(input: string): string {
  const trimmed = input.trim();
  if (trimmed.match(/^wss?:\/\//i)) return trimmed;
  if (trimmed.match(/^https:\/\//i)) return trimmed.replace(/^https:\/\//i, 'wss://');
  if (trimmed.match(/^http:\/\//i)) return trimmed.replace(/^http:\/\//i, 'ws://');
  const isLocal = /^(localhost|127\.|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(trimmed)
    || trimmed.endsWith('.local');
  return `${isLocal ? 'ws://' : 'wss://'}${trimmed}`;
}

function toHttpBase(serverUrl: string): string {
  return serverUrl.replace(/^ws:\/\//i, 'http://').replace(/^wss:\/\//i, 'https://');
}

function parsePairingPayload(payload: string): { url: string; token: string } | null {
  try {
    const parsed = new URL(payload);
    if (parsed.protocol !== 'companions:') return null;
    const url = parsed.searchParams.get('url');
    const token = parsed.searchParams.get('token');
    if (!url || !token) return null;
    return { url, token };
  } catch {
    return null;
  }
}

export default function SetupScreen() {
  const [method, setMethod] = useState<Method>('manual');
  const [serverUrl, setServerUrl] = useState('');
  const [token, setToken] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [permissions, requestPermission] = useCameraPermissions();
  const scanLocked = useRef(false);

  const setCredentials = useStore((s) => s.setCredentials);
  const syncPersonas = useStore((s) => s.syncPersonas);
  const theme = useTheme();

  const cameraAllowed = useMemo(() => permissions?.granted ?? false, [permissions]);

  async function connect(rawUrl: string, rawToken: string) {
    setError(null);
    setLoading(true);
    try {
      const wsUrl = normalizeServerUrl(rawUrl);
      const trimmedToken = rawToken.trim();
      const httpBase = toHttpBase(wsUrl);

      const health = await fetch(`${httpBase}/api/health`);
      if (!health.ok) {
        throw new Error(`Health check failed (${health.status})`);
      }

      const verify = await fetch(`${httpBase}/api/auth/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: trimmedToken }),
      });

      const verifyBody = await verify.json().catch(() => ({}));
      if (!verify.ok) {
        throw new Error(verifyBody.error ?? `Token verification failed (${verify.status})`);
      }

      await SecureStore.setItemAsync('serverUrl', wsUrl);
      await SecureStore.setItemAsync('token', trimmedToken);

      setCredentials(wsUrl, trimmedToken);
      await syncPersonas();

      router.replace('/');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setLoading(false);
      setTimeout(() => { scanLocked.current = false; }, 1200);
    }
  }

  async function handleManualConnect() {
    const trimmedUrl = serverUrl.trim();
    const trimmedToken = token.trim();
    if (!trimmedUrl) {
      setError('Please enter a server address.');
      return;
    }
    if (!trimmedToken) {
      setError('Please enter an access token.');
      return;
    }
    await connect(trimmedUrl, trimmedToken);
  }

  async function handleScanAgain() {
    setError(null);
    scanLocked.current = false;
    if (!permissions) {
      await requestPermission();
      return;
    }
    if (!permissions.granted) {
      await requestPermission();
    }
  }

  async function handleBarcodeScanned(data: string) {
    if (scanLocked.current || loading) return;
    scanLocked.current = true;
    const parsed = parsePairingPayload(data);
    if (!parsed) {
      setError('That QR code is not a Companions pairing code.');
      setTimeout(() => { scanLocked.current = false; }, 1200);
      return;
    }
    setServerUrl(parsed.url);
    setToken(parsed.token);
    await connect(parsed.url, parsed.token);
  }

  return (
    <KeyboardAvoidingView
      style={[styles.root, { backgroundColor: theme.bg }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <Text style={[styles.title, { color: theme.text }]}>Companions</Text>
        <Text style={[styles.subtitle, { color: theme.textDim }]}>Connect to your server</Text>

        <View style={[styles.methodRow, { backgroundColor: theme.surface, borderColor: theme.border }]}> 
          <TouchableOpacity
            style={[styles.methodBtn, method === 'manual' && { backgroundColor: ACCENT }]}
            onPress={() => setMethod('manual')}
            activeOpacity={0.8}
          >
            <Text style={[styles.methodLabel, { color: method === 'manual' ? '#fff' : theme.text }]}>Enter manually</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.methodBtn, method === 'scan' && { backgroundColor: ACCENT }]}
            onPress={() => setMethod('scan')}
            activeOpacity={0.8}
          >
            <Text style={[styles.methodLabel, { color: method === 'scan' ? '#fff' : theme.text }]}>Scan QR</Text>
          </TouchableOpacity>
        </View>

        {method === 'manual' ? (
          <>
            <View style={styles.field}>
              <Text style={[styles.label, { color: theme.textDim }]}>Server address</Text>
              <TextInput
                style={[styles.input, { backgroundColor: theme.inputBg, color: theme.text }]}
                value={serverUrl}
                onChangeText={setServerUrl}
                placeholder="my-machine.tailnet.ts.net:3000 or https://host"
                placeholderTextColor={theme.textFaint}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
              />
            </View>

            <View style={styles.field}>
              <Text style={[styles.label, { color: theme.textDim }]}>Access token</Text>
              <TextInput
                style={[styles.input, { backgroundColor: theme.inputBg, color: theme.text }]}
                value={token}
                onChangeText={setToken}
                placeholder="Paste the token from setup"
                placeholderTextColor={theme.textFaint}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>

            <TouchableOpacity
              style={[styles.button, { backgroundColor: ACCENT }, loading && styles.buttonDisabled]}
              onPress={handleManualConnect}
              disabled={loading}
              activeOpacity={0.8}
            >
              {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Connect</Text>}
            </TouchableOpacity>
          </>
        ) : (
          <View style={styles.scanSection}>
            {!cameraAllowed ? (
              <View style={[styles.cameraFallback, { backgroundColor: theme.surface, borderColor: theme.border }]}> 
                <Text style={[styles.scanTitle, { color: theme.text }]}>Camera permission required</Text>
                <Text style={[styles.scanBody, { color: theme.textDim }]}>Allow camera access to scan the pairing QR code printed by the setup wizard.</Text>
                <TouchableOpacity style={[styles.button, { backgroundColor: ACCENT }]} onPress={handleScanAgain} activeOpacity={0.8}>
                  <Text style={styles.buttonText}>Enable camera</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <>
                <View style={[styles.cameraFrame, { borderColor: theme.border }]}> 
                  <CameraView
                    style={styles.camera}
                    facing="back"
                    barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                    onBarcodeScanned={({ data }) => handleBarcodeScanned(data)}
                  />
                </View>
                <Text style={[styles.scanBody, { color: theme.textDim }]}>Scan the QR code shown at the end of `npm run setup`.</Text>
                <TouchableOpacity style={[styles.secondaryButton, { borderColor: theme.border }]} onPress={handleScanAgain} activeOpacity={0.8}>
                  <Text style={[styles.secondaryButtonText, { color: theme.text }]}>Scan again</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        )}

        {error && <Text style={styles.error}>{error}</Text>}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
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
    marginBottom: 8,
  },
  methodRow: {
    flexDirection: 'row',
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 4,
    gap: 4,
  },
  methodBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    paddingVertical: 12,
  },
  methodLabel: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 14,
  },
  field: { gap: 6 },
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
  secondaryButton: {
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 8,
    borderWidth: StyleSheet.hairlineWidth,
  },
  secondaryButtonText: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 15,
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 16,
    color: '#fff',
  },
  scanSection: { gap: 14 },
  cameraFrame: {
    height: 360,
    borderRadius: 22,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
  },
  camera: { flex: 1 },
  cameraFallback: {
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 18,
    gap: 12,
  },
  scanTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 18,
  },
  scanBody: {
    fontFamily: 'DMSans_400Regular',
    fontSize: 14,
    lineHeight: 20,
  },
  error: {
    fontFamily: 'DMSans_400Regular',
    fontSize: 14,
    color: '#FF6B6B',
    textAlign: 'center',
    marginTop: 4,
  },
});
