import React, { useEffect, useRef } from 'react';
import { View, Animated, StyleSheet, Text } from 'react-native';
import { useTheme } from '../lib/theme';

function Dot({ delay, dotColor }: { delay: number; dotColor: string }) {
  const scale = useRef(new Animated.Value(0.4)).current;

  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.delay(delay),
        Animated.timing(scale, { toValue: 1, duration: 300, useNativeDriver: true }),
        Animated.timing(scale, { toValue: 0.4, duration: 300, useNativeDriver: true }),
        Animated.delay(600),
      ])
    );
    animation.start();
    return () => animation.stop();
  }, []);

  return <Animated.View style={[styles.dot, { transform: [{ scale }], backgroundColor: dotColor }]} />;
}

export default function TypingIndicator() {
  const reasoningOpacity = useRef(new Animated.Value(0)).current;
  const theme = useTheme();

  useEffect(() => {
    const timeout = setTimeout(() => {
      Animated.timing(reasoningOpacity, {
        toValue: 1,
        duration: 300,
        useNativeDriver: true,
      }).start();
    }, 8000);
    return () => clearTimeout(timeout);
  }, []);

  return (
    <View style={styles.container}>
      <View style={[styles.bubble, { backgroundColor: theme.surface }]}>
        <Dot delay={0} dotColor={theme.textDim} />
        <Dot delay={150} dotColor={theme.textDim} />
        <Dot delay={300} dotColor={theme.textDim} />
      </View>
      <Animated.Text style={[styles.reasoning, { opacity: reasoningOpacity, color: theme.textFaint }]}>
        Reasoning…
      </Animated.Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignSelf: 'flex-start',
  },
  bubble: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 18,
    borderBottomLeftRadius: 6,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 5,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  reasoning: {
    fontFamily: 'DMSans_400Regular',
    fontSize: 11,
    textAlign: 'center',
    marginTop: 6,
  },
});
