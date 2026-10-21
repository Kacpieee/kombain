// Klient Directus REST read-only (Astro SSR). Pełne strony w F3-T1.
export async function fetchPublishedArticles(baseUrl: string, token: string) {
  const res = await fetch(`${baseUrl}/items/articles?filter[status][_eq]=published&limit=20`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Directus ${res.status}`);
  return res.json();
}
