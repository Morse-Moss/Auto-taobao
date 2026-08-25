# 生意参谋搜索排行已验证模式

Updated: 2026-08-16

## Page Contract

- Target route: `https://sycm.taobao.com/mc/free/search_rank`
- Required headers: `排名`, `搜索词`, `搜索人气`, `点击率`, `支付转化率`
- Current weekly category: `家装主材 > 浴缸/淋浴房 > 浴缸 > 普通浴缸`
- Current category query: `parentCateId=201833103`, `cateId=50002411`
- Current category selector leaf: `li.tree-item[title="浴缸 > 普通浴缸"]`
- Required reporting period: `7天`; the displayed range must contain exactly seven calendar dates inclusive.

Treat all selectors and IDs as observations from 2026-08-04, not permanent platform contracts.

## Verified UI Patterns

- Entering Search Ranking from the home page can reset the period to `日`. Explicitly select `7天` on every run; do not reuse the previous visual state.
- The live selected `7天` button uses the Ant Design class `ant-btn-primary`. Also accept explicit `aria-selected`, `aria-pressed`, or `aria-checked` state, but require the displayed range to span exactly seven inclusive calendar days.
- Read the complete range from `.oui-date-picker-current-date`. Treat `--date` as the range end date.
- Change the range end date with the two `.item-date button.arrow` controls. The URL's `dateRange` is an observed result, not the action source.
- Use the shared Proxy `/click` endpoint for normal SPA controls, including Market, Search Ranking, the reporting-period button, pagination, and date arrows. On 2026-08-16, `/clickAt` returned success for these controls without causing the required state transition.
- Rediscover and validate the current SYCM target through `/targets` before every browser action.
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

On 2026-08-16, two independent ordinary-bathtub runs for `2026-08-09 ~ 2026-08-15` each returned six pages with `50/50/50/50/50/50` rows, 300 contiguous ranks, unique search terms, and no blank metrics. Their CSV SHA-256 values were identical: `A46B6673E0C1A168FE2E94F705404A57C768472B787C24AFCC94E476E6EC8DCC`.

The archived 267-row runs under `evidence/stability-20260804` used the daily period. They remain valid extraction-stability evidence, but they are not valid weekly search-heat input. Future row counts may legitimately change.
