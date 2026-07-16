export type UiTheme = 'dark' | 'light' | 'system';

export function normalizeUiTheme(value: unknown): UiTheme {
  const theme = String(value || '').trim().toLowerCase();
  return theme === 'light' || theme === 'system' ? theme : 'dark';
}

export function normalizeUiBackgroundColor(value: unknown): string {
  const color = String(value || '').trim();
  return /^#[0-9a-f]{6}$/i.test(color) ? color.toUpperCase() : '';
}

export function normalizeUiFontFamily(value: unknown): string {
  const font = String(value || '').trim().replace(/\s+/g, ' ');
  if (!font) return '';
  if (font.length > 80 || /[\u0000-\u001f\u007f"'\\;,{}()<>\[\]]/.test(font) || /\burl\s*\(/i.test(font)) return '';
  return font;
}
