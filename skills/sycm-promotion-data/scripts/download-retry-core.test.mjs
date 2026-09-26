import test from 'node:test';
import assert from 'node:assert/strict';
import { nextDownloadAction } from './download-retry-core.mjs';

test('优先关闭全屏遮挡并刷新', () => {
  assert.deepEqual(nextDownloadAction({ overlayBlocked: true, taskReady: true }), {
    action: 'dismiss-overlay-and-refresh', reason: 'fullscreen-overlay',
  });
});

test('已生成但操作行隐藏时重新激活', () => {
  assert.deepEqual(nextDownloadAction({ taskReady: true, actionVisible: false }), {
    action: 'reactivate-row-and-refresh', reason: 'operation-row-hidden',
  });
});

test('只有任务就绪且操作行可见才点击下载', () => {
  assert.deepEqual(nextDownloadAction({ taskReady: true, actionVisible: true }), {
    action: 'click-download', reason: 'ready',
  });
});
