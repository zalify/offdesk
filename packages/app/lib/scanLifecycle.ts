/** Do not navigate away while the native scanner still owns the camera view. */
export async function scanWithCleanup<T>(scan: () => Promise<T>, cancel: () => Promise<void>): Promise<T> {
  try {
    return await scan();
  } finally {
    await cancel();
  }
}
