import React, { useState } from 'react';
import { View } from 'react-native';
import { WebView } from 'react-native-webview';

interface CanvasBlock {
  id: string;
  type: string;
  content?: string;
  height?: number;
}

const AUTO_HEIGHT_JS = `
  (function() {
    function postHeight() {
      window.ReactNativeWebView.postMessage(
        String(document.documentElement.scrollHeight || document.body.scrollHeight)
      );
    }
    postHeight();
    new MutationObserver(postHeight).observe(document.body, { childList: true, subtree: true, attributes: true });
  })();
`;

export default function HtmlBlock({ block, theme }: { block: CanvasBlock; theme: { bg: string; text: string } }) {
  const [height, setHeight] = useState<number>(block.height ?? 200);

  const baseStyle = `
    <style>
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body {
        background: ${theme.bg};
        color: ${theme.text};
        font-family: -apple-system, system-ui, sans-serif;
        font-size: 15px;
        line-height: 1.5;
        padding: 0;
      }
    </style>
  `;

  const html = block.content?.includes('<html')
    ? block.content.replace('</head>', `${baseStyle}</head>`)
    : `<!DOCTYPE html><html><head>${baseStyle}</head><body>${block.content ?? ''}</body></html>`;

  return (
    <View style={{ marginHorizontal: 16, marginVertical: 6, padding: 0, borderRadius: 10, overflow: 'hidden', height }}>
      <WebView
        source={{ html }}
        style={{ flex: 1, backgroundColor: 'transparent' }}
        originWhitelist={[]}
        javaScriptEnabled
        domStorageEnabled={false}
        scrollEnabled={false}
        injectedJavaScript={block.height ? undefined : AUTO_HEIGHT_JS}
        onMessage={block.height ? undefined : (e) => {
          const h = parseInt(e.nativeEvent.data, 10);
          if (!isNaN(h) && h > 0) setHeight(h);
        }}
      />
    </View>
  );
}
