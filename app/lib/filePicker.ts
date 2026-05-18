import * as DocumentPicker from 'expo-document-picker';
// expo-file-system v19 split the API. The legacy entrypoint preserves
// `cacheDirectory`, `copyAsync`, `readAsStringAsync`, and `EncodingType`,
// which is what we need for the cross-platform URI normalisation below.
import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';

/**
 * Picks a file and returns it as base64.
 *
 * Cross-platform URI handling:
 *  - iOS photo library can return `ph://` URIs (PhotoKit references) which
 *    `FileSystem.readAsStringAsync` cannot read directly.
 *  - Android (especially API 33+ scoped storage) returns `content://` URIs
 *    from the Storage Access Framework for gallery/media picks. These also
 *    cannot be read by `readAsStringAsync` directly — they must be copied
 *    to the cache first via `FileSystem.copyAsync`, which on Android resolves
 *    `content://` sources through ContentResolver.
 *
 * In both cases we normalise to a `file://` URI in the app's cache dir.
 */
export async function pickFile(): Promise<{ name: string; mimeType: string; base64: string } | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: '*/*',
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (result.canceled) return null;

  const asset = result.assets?.[0];
  if (!asset?.uri) {
    throw new Error('No file URI returned from picker');
  }

  // Sanitise the filename for use as a cache path component. Some Android
  // pickers return names with spaces or characters that need encoding, and
  // some return no name at all.
  const rawName = asset.name && asset.name.length > 0 ? asset.name : `upload-${Date.now()}`;
  const safeName = rawName.replace(/[^A-Za-z0-9._-]/g, '_');

  let uri = asset.uri;

  // Any non-`file://` scheme must be copied into the cache before we can
  // base64-encode it. This covers `ph://` (iOS) and `content://` (Android).
  if (!uri.startsWith('file://')) {
    const cacheDir = FileSystem.cacheDirectory;
    if (!cacheDir) {
      throw new Error('No cache directory available to stage attachment');
    }
    const dest = `${cacheDir}${safeName}`;
    try {
      // Best-effort: remove any stale file at the destination so copyAsync
      // doesn't fail with EEXIST on repeat picks of the same name.
      await FileSystem.deleteAsync(dest, { idempotent: true });
    } catch {
      // ignore — deleteAsync with idempotent:true shouldn't throw, but
      // we don't want a cache-cleanup hiccup to abort the pick.
    }

    try {
      await FileSystem.copyAsync({ from: uri, to: dest });
    } catch (copyErr: any) {
      const platform = Platform.OS;
      const scheme = uri.split(':')[0];
      throw new Error(
        `Failed to stage ${scheme}:// attachment on ${platform}: ${copyErr?.message ?? String(copyErr)}`,
      );
    }
    uri = dest;
  }

  let base64: string;
  try {
    base64 = await FileSystem.readAsStringAsync(uri, {
      encoding: FileSystem.EncodingType.Base64,
    });
  } catch (readErr: any) {
    throw new Error(`Failed to read attachment: ${readErr?.message ?? String(readErr)}`);
  }

  const approxBytes = base64.length * 0.75;
  if (approxBytes > 10 * 1024 * 1024) {
    throw new Error('File is too large (max 10 MB). Try a smaller image or document.');
  }

  return {
    name: rawName,
    mimeType: asset.mimeType ?? 'application/octet-stream',
    base64,
  };
}
