function resizePtySession(item, cols, rows, onUnexpectedError = null) {
  if (!item || item.exited || item.explicitClose || !item.pty || typeof item.pty.resize !== 'function') return false;
  try {
    item.pty.resize(cols, rows);
    return true;
  } catch (error) {
    const message = error && error.message ? error.message : String(error || '');
    const expectedLifecycleFailure = /ioctl\(\d+\) failed|EIO|EBADF|closed|disposed|not running/i.test(message);
    if (!expectedLifecycleFailure && typeof onUnexpectedError === 'function') onUnexpectedError(error);
    return false;
  }
}

module.exports = { resizePtySession };
