export function commandName(text) {
  return String(text || '').trim().split(/\s+/)[0].split('@')[0].toLowerCase();
}
