// Gateway protocol: skills may embed [PHOTO:url] at the start of a response to
// request a photo message. The gateway strips the marker and surfaces it
// separately so the channel connector can call sendPhoto.

const PHOTO_RE = /^\[PHOTO:([^\]]+)\]\n?/;

export function extractPhoto(text: string): { text: string; photo: string | undefined } {
  const m = PHOTO_RE.exec(text);
  if (!m) return { text, photo: undefined };
  return { text: text.slice(m[0].length).trim(), photo: m[1]! };
}
