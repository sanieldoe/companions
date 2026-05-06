import React, { useEffect, useState } from 'react';
import { Keyboard, Text } from 'react-native';
import { Tabs, router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as SecureStore from 'expo-secure-store';

import { useTheme } from '../../lib/theme';
import { getPersonaEmoji, useStore } from '../../lib/store';
import { wsService } from '../../lib/ws';
import { GlobalCaptureModal } from '../../components/GlobalCaptureModal';

function TabIcon({ emoji, focused }: { emoji: string; focused: boolean }) {
  return (
    <Text style={{ fontSize: 24, opacity: focused ? 1 : 0.4 }}>{emoji}</Text>
  );
}

export default function TabsLayout() {
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const setIsDark = useStore((s) => s.setIsDark);
  const setCredentials = useStore((s) => s.setCredentials);
  const personas = useStore((s) => s.personas);
  const hydratePersonas = useStore((s) => s.hydratePersonas);
  const syncPersonas = useStore((s) => s.syncPersonas);

  // Load credentials once for the whole tab layout — ensures Tracker and Keeper
  // can reach the server without needing to visit Mentor/Shapeshifter first.
  useEffect(() => {
    async function init() {
      await hydratePersonas();
      const storedUrl = await SecureStore.getItemAsync('serverUrl');
      const storedToken = await SecureStore.getItemAsync('token');
      if (!storedUrl || !storedToken) {
        router.replace('/setup');
        return;
      }
      setCredentials(storedUrl, storedToken);
      await syncPersonas();
      wsService.connect();
    }
    init();
  }, []);

  const [keyboardVisible, setKeyboardVisible] = useState(false);

  useEffect(() => {
    SecureStore.getItemAsync('isDark').then((v) => {
      if (v !== null) setIsDark(v === 'true');
    });
  }, []);

  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', () => setKeyboardVisible(true));
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboardVisible(false));
    return () => { show.remove(); hide.remove(); };
  }, []);

  const tabBarStyle = keyboardVisible
    ? { display: 'none' as const }
    : {
        backgroundColor: theme.bg,
        borderTopColor: theme.border,
        borderTopWidth: 1,
        height: 64 + insets.bottom,
        paddingBottom: insets.bottom,
        paddingTop: 8,
      };

  return (
    <>
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarShowLabel: false,
          tabBarStyle,
        }}
      >
        <Tabs.Screen
          name="tracker"
          options={{
            tabBarActiveTintColor: '#42A5F5',
            tabBarIcon: ({ focused }) => <TabIcon emoji={getPersonaEmoji('tracker', personas)} focused={focused} />,
          }}
        />
        <Tabs.Screen
          name="mentor"
          options={{
            tabBarActiveTintColor: '#4CAF50',
            tabBarIcon: ({ focused }) => <TabIcon emoji={getPersonaEmoji('mentor', personas)} focused={focused} />,
          }}
        />
        <Tabs.Screen
          name="shapeshifter"
          options={{
            tabBarActiveTintColor: '#FF6135',
            tabBarIcon: ({ focused }) => <TabIcon emoji={getPersonaEmoji('shapeshifter', personas)} focused={focused} />,
          }}
        />
        <Tabs.Screen
          name="keeper"
          options={{
            tabBarActiveTintColor: '#FFD54F',
            tabBarIcon: ({ focused }) => <TabIcon emoji={getPersonaEmoji('keeper', personas)} focused={focused} />,
          }}
        />
      </Tabs>
      <GlobalCaptureModal />
    </>
  );
}
