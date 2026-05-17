import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';

export async function pickFile(): Promise<{ name: string; mimeType: string; base64: string } | null> {
  const result = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true });
  if (result.canceled) return null;
  const asset = result.assets[0];
  const base64 = await FileSystem.readAsStringAsync(asset.uri, { encoding: FileSystem.EncodingType.Base64 });
  return { name: asset.name, mimeType: asset.mimeType ?? 'application/octet-stream', base64 };
}
