import { useEffect, useState } from 'react';
import { Redirect } from 'expo-router';
import * as SecureStore from 'expo-secure-store';

export default function Index() {
  const [target, setTarget] = useState<'/(tabs)/tracker' | '/setup' | null>(null);

  useEffect(() => {
    SecureStore.getItemAsync('serverUrl').then((url) =>
      SecureStore.getItemAsync('token').then((token) => {
        setTarget(url && token ? '/(tabs)/tracker' : '/setup');
      })
    );
  }, []);

  if (!target) return null;
  return <Redirect href={target} />;
}
