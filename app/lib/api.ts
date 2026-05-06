import * as SecureStore from 'expo-secure-store';
import { useStore } from './store';

export async function apiFetch(path: string, options?: RequestInit): Promise<Response> {
  const { serverUrl, token } = useStore.getState();
  if (!serverUrl || !token) throw new Error('Not connected');
  const httpBase = serverUrl.replace(/^ws:\/\//i, 'http://').replace(/^wss:\/\//i, 'https://');
  const response = await fetch(`${httpBase}${path}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });
  if (response.status === 401) {
    const { router } = await import('expo-router');
    await SecureStore.deleteItemAsync('serverUrl').catch(() => {});
    await SecureStore.deleteItemAsync('token').catch(() => {});
    useStore.getState().setCredentials('', '');
    router.replace('/setup');
  }
  return response;
}
