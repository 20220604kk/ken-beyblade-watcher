// Playwright keeps API response bodies until dispose() or context.close().
// Warm purchase contexts live for hours; release each body as soon as it is read.
// status(), headers() and url() remain usable (they read response metadata).
export async function readAndReleaseResponse(response, format = 'text') {
  try {
    return await response[format]();
  } finally {
    await releaseResponse(response);
  }
}

export async function releaseResponse(response) {
  try { await response?.dispose?.(); } catch { /* Context may already be closed. */ }
}
