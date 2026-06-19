# Weibo User Archive Downloader PRD

Date: 2026-06-19

## Goal

Create a Bun TypeScript script, `weibo-archive-user.ts`, that downloads one specific Weibo user's original posts for a requested date range. The downloader must be resumable, avoid repeating work for already archived posts, and support an explicit refresh mode for updating already downloaded posts.

## Non-Goals

- Do not download reposts.
- Do not download videos or external linked/card pages in v1.
- Do not store Weibo login cookies on disk.
- Do not delete archived local posts just because they disappear from Weibo.
- Do not modify the existing simple one-post utility, `weibo-show.ts`, beyond any later explicitly requested shared-code refactor.

## CLI

The new script will be separate from `weibo-show.ts`:

```bash
WEIBO_COOKIE='...' bun run weibo-archive-user.ts \
  --uid 1401527553 \
  --from 2026-06-01 \
  --to 2026-06-18
```

Required options:

- `--uid <id>`: Weibo user ID.
- `--from YYYY-MM-DD`: start date.
- `--to YYYY-MM-DD`: end date.

Optional options:

- `--out <dir>`: archive root, default `weibo-archive`.
- `--refresh`: refresh all existing matched posts in the requested date range.
- `--delay-ms <ms>`: fixed delay between API/detail/image requests. If omitted, use a random delay between `1000` and `5000` ms before each request.
- `--max-pages <n>`: safety cap for timeline paging.
- `--max-posts-per-run <n>`: maximum number of posts to download or refresh in one run, default `50`.
- `--dry-run`: list matched post URLs without downloading payloads or media.

## Authentication

- Read authentication only from `WEIBO_COOKIE`.
- Never write the cookie to disk.
- If authentication fails, print a short message telling the user to refresh the cookie from Chrome DevTools.
- Do not auto-load `.env` in v1.

## Date Range Semantics

Dates are interpreted as Asia/Shanghai calendar days.

The range is start-inclusive and end-day-inclusive, implemented as:

```text
from 00:00:00 +0800 <= created_at < to + 1 day 00:00:00 +0800
```

Example:

```text
--from 2026-06-01 --to 2026-06-18
```

includes posts from `2026-06-01 00:00:00 +0800` through `2026-06-18 23:59:59 +0800`.

## Data Sources

Timeline paging should use the desktop profile API observed from Weibo:

```text
https://weibo.com/ajax/statuses/mymblog?uid=<UID>&page=<PAGE>&feature=0
```

Post detail should use:

```text
https://weibo.com/ajax/statuses/show?id=<MBLOG_ID>&locale=en-US&isGetLongText=true
```

For post URLs, use:

```text
https://weibo.com/<UID>/<MBLOG_ID>
```

## Original-Post Filtering

Only archive original posts by the requested user.

Reposts should be skipped. The implementation should detect reposts from the timeline/detail payload, for example by the presence of repost-related fields such as `retweeted_status`, while also verifying the post belongs to the requested `uid`.

## Pagination Stop Rule

Fetch pages from `page=1` upward.

Stop when either:

- the API returns no usable timeline posts, or
- two consecutive pages contain only original posts older than `--from`.

The two-page rule is intentional to avoid missing posts if Weibo injects pinned or irregularly ordered items.

## Crawl Safety

The downloader should behave as a conservative archival tool, not a high-throughput scraper.

Rules:

- No parallelism. Perform one network request at a time.
- If `--delay-ms` is provided, wait that fixed delay before each network request.
- If `--delay-ms` is omitted, wait a random delay between `1000` and `5000` ms before each network request.
- Enforce `--max-posts-per-run`, default `50`, for detail/image/Markdown work.
- Prefer two-phase execution:
  - phase 1: timeline discovery and filtering;
  - phase 2: detail/image/Markdown download for selected posts.
- Recommend `--dry-run` before a real download, especially for new users, wide date windows, or changed filters.
- Do not rotate cookies, proxies, user agents, or browser fingerprints.
- Do not issue background refreshes or speculative prefetches.

### Risk Signals

Stop immediately, without further retries, when any request returns a risk signal:

- HTTP `403`, `418`, or `429`;
- a non-JSON Sina Visitor System response;
- a login page where JSON was expected;
- captcha/security/verification wording;
- response content indicating abnormal account/session state;
- repeated malformed responses from the same API family.

When a risk signal is detected:

- record the failure in `manifest.json` if possible;
- print a concise warning;
- exit with code `1`;
- do not continue paging or downloading media.

### Transient Failures

For transient network failures such as timeout, socket reset, or HTTP `5xx`:

- wait a long cooldown before retrying once;
- default cooldown: `60000` ms;
- if the retry fails, stop the run;
- record the failure in `manifest.json` if possible;
- exit with code `2` if partial work completed, otherwise `1`.

## Archive Layout

Default output layout:

```text
weibo-archive/
  users/
    <uid>/
      manifest.json
      posts/
        <post-dir>/
          payload.json
          metadata.json
          images.json
          post.md
          images/
```

Example:

```text
weibo-archive/
  users/
    1401527553/
      manifest.json
      posts/
        20260618-22-001-R4JwG0ktx/
          payload.json
          metadata.json
          images.json
          post.md
          images/
            01-53899d01ly1ie9tj2qgsdj20xw18pkcq.jpg
            02-53899d01ly1ie9tfx23prj20lb0xcn5u.jpg
```

## Post Directory Naming

Post directories should use:

```text
YYYYMMDD-HH-SEQ-MBLOGID
```

Rules:

- `YYYYMMDD-HH` comes from `created_at` in Asia/Shanghai.
- `SEQ` is a three-digit sequence number within the same day, not within the same hour.
- Sequence assignment is chronological ascending within that day.
- Include `mblogid` at the end for stable recognition.
- Keep a manifest mapping from `mblogid` to `postDir`.

Example:

```text
20260618-22-001-R4JwG0ktx
```

## Stable Paths

Paths are stable once assigned.

On later runs:

- an existing `mblogid` keeps its existing `postDir`;
- new posts for a day get the next available sequence number for that day;
- existing directories are not automatically renamed or renumbered, even if a later wider crawl discovers earlier posts that would have changed historical ordering.

## Resumability

Default behavior:

- If a matched post already exists in `manifest.json`, skip it.
- If a post directory exists but is incomplete, complete the missing pieces where possible.
- Do not redownload images that already exist and match the expected manifest entry.
- Persist manifest updates after each completed timeline page and each completed post. This is not a separate checkpoint system; it is the mechanism that makes normal resumability safe after interruption.

## Refresh Mode

With `--refresh`, for all existing posts matched by the requested date range:

- refetch `payload.json`;
- redownload missing images;
- redownload images if their source URL or expected size changed;
- regenerate `metadata.json`, `images.json`, and `post.md`;
- update `manifest.json`;
- preserve the existing `postDir`.

Refresh applies to all matched existing posts, not a single explicit post ID.

## Deleted or Unavailable Posts

The archive is not a mirror. It must preserve local copies.

Behavior:

- Never delete local archives because a post disappears from Weibo.
- Absence from a timeline crawl is not enough to mark deletion.
- Only mark a post unavailable when a direct detail refetch for a known `mblogid` clearly fails with deleted/unavailable/permission-denied semantics.
- If unavailable during refresh:
  - keep the last good `payload.json`, images, and `post.md`;
  - update `metadata.json` with `availability: "unavailable"` and `lastCheckedAt`;
  - append a manifest event such as `unavailable_detected`;
  - do not overwrite the last good payload with an error response.
- Mark unavailable status visibly in `post.md`, for example with a footer note:

```text
Archived copy; source currently unavailable as of <timestamp>.
```

## Media Scope

v1 downloads:

- images from `pic_infos`;
- long-text payloads when `isLongText` is true.

v1 records but does not download:

- videos;
- external link/card pages;
- other embedded media not represented in `pic_infos`.

For image variant selection, prefer the best available still-image URL, following this order:

```text
mw2000 -> largest -> original -> large -> bmiddle -> thumbnail
```

## Long Text

- Always save the raw detail payload as `payload.json`.
- If `isLongText` is true, save the embedded `longText` object from the detail response as `longtext.json`.
- Generate `post.md` from long-text content when available.
- Otherwise generate `post.md` from `text_raw` or `text`.
- Preserve basic formatting, but do not attempt perfect Weibo rich-rendering fidelity in v1.

## Markdown Output

Generate one `post.md` per post using local relative image links.

Recommended style:

```md
# tombkeeper - 2026-06-18 22:14

祖国人的扮演者 Antony Starr 转发了这个北宋版祖国人。

![](images/01-53899d01ly1ie9tj2qgsdj20xw18pkcq.jpg)

![](images/02-53899d01ly1ie9tfx23prj20lb0xcn5u.jpg)

---

- URL: https://weibo.com/1401527553/R4JwG0ktx
- Source: 微博网页版
- Region: 发布于 北京
- Counts at archive time: reposts 53, comments 30, likes 678
```

Markdown rules:

- preserve text line breaks;
- strip Weibo trailing invisible spacing symbols such as `​​​​`;
- convert basic HTML links, mentions, and topics to Markdown links when practical;
- place images immediately after text in original order;
- include metadata in a compact footer.

## Manifest

Maintain:

```text
weibo-archive/users/<uid>/manifest.json
```

The manifest should include:

- user ID;
- archive schema version;
- crawl runs;
- per-post entries keyed by `mblogid`;
- failures;
- events such as refreshes and unavailable detections.

Suggested post entry:

```json
{
  "mblogid": "R4JwG0ktx",
  "mid": "5311283180078711",
  "url": "https://weibo.com/1401527553/R4JwG0ktx",
  "createdAt": "2026-06-18T22:14:12+08:00",
  "postDir": "posts/20260618-22-001-R4JwG0ktx",
  "availability": "available",
  "lastSavedAt": "2026-06-19T00:00:00+08:00",
  "lastRefreshedAt": "2026-06-19T00:00:00+08:00"
}
```

## Failure Handling

Continue on per-post failures.

Record failures in `manifest.json` with:

- `mblogid` or source URL;
- stage: `timeline`, `detail`, `image`, `longText`, or `markdown`;
- error message;
- timestamp.

Exit codes:

- `0`: all matched posts succeeded.
- `2`: crawl completed but one or more posts/images failed.
- `1`: fatal setup error, such as missing cookie, invalid dates, auth failure, or unreadable API response.

For partial image failures:

- still write `payload.json`, `metadata.json`, and `post.md`;
- include only successfully downloaded images in Markdown;
- record failed image downloads in `images.json` and `manifest.json`.

## Dry Run

`--dry-run` should:

- fetch and page through timeline results;
- apply original-post and date filters;
- print matched post URLs and timestamps;
- not fetch detail payloads;
- not download media;
- not write post directories.

It may update nothing on disk, or at most write no files at all in v1.

## Review Checklist

Before implementation, confirm:

- The archive layout is acceptable.
- The directory naming rule is acceptable.
- Stable-path behavior is acceptable.
- Original-post detection strategy is acceptable.
- The v1 media scope is sufficient.
- The script should remain credential-neutral and cookie-only.

## Live Validation Notes

Validation date: 2026-06-19

User validated: `1401527553`

Cookie source: `WEIBO_COOKIE.txt` was used for authenticated API requests. The cookie value was not printed or written elsewhere.

### Timeline Endpoint

The profile timeline endpoint worked:

```text
https://weibo.com/ajax/statuses/mymblog?uid=1401527553&page=1&feature=0
```

Observed response shape:

- top-level keys: `data`, `ok`
- `data` keys included: `since_id`, `list`, `status_visible`, `bottom_tips_visible`, `bottom_tips_text`, `topicList`, `total`
- `data.list` contained status objects with `mblogid`, `idstr`, `created_at`, `user`, `retweeted_status`, `isLongText`, `pic_num`, `text_raw`, and image fields when applicable

Observed page sizes:

- page 1: 21 items
- page 2: 19 items
- page 3: 20 items

### Ordering and Stop Rule

The timeline is not strictly chronological. Page 1 included a pinned or injected 2016 post among 2026 posts, and also included reposts mixed with original posts.

This validates the PRD's two-page older-than-start stop rule and the need to filter after fetching pages rather than assuming every item on a page is ordered.

### Original-Post Filtering

Live timeline items showed reposts with `retweeted_status` present and original posts without `retweeted_status`.

For the requested user, original-post filtering should require:

- `String(status.user.idstr ?? status.user.id) === uid`
- no `status.retweeted_status`

### Detail Endpoint

The detail endpoint worked:

```text
https://weibo.com/ajax/statuses/show?id=<MBLOG_ID>&locale=en-US&isGetLongText=true
```

For `R4JwG0ktx`, the response included:

- `ok: 1`
- `mblogid: "R4JwG0ktx"`
- `mid: "5311283180078711"`
- `created_at: "Thu Jun 18 22:14:12 +0800 2026"`
- `isLongText: false`
- `pic_num: 2`
- `pic_ids`
- `pic_infos` with image variants: `thumbnail`, `bmiddle`, `large`, `original`, `largest`, `mw2000`, `largecover`

### Long Text

For long-text examples such as `R4PzTtZSd` and `R3TUQtV4s`, using `isGetLongText=true` returned an embedded `longText` object in the detail response.

Observed `longText` keys included:

- `created_at`
- `appid`
- `annotations`
- `mblog_vip_type`
- `user`
- `weibo_position`
- `show_attitude_bar`
- `content`
- and for image posts, `pic_ids` and `pic_infos`

Implementation should save this embedded object as `longtext.json`; no separate long-text endpoint is required for the validated cases.

### Image Download

For `R4PzTtZSd`, the selected `mw2000` image URL was reachable with HTTP 200:

```text
https://wx4.sinaimg.cn/mw2000/53899d01ly1ieak97wtuuj20sp0n5qcy.jpg
```

Observed response:

- content type: `image/jpeg`
- content length: `213090`

This validates the image variant preference order and direct image download approach.

### Date Window and Directory Naming Simulation

A live simulation for original posts in the inclusive Asia/Shanghai window `2026-06-18` through `2026-06-19` found 6 matching original posts.

The proposed daily sequence naming produced:

```text
20260618-09-001-R4EpL2nRJ
20260618-11-002-R4FtclSR7
20260618-22-003-R4JwG0ktx
20260619-12-001-R4P1wh0Z6
20260619-13-002-R4PzTtZSd
20260619-14-003-R4PTgnVGS
```

This validates that `SEQ` is per day and that the hour component remains useful for readability.
