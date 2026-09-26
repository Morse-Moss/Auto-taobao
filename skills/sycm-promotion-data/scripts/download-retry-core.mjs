export function nextDownloadAction({ overlayBlocked = false, actionVisible = false, taskReady = false } = {}) {
  if (overlayBlocked) return { action: 'dismiss-overlay-and-refresh', reason: 'fullscreen-overlay' };
  if (!taskReady) return { action: 'wait-task', reason: 'task-not-ready' };
  if (!actionVisible) return { action: 'reactivate-row-and-refresh', reason: 'operation-row-hidden' };
  return { action: 'click-download', reason: 'ready' };
}
