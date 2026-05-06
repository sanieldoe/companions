export function apiFetch(
  serverUrl: string,
  token: string,
  path: string,
  options?: RequestInit
): Promise<Response> {
  const httpBase = serverUrl.replace(/^ws:\/\//i, 'http://').replace(/^wss:\/\//i, 'https://')
  return fetch(`${httpBase}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  })
}
