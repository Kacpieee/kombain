export function defaultImageForCategory(_category: string): string {
  return "default-category.webp";
}

export function r2KeyForSlug(slug: string): string {
  return `articles/${slug}.webp`;
}
