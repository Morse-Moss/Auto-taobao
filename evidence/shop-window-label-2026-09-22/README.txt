给「窗口标签页」截的图（2026-09-22）。
用途：回答「你说的是哪个窗口」——每家店那张写着店名的页签长什么样，一眼可认。
抓取方式：只读 GET /targets 找 shop-window-label.html，再 GET /screenshot，未改任何页面状态。
已知坑：/targets 字段名是 targetId，不是 id。
