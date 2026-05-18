import React, { useRef, useEffect } from 'react';
import { View, Text, TouchableOpacity, Animated, StyleSheet } from 'react-native';
import { ModeInfo, MODE_EMOJIS, MODE_ACCENTS, useStore } from '../lib/store';
import { useTheme } from '../lib/theme';

const FALLBACK_MODES: ModeInfo[] = [
  { id: 'mentor',       name: 'Mentor',       emoji: '🐢', accent: MODE_ACCENTS['mentor'],       mascot: 'frog' },
  { id: 'shapeshifter', name: 'Shapeshifter', emoji: '🦞', accent: MODE_ACCENTS['shapeshifter'], mascot: 'fox'  },
  { id: 'keeper',       name: 'Keeper',       emoji: '🐝', accent: MODE_ACCENTS['keeper'],       mascot: 'bee'  },
  { id: 'tracker',      name: 'Tracker',      emoji: '🐙', accent: MODE_ACCENTS['tracker'],      mascot: 'bird' },
];

function Pill({ mode, isActive, onPress }: { mode: ModeInfo; isActive: boolean; onPress: () => void }) {
  const scale = useRef(new Animated.Value(1)).current;
  const emoji = mode.emoji || MODE_EMOJIS[mode.id] || '●';
  const theme = useTheme();

  return (
    <Animated.View style={{ transform: [{ scale }] }}>
      <TouchableOpacity
        style={[
          styles.pill,
          isActive ? { backgroundColor: mode.accent } : { backgroundColor: theme.surface },
        ]}
        onPress={onPress}
        onPressIn={() => Animated.timing(scale, { toValue: 0.93, duration: 80, useNativeDriver: true }).start()}
        onPressOut={() => Animated.timing(scale, { toValue: 1, duration: 120, useNativeDriver: true }).start()}
        activeOpacity={1}
      >
        <Text style={styles.pillEmoji}>{emoji}</Text>
        <Text style={[styles.pillName, isActive ? styles.pillNameActive : { color: theme.textDim, fontFamily: 'DMSans_400Regular' }]}>
          {mode.name}
        </Text>
      </TouchableOpacity>
    </Animated.View>
  );
}

interface ModeHeaderProps {
  currentMode: string;
  modes: ModeInfo[];
  onSwitchMode: (mode: string) => void;
}

export default function ModeHeader({ currentMode, modes, onSwitchMode }: ModeHeaderProps) {
  const displayModes = modes.length > 0 ? modes : FALLBACK_MODES;
  const theme = useTheme();
  const isDark = useStore((s) => s.isDark);
  const toggleTheme = useStore((s) => s.toggleTheme);
  const autoRoute = useStore((s) => s.autoRoute);
  const toggleAutoRoute = useStore((s) => s.toggleAutoRoute);
  const routeToast = useStore((s) => s.routeToast);

  // Animated opacity for the toast pill
  const toastOpacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (routeToast) {
      Animated.timing(toastOpacity, {
        toValue: 1,
        duration: 200,
        useNativeDriver: true,
      }).start();
    } else {
      Animated.timing(toastOpacity, {
        toValue: 0,
        duration: 300,
        useNativeDriver: true,
      }).start();
    }
  }, [routeToast, toastOpacity]);

  const accent = MODE_ACCENTS[currentMode] ?? '#4CAF50';

  return (
    <View style={[styles.wrapper, { borderBottomColor: theme.border }]}>
      <View style={styles.row}>
        <View style={styles.pills}>
          {displayModes.map((m) => (
            <Pill
              key={m.id}
              mode={m}
              isActive={m.id === currentMode}
              onPress={() => onSwitchMode(m.id)}
            />
          ))}
        </View>
        <TouchableOpacity
          style={styles.themeBtn}
          onPress={toggleAutoRoute}
          activeOpacity={0.7}
        >
          <Text style={[styles.autoIcon, { opacity: autoRoute ? 1 : 0.35 }]}>A</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.themeBtn}
          onPress={toggleTheme}
          activeOpacity={0.7}
        >
          <Text style={styles.themeBtnIcon}>{isDark ? '☀️' : '🌙'}</Text>
        </TouchableOpacity>
      </View>
      {/* Auto-route toast pill */}
      <Animated.View
        style={[styles.toastPill, { backgroundColor: accent, opacity: toastOpacity }]}
        pointerEvents="none"
      >
        <Text style={styles.toastText}>{routeToast} ✓</Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    paddingVertical: 10,
    borderBottomWidth: 1,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
  },
  pills: {
    flex: 1,
    flexDirection: 'row',
    justifyContent: 'space-evenly',
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 22,
  },
  pillEmoji: {
    fontSize: 16,
  },
  pillName: {
    fontSize: 14,
  },
  pillNameActive: {
    color: '#fff',
    fontFamily: 'DMSans_700Bold',
  },
  themeBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  themeBtnIcon: {
    fontSize: 20,
  },
  autoIcon: {
    fontSize: 15,
    fontFamily: 'DMSans_700Bold',
    color: '#fff',
  },
  toastPill: {
    position: 'absolute',
    bottom: -14,
    alignSelf: 'center',
    paddingHorizontal: 14,
    paddingVertical: 4,
    borderRadius: 12,
    zIndex: 10,
  },
  toastText: {
    fontSize: 12,
    color: '#fff',
    fontFamily: 'DMSans_700Bold',
  },
});
