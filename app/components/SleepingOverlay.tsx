import React, { useEffect, useRef } from 'react';
import { View, Text, Animated, StyleSheet } from 'react-native';
import { useTheme } from '../lib/theme';

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

export default function SleepingOverlay({ visible }: SleepingOverlayProps) {
  const opacity = useRef(new Animated.Value(visible ? 1 : 0)).current;
  const breathAnim = useRef(new Animated.Value(0.6)).current;
  const theme = useTheme();

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

  return (
    <Animated.View
      pointerEvents="none"
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
        <Text style={[styles.restingText, { color: theme.textDim }]}>Resting...</Text>
        <Text style={[styles.subText, { color: theme.textFaint }]}>I'll be here when you're back.</Text>
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
  restingText: {
    fontFamily: 'DMSans_400Regular',
    fontSize: 18,
  },
  subText: {
    fontFamily: 'DMSans_400Regular',
    fontSize: 13,
  },
});
