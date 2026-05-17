import React, { useEffect, useState } from 'react';
import { Keyboard, Text } from 'react-native';
import { Tabs, router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getItem } from '../../lib/storage';
import { useTheme } from '../../lib/theme';
import { useStore, getModeEmoji } from '../../lib/store';
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
  const setModes = useStore((s) => s.setModes);
  const modes = useStore((s) => s.modes);

  // Load credentials once for the whole tab layout — ensures Cal and Hive
  // can reach the server without needing to visit Saniel/Ruse first.
  useEffect(() => {
    async function init() {
      // Restore cached modes immediately so tab icons show before WS connects
      const cached = await AsyncStorage.getItem('cachedModes');
      if (cached) {
        try { setModes(JSON.parse(cached)); } catch {}
      }
      const storedUrl = await getItem('serverUrl');
      const storedToken = await getItem('token');
      if (!storedUrl || !storedToken) {
        router.replace('/setup');
        return;
      }
      setCredentials(storedUrl, storedToken);
      wsService.connect();
    }
    init();
  }, []);

  const [keyboardVisible, setKeyboardVisible] = useState(false);

  useEffect(() => {
    getItem('isDark').then((v) => {
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
            tabBarIcon: ({ focused }) => <TabIcon emoji={getModeEmoji('tracker', modes) || '🐙'} focused={focused} />,
          }}
        />
        <Tabs.Screen
          name="mentor"
          options={{
            tabBarActiveTintColor: '#4CAF50',
            tabBarIcon: ({ focused }) => <TabIcon emoji={getModeEmoji('mentor', modes) || '🐢'} focused={focused} />,
          }}
        />
        <Tabs.Screen
          name="shapeshifter"
          options={{
            tabBarActiveTintColor: '#FF6135',
            tabBarIcon: ({ focused }) => <TabIcon emoji={getModeEmoji('shapeshifter', modes) || '🦞'} focused={focused} />,
          }}
        />
        <Tabs.Screen
          name="keeper"
          options={{
            tabBarActiveTintColor: '#FFD54F',
            tabBarIcon: ({ focused }) => <TabIcon emoji={getModeEmoji('keeper', modes) || '🐝'} focused={focused} />,
          }}
        />
      </Tabs>
      <GlobalCaptureModal />
    </>
  );
}
