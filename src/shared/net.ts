// Shared fetch utility with size limits and JSON parsing
export async function fetchJsonCapped(url: string, maxBytes = 1_500_000): Promise<any> {
  const res = await fetch(url, { method: 'GET' });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  const text = await res.text();
  if (text.length > maxBytes) throw new Error('Response exceeds size limit');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Invalid JSON response');
  }
}
