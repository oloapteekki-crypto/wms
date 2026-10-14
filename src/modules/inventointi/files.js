// Tiedoston lukeminen tekstiksi annetulla merkistöllä (Maxx-vienti on ISO-8859-15).
export async function decodeFileText(file, encoding) {
  const buf = await file.arrayBuffer();
  const text = new TextDecoder(encoding).decode(buf);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
