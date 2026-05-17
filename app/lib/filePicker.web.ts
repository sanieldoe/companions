export async function pickFile(): Promise<{ name: string; mimeType: string; base64: string } | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*,.pdf,.txt,.md';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = (reader.result as string).split(',')[1];
        resolve({ name: file.name, mimeType: file.type || 'application/octet-stream', base64 });
      };
      reader.readAsDataURL(file);
    };
    input.click();
  });
}
