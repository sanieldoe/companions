import React, { useRef, useMemo, useCallback } from 'react';
import { ScrollView, View, Text, StyleSheet } from 'react-native';
import { Message, AgentState, getPersonaEmoji, getPersonaName, MODE_ACCENTS, useStore } from '../lib/store';
import { useTheme } from '../lib/theme';
import TypingIndicator from './TypingIndicator';

interface MessageListProps {
  messages: Message[];
  streamingText: string;
  accent: string;
  agentState: AgentState;
}

const TWO_MINUTES = 2 * 60 * 1000;

function formatTime(ts: number): string {
  const d = new Date(ts);
  const h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 || 12;
  const min = m < 10 ? `0${m}` : `${m}`;
  return `${hour}:${min} ${ampm}`;
}

export default function MessageList({ messages, streamingText, accent, agentState }: MessageListProps) {
  const scrollRef = useRef<ScrollView>(null);
  const personas = useStore((s) => s.personas);
  const theme = useTheme();

  const showTyping = agentState === 'thinking' && streamingText.length === 0;

  // M2: Track whether the user is near the bottom so auto-scroll doesn't hijack
  // manual scrolling up through history.
  const isNearBottom = useRef(true);

  const handleScroll = useCallback((e: any) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    const distanceFromBottom = contentSize.height - (contentOffset.y + layoutMeasurement.height);
    isNearBottom.current = distanceFromBottom < 80;
  }, []);

  // M1: Memoize group computation - only recalculates when messages array changes.
  type Group = { role: 'user' | 'assistant'; msgs: Message[]; persona?: string };
  const groups = useMemo(() => {
    const result: Group[] = [];
    for (const msg of messages) {
      const last = result[result.length - 1];
      if (last && last.role === msg.role && last.persona === (msg.persona ?? undefined)) {
        last.msgs.push(msg);
      } else {
        result.push({ role: msg.role, msgs: [msg], persona: msg.persona });
      }
    }
    return result;
  }, [messages]);

  // M1: Memoize rendered bubbles - only recalculates when groups/theme/accent change,
  // not on each streaming token.
  const renderedGroups = useMemo(() => {
    const nodes: React.ReactNode[] = [];
    let prevGroupLastTs: number | null = null;

    for (let gi = 0; gi < groups.length; gi++) {
      const group = groups[gi];
      const firstTs = group.msgs[0].timestamp;
      const lastTs = group.msgs[group.msgs.length - 1].timestamp;

      if (prevGroupLastTs !== null && firstTs - prevGroupLastTs > TWO_MINUTES) {
        nodes.push(
          <Text key={`ts-between-${gi}`} style={[styles.timestamp, { color: theme.textFaint }]}>
            {formatTime(firstTs)}
          </Text>
        );
      }

      for (let mi = 0; mi < group.msgs.length; mi++) {
        const msg = group.msgs[mi];
        const isLast = mi === group.msgs.length - 1;
        const isFirst = mi === 0;
        const isUser = msg.role === 'user';

        const assistantBorderColor = !isUser && msg.persona
          ? (MODE_ACCENTS[msg.persona] ?? 'transparent')
          : 'transparent';

        const bubbleStyle = isUser
          ? [styles.bubble, styles.userBubble, { backgroundColor: accent }, !isLast && styles.userBubbleGrouped]
          : [styles.bubble, styles.assistantBubble, { backgroundColor: theme.surface }, !isLast && styles.assistantBubbleGrouped, { borderLeftWidth: 2, borderLeftColor: assistantBorderColor }];

        nodes.push(
          <View key={msg.id} style={[styles.bubbleWrapper, isUser ? styles.wrapperUser : styles.wrapperAssistant, !isFirst && { marginTop: 2 }]}>
            {isFirst && !isUser && msg.persona && (
              <Text style={[styles.personaLabel, { color: MODE_ACCENTS[msg.persona] ?? theme.textDim }]}> 
                {getPersonaEmoji(msg.persona, personas)} {getPersonaName(msg.persona, personas)}
              </Text>
            )}
            <View style={bubbleStyle}>
              <Text selectable style={[styles.bubbleText, isUser ? styles.userText : { color: theme.text }]}>
                {msg.text}
              </Text>
            </View>
          </View>
        );
      }

      nodes.push(
        <Text key={`ts-after-${gi}`} style={[styles.timestamp, { color: theme.textFaint }]}>
          {formatTime(lastTs)}
        </Text>
      );

      prevGroupLastTs = lastTs;
    }
    return nodes;
  }, [groups, theme, accent, personas]);

  const hasContent = messages.length > 0 || streamingText.length > 0 || showTyping;

  return (
    <ScrollView
      ref={scrollRef}
      style={styles.scroll}
      contentContainerStyle={[styles.content, !hasContent && styles.empty]}
      showsVerticalScrollIndicator={false}
      onContentSizeChange={() => {
        if (isNearBottom.current) scrollRef.current?.scrollToEnd({ animated: false });
      }}
      onScroll={handleScroll}
      scrollEventThrottle={100}
    >
      {renderedGroups}
      {showTyping && (
        <View key="typing" style={[styles.bubbleWrapper, styles.wrapperAssistant]}>
          <TypingIndicator />
        </View>
      )}
      {!showTyping && streamingText.length > 0 && (
        <View key="streaming" style={[styles.bubbleWrapper, styles.wrapperAssistant]}>
          <View style={[styles.bubble, styles.assistantBubble, { backgroundColor: theme.surface }]}>
            <Text selectable style={[styles.bubbleText, { color: theme.text }]}>{streamingText}</Text>
          </View>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
  },
  content: {
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  empty: {
    flex: 1,
  },
  bubbleWrapper: {
    marginTop: 8,
  },
  wrapperUser: {
    alignItems: 'flex-end',
  },
  wrapperAssistant: {
    alignItems: 'flex-start',
  },
  bubble: {
    maxWidth: '80%',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 18,
  },
  userBubble: {
    borderBottomRightRadius: 4,
  },
  userBubbleGrouped: {
    borderBottomRightRadius: 18,
  },
  assistantBubble: {
    borderBottomLeftRadius: 4,
  },
  assistantBubbleGrouped: {
    borderBottomLeftRadius: 18,
  },
  bubbleText: {
    fontSize: 15,
    lineHeight: 22,
    fontFamily: 'DMSans_400Regular',
  },
  userText: {
    color: '#FFFFFF',
  },
  timestamp: {
    fontFamily: 'DMSans_400Regular',
    fontSize: 11,
    textAlign: 'center',
    marginTop: 4,
    marginBottom: 2,
  },
  personaLabel: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 12,
    marginBottom: 3,
    marginLeft: 2,
  },
});
