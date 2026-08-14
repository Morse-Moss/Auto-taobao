# 生意参谋搜索排行已验证模式

Updated: 2026-08-04

## Page Contract

- Target route: `https://sycm.taobao.com/mc/free/search_rank`
- Required headers: `排名`, `搜索词`, `搜索人气`, `点击率`, `支付转化率`
- Current weekly category: `家装主材 > 浴缸/淋浴房 > 浴缸 > 普通浴缸`
- Current category query: `parentCateId=201833103`, `cateId=50002411`
- Current category selector leaf: `li.tree-item[title="浴缸 > 普通浴缸"]`

Treat all selectors and IDs as observations from 2026-08-04, not permanent platform contracts.

## Verified UI Patterns

- Read the current day from `.oui-date-picker-current-date`.
- Change a day with the two `.item-date button.arrow` controls. The URL's `dateRange` is an observed result, not the action source.
- Read the page size from `.oui-page-size-select .ant-select-selection-selected-value`.
- Read the active page from `.ant-pagination-item-active` and advance with `.ant-pagination-next`.
- Select the data table by its required header texts. Do not select the fixed operation table or the calendar table.
- Identify data rows by `tr[data-row-key]`.

## Rank Integrity

Numeric rank cells can appear out of order in the DOM. Observed examples include `15` before `14`, `27` before `26`, and `51` before `50`. Always read and sort the raw rank.

Ranks 1-3 are images and have empty rank text. Verified asset fragments:

| Rank | Asset fragment |
|---|---|
| 1 | `O1CN01DXTKWC1J3gIsNwyQH_` |
| 2 | `O1CN01X0pxSi1yCHzgsRk47_` |
| 3 | `O1CN018xH1Ts1DRbIDMkvZ2_` |

Fail closed if any top-three image uses an unknown asset. Do not infer those ranks from row position.

## Human Handoffs

Pause without clicking through when any visible dialog or page requires login, QR/SMS/CAPTCHA verification, or reports account/access risk, unusual traffic, excessive operations, or restricted access. Resume by rediscovering the target after the user resolves the page.

Do not read cookies, local/session storage, credential fields, password-manager UI, signed URLs, or authentication headers.

## Last Verified Dataset

The 2026-08-03 ordinary-bathtub run returned six pages with `50/50/50/50/50/17` rows, 267 contiguous ranks, unique search terms, and no blank metrics. Use this only as regression context; future row counts may legitimately change.
