import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Animated, StyleSheet, ActivityIndicator, Pressable } from 'react-native';
import { useTheme } from '../lib/theme';
import { useStore } from '../lib/store';
import { wsService } from '../lib/ws';

interface SleepingOverlayProps {
  visible: boolean;
}

const STARS = [
  { top: '8%', left: '12%', size: 2 },
  { top: '15%', left: '72%', size: 1.5 },
  { top: '22%', left: '40%', size: 1 },
  { top: '30%', left: '88%', size: 2 },
  { top: '10%', left: '55%', size: 1 },
  { top: '40%', left: '20%', size: 1.5 },
  { top: '5%', left: '33%', size: 1 },
  { top: '18%', left: '92%', size: 1.5 },
  { top: '35%', left: '60%', size: 1 },
  { top: '28%', left: '5%', size: 2 },
  { top: '12%', left: '80%', size: 1 },
  { top: '45%', left: '78%', size: 1.5 },
];

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

export default function SleepingOverlay({ visible }: SleepingOverlayProps) {
  const opacity = useRef(new Animated.Value(visible ? 1 : 0)).current;
  const breathAnim = useRef(new Animated.Value(0.6)).current;
  const theme = useTheme();
  const disconnectedAt = useStore((s) => s.disconnectedAt);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    Animated.timing(opacity, {
      toValue: visible ? 1 : 0,
      duration: 300,
      useNativeDriver: true,
    }).start();
  }, [visible]);

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(breathAnim, { toValue: 1.0, duration: 2500, useNativeDriver: true }),
        Animated.timing(breathAnim, { toValue: 0.6, duration: 2500, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, []);

  // Tick elapsed seconds while overlay is visible
  useEffect(() => {
    if (!visible) {
      setElapsed(0);
      return;
    }
    const tick = () => {
      if (disconnectedAt != null) {
        setElapsed(Math.floor((Date.now() - disconnectedAt) / 1000));
      } else {
        setElapsed(0);
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [visible, disconnectedAt]);

  // Determine which state to show
  let content: React.ReactNode;
  if (elapsed < 3) {
    // Connecting
    content = (
      <>
        <ActivityIndicator color={theme.textDim} size="small" style={styles.spinner} />
        <Text style={[styles.restingText, { color: theme.textDim }]}>Connecting…</Text>
      </>
    );
  } else if (elapsed < 15) {
    // Reconnecting
    content = (
      <>
        <Text style={[styles.restingText, { color: theme.textDim }]}>Reconnecting…</Text>
        <Text style={[styles.subText, { color: theme.textFaint }]}>{formatElapsed(elapsed)}</Text>
        <Pressable onPress={() => wsService.reconnect()} style={styles.retryButton}>
          <Text style={[styles.retryText, { color: theme.textDim }]}>Tap to retry</Text>
        </Pressable>
      </>
    );
  } else {
    // Offline
    content = (
      <>
        <Text style={[styles.restingText, { color: theme.textDim }]}>Can't reach your server.</Text>
        <Text style={[styles.subText, { color: theme.textFaint }]}>Check Tailscale / your network</Text>
        <Pressable onPress={() => wsService.reconnect()} style={styles.retryButton}>
          <Text style={[styles.retryText, { color: theme.textDim }]}>Tap to retry</Text>
        </Pressable>
      </>
    );
  }

  return (
    <Animated.View
      pointerEvents={visible ? 'auto' : 'none'}
      style={[StyleSheet.absoluteFill, styles.overlay, { opacity, backgroundColor: theme.bg }]}
    >
      {STARS.map((star, i) => (
        <View
          key={i}
          style={[
            styles.star,
            {
              top: star.top as any,
              left: star.left as any,
              width: star.size,
              height: star.size,
              borderRadius: star.size / 2,
            },
          ]}
        />
      ))}

      <Animated.View style={[styles.centreContent, { opacity: breathAnim }]}>
        {content}
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 100,
  },
  star: {
    position: 'absolute',
    backgroundColor: '#ffffff',
    opacity: 0.5,
  },
  centreContent: {
    alignItems: 'center',
    gap: 8,
  },
  spinner: {
    marginBottom: 4,
  },
  restingText: {
    fontFamily: 'DMSans_400Regular',
    fontSize: 18,
  },
  subText: {
    fontFamily: 'DMSans_400Regular',
    fontSize: 13,
  },
  retryButton: {
    marginTop: 4,
    paddingVertical: 6,
    paddingHorizontal: 16,
  },
  retryText: {
    fontFamily: 'DMSans_400Regular',
    fontSize: 13,
    textDecorationLine: 'underline',
  },
});
