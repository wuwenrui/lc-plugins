export const MAX_REQUEST_BYTES = 1024 * 1024

/** One UTF-8 JSON document, bounded before concatenation; EOF is mandatory. */
export async function readPrivateRequest(stream) {
  const chunks = []
  let size = 0
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > MAX_REQUEST_BYTES) throw new Error('Mail request exceeds input limit')
    chunks.push(bytes)
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
  } catch {
    throw new Error('Invalid mail request input')
  }
}
