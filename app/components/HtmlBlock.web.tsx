import React from 'react';
import { View } from 'react-native';

export default function HtmlBlock({ html }: { html: string }) {
  return (
    <View style={{ width: '100%', minHeight: 300 }}>
      <iframe
        srcDoc={html}
        sandbox="allow-scripts allow-same-origin"
        style={{ width: '100%', border: 'none', minHeight: 300 }}
        onLoad={(e) => {
          try {
            const h = (e.target as HTMLIFrameElement).contentDocument?.body?.scrollHeight;
            if (h) (e.target as HTMLIFrameElement).style.height = h + 'px';
          } catch {}
        }}
      />
    </View>
  );
}
