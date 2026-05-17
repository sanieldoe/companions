import { ScrollViewStyleReset } from 'expo-router/html';

export default function Root({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no" />
        <title>Companion</title>
        <ScrollViewStyleReset />
        <style dangerouslySetInnerHTML={{
          __html: `
            html, body { height: 100%; margin: 0; padding: 0; background: #0D0B08; }
            body { overflow: hidden; }
            #root { display: flex; height: 100%; flex: 1; zoom: 1.6; }
          `
        }} />
      </head>
      <body>
        <div id="root">{children}</div>
      </body>
    </html>
  );
}
