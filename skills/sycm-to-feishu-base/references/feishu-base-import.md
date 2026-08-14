# Feishu Bitable Import Notes

## Observed template shape

The template used in validation contained `数据表 2`, `仪表盘`, and `数据表 3`. `数据表 2` exposed the source fields `排名`, `搜索词`, `搜索人气`, `点击率`, and `支付转化率`, followed by classification/AI fields. A structure-only clone opened with zero records and retained the toolbar actions `筛选`, `分组`, and `排序`.

## Browser/CDP rules

- Use the web-access CDP proxy and rediscover targets on every action. Do not persist a target ID.
- Do not open a second browser-level WebSocket. Reuse the Proxy's single connection for all actions and rediscover targets before each action.
- A sleeping copy tab may appear in `/targets` with `pid: 0` and cannot be attached. Open the same copy URL in a new background tab in the same logged-in browser context.

## Paste rule

Feishu's table grid uses a Slate contenteditable editor inside a canvas. A synthetic `ClipboardEvent` can be prevented but still insert all TSV text into one cell. Use a real clipboard plus the Proxy's `POST /paste?target=...` endpoint after selecting the first data cell. The endpoint activates the target before sending `Ctrl+V`; if an edit looks like multiline text in one cell, cancel before it is committed.

## Evidence rule

The bottom count indicator is stronger evidence than the number of currently rendered DOM rows. Pair it with source validation and visible first/last-row checks. AI-generated classification fields may populate asynchronously after the source fields are imported.

## Regression matrix

- Source contract: five headers, non-empty rows, contiguous unique ranks, and preserved `-` values.
- Collection stability: three independent runs with identical row count, page sizes, and CSV content hash.
- Input channel: invalid target returns `400`; a disposable page accepts repeated `/paste` calls through the shared Proxy connection.
- Feishu integration: use a disposable structure-only copy; verify exact record count, first/last rank, five source fields, cloud-save state, and copied views/dashboards after import.
- Session boundary: a successful run proves only the current logged-in session, not future weekly login persistence.

## Known failure modes

- A second browser-level WebSocket can hang after the first successful paste when the shared Proxy already has sessions. Reuse the Proxy connection.
- A background Feishu tab can ignore keyboard input. Activate the target immediately before `/paste`.
- Canvas virtualization hides field headers from ordinary DOM selectors. Read field order from the loaded Bitable model and the active view's visible field IDs.
- Do not treat a successful keyboard command or a visible first page as proof of a complete import.
