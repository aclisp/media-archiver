import { readdir, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

const ARCHIVE_SCHEMA_VERSION = 1;
const DEFAULT_OUT_DIR = 'weibo-archive';
const DEFAULT_MAX_POSTS_PER_RUN = 50;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_MS = 60_000;
const RANDOM_DELAY_MIN_MS = 1_000;
const RANDOM_DELAY_MAX_MS = 5_000;
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const DEFAULT_REFERER = 'https://weibo.com/';
const ACCEPT_JSON = 'application/json, text/plain, */*';
const SHANGHAI_OFFSET_MINUTES = 8 * 60;
const REQUEST_TIMEOUT_MS = 30_000;
const IMAGE_VARIANTS = ['mw2000', 'original', 'large', 'bmiddle', 'thumbnail', 'largest'] as const;
const MAX_MANIFEST_RUNS = 20;
const MAX_MANIFEST_EVENTS = 100;
const MAX_MANIFEST_FAILURES = 100;

type ImageVariant = (typeof IMAGE_VARIANTS)[number];
type FailureStage = 'timeline' | 'detail' | 'image' | 'longText' | 'markdown';
type Availability = 'available' | 'unavailable';

interface CliOptions {
    uid: string;
    from: string;
    to: string;
    out: string;
    refresh: boolean;
    dryRun: boolean;
    delayMs?: number;
    maxPages?: number;
    maxPostsPerRun: number;
    maxRetries: number;
    retryBaseMs: number;
}

interface DateParts {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
}

interface ParsedPostDate {
    instantMs: number;
    isoShanghai: string;
    ymd: string;
    hm: string;
    dirPrefix: string;
}

interface TimelinePost {
    mblogid: string;
    mid?: string;
    url: string;
    createdAt: ParsedPostDate;
    raw: WeiboStatus;
}

interface Manifest {
    schemaVersion: number;
    uid: string;
    updatedAt?: string;
    runs: ManifestRun[];
    posts: Record<string, ManifestPost>;
    failures: ManifestFailure[];
    events: ManifestEvent[];
}

interface ManifestRun {
    id: string;
    startedAt: string;
    finishedAt?: string;
    uid: string;
    from: string;
    to: string;
    refresh: boolean;
    dryRun: boolean;
    pagesFetched: number;
    matchedPosts: number;
    processedPosts: number;
    status: 'running' | 'completed' | 'failed' | 'risk';
}

interface ManifestPost {
    mblogid: string;
    mid?: string;
    url: string;
    createdAt: string;
    postDir: string;
    availability: Availability;
    lastSavedAt?: string;
    lastRefreshedAt?: string;
}

interface ManifestFailure {
    id: string;
    timestamp: string;
    stage: FailureStage;
    message: string;
    mblogid?: string;
    url?: string;
}

interface ManifestEvent {
    id: string;
    timestamp: string;
    type: string;
    mblogid?: string;
    details?: Record<string, string | number | boolean>;
}

interface MetadataFile {
    mblogid: string;
    mid?: string;
    uid: string;
    url: string;
    createdAt: string;
    archivedAt: string;
    availability: Availability;
    lastCheckedAt: string;
    source?: string;
    region?: string;
    repostsCount: number;
    commentsCount: number;
    attitudesCount: number;
    screenName: string;
}

interface ImagesFile {
    images: ImageEntry[];
}

interface ImageEntry {
    index: number;
    variant?: ImageVariant;
    sourceUrl?: string;
    localPath?: string;
    contentType?: string;
    byteSize?: number;
    downloaded: boolean;
    error?: string;
}

interface WeiboStatus {
    idstr?: string;
    mid?: string;
    mblogid?: string;
    created_at?: string;
    user?: {
        id?: number | string;
        idstr?: string;
        screen_name?: string;
    };
    retweeted_status?: unknown;
    isLongText?: boolean;
    longText?: {
        content?: string;
        text_raw?: string;
    };
    text?: string;
    text_raw?: string;
    textLength?: number;
    source?: string;
    region_name?: string;
    region?: string;
    reposts_count?: number;
    comments_count?: number;
    attitudes_count?: number;
    pic_ids?: string[];
    pic_infos?: Record<string, PicInfo>;
}

interface PicInfo {
    [key: string]: unknown;
}

class SetupError extends Error {}

class TransientStopError extends Error {
    constructor(
        message: string,
        readonly stage: FailureStage,
        readonly url?: string,
        readonly mblogid?: string,
    ) {
        super(message);
    }
}

class RiskSignalError extends Error {
    constructor(
        message: string,
        readonly stage: FailureStage,
        readonly url?: string,
        readonly mblogid?: string,
    ) {
        super(message);
    }
}

class UnavailablePostError extends Error {}

interface RequestContext {
    cookie: string;
    delayMs?: number;
    maxRetries: number;
    retryBaseMs: number;
}

interface RunState {
    usefulWorkCompleted: boolean;
    hadFailure: boolean;
}

function parseArgs(argv: string[]): CliOptions {
    const options: Partial<CliOptions> = {
        out: DEFAULT_OUT_DIR,
        refresh: false,
        dryRun: false,
        maxPostsPerRun: DEFAULT_MAX_POSTS_PER_RUN,
        maxRetries: DEFAULT_MAX_RETRIES,
        retryBaseMs: DEFAULT_RETRY_BASE_MS,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--refresh') {
            options.refresh = true;
            continue;
        }
        if (arg === '--dry-run') {
            options.dryRun = true;
            continue;
        }
        if (!arg?.startsWith('--')) {
            throw new SetupError(`Unknown argument: ${arg ?? ''}`);
        }

        const value = argv[index + 1];
        if (!value || value.startsWith('--')) {
            throw new SetupError(`Missing value for ${arg}`);
        }
        index += 1;

        switch (arg) {
            case '--uid':
                options.uid = value;
                break;
            case '--from':
                options.from = value;
                break;
            case '--to':
                options.to = value;
                break;
            case '--out':
                options.out = value;
                break;
            case '--delay-ms':
                options.delayMs = parseNonNegativeInteger(arg, value);
                break;
            case '--max-pages':
                options.maxPages = parsePositiveInteger(arg, value);
                break;
            case '--max-posts-per-run':
                options.maxPostsPerRun = parsePositiveInteger(arg, value);
                break;
            case '--max-retries':
                options.maxRetries = parseNonNegativeInteger(arg, value);
                break;
            case '--retry-base-ms':
                options.retryBaseMs = parsePositiveInteger(arg, value);
                break;
            default:
                throw new SetupError(`Unknown option: ${arg}`);
        }
    }

    if (!options.uid || !/^\d+$/.test(options.uid)) {
        throw new SetupError('Missing or invalid --uid');
    }
    if (!options.from) {
        throw new SetupError('Missing --from');
    }
    if (!options.to) {
        throw new SetupError('Missing --to');
    }
    parseCalendarDate(options.from);
    parseCalendarDate(options.to);
    if (startOfShanghaiDayMs(options.from) > startOfShanghaiDayMs(options.to)) {
        throw new SetupError('--from must not be later than --to');
    }

    return options as CliOptions;
}

function parsePositiveInteger(name: string, value: string): number {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new SetupError(`${name} must be a positive integer`);
    }
    return parsed;
}

function parseNonNegativeInteger(name: string, value: string): number {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0) {
        throw new SetupError(`${name} must be a non-negative integer`);
    }
    return parsed;
}

function parseCalendarDate(value: string): DateParts {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) {
        throw new SetupError(`Malformed date: ${value}`);
    }
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const instant = new Date(Date.UTC(year, month - 1, day));
    if (instant.getUTCFullYear() !== year || instant.getUTCMonth() !== month - 1 || instant.getUTCDate() !== day) {
        throw new SetupError(`Malformed date: ${value}`);
    }
    return { year, month, day, hour: 0, minute: 0, second: 0 };
}

function startOfShanghaiDayMs(value: string): number {
    const parts = parseCalendarDate(value);
    return wallClockToUtcMs(parts, SHANGHAI_OFFSET_MINUTES);
}

function endExclusiveShanghaiDayMs(value: string): number {
    return startOfShanghaiDayMs(value) + 24 * 60 * 60 * 1_000;
}

function parseWeiboCreatedAt(value: string): ParsedPostDate {
    const match = /^(\w{3})\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+([+-]\d{4})\s+(\d{4})$/.exec(value);
    if (!match) {
        throw new Error(`Unsupported created_at format: ${value}`);
    }

    const month = monthNumber(match[2] ?? '');
    const day = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = Number(match[6]);
    const offset = parseOffsetMinutes(match[7] ?? '');
    const year = Number(match[8]);
    const instantMs = wallClockToUtcMs({ year, month, day, hour, minute, second }, offset);
    const shanghaiParts = utcMsToShanghaiParts(instantMs);
    const ymd = `${pad4(shanghaiParts.year)}${pad2(shanghaiParts.month)}${pad2(shanghaiParts.day)}`;
    const hm = `${pad2(shanghaiParts.hour)}:${pad2(shanghaiParts.minute)}`;
    return {
        instantMs,
        isoShanghai: `${pad4(shanghaiParts.year)}-${pad2(shanghaiParts.month)}-${pad2(shanghaiParts.day)}T${pad2(shanghaiParts.hour)}:${pad2(shanghaiParts.minute)}:${pad2(
            shanghaiParts.second,
        )}+08:00`,
        ymd,
        hm,
        dirPrefix: `${ymd}-${pad2(shanghaiParts.hour)}`,
    };
}

function monthNumber(value: string): number {
    const months: Record<string, number> = {
        Jan: 1,
        Feb: 2,
        Mar: 3,
        Apr: 4,
        May: 5,
        Jun: 6,
        Jul: 7,
        Aug: 8,
        Sep: 9,
        Oct: 10,
        Nov: 11,
        Dec: 12,
    };
    const month = months[value];
    if (!month) {
        throw new Error(`Unsupported month: ${value}`);
    }
    return month;
}

function parseOffsetMinutes(value: string): number {
    const match = /^([+-])(\d{2})(\d{2})$/.exec(value);
    if (!match) {
        throw new Error(`Unsupported timezone offset: ${value}`);
    }
    const sign = match[1] === '-' ? -1 : 1;
    return sign * (Number(match[2]) * 60 + Number(match[3]));
}

function wallClockToUtcMs(parts: DateParts, offsetMinutes: number): number {
    return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - offsetMinutes * 60 * 1_000;
}

function utcMsToShanghaiParts(instantMs: number): DateParts {
    const shifted = new Date(instantMs + SHANGHAI_OFFSET_MINUTES * 60 * 1_000);
    return {
        year: shifted.getUTCFullYear(),
        month: shifted.getUTCMonth() + 1,
        day: shifted.getUTCDate(),
        hour: shifted.getUTCHours(),
        minute: shifted.getUTCMinutes(),
        second: shifted.getUTCSeconds(),
    };
}

function nowShanghaiIso(): string {
    const parts = utcMsToShanghaiParts(Date.now());
    return `${pad4(parts.year)}-${pad2(parts.month)}-${pad2(parts.day)}T${pad2(parts.hour)}:${pad2(parts.minute)}:${pad2(parts.second)}+08:00`;
}

function pad2(value: number): string {
    return String(value).padStart(2, '0');
}

function pad3(value: number): string {
    return String(value).padStart(3, '0');
}

function pad4(value: number): string {
    return String(value).padStart(4, '0');
}

function validateCookie(): string {
    const cookie = Bun.env.WEIBO_COOKIE;
    if (!cookie?.includes('SUB=') || !cookie.includes('SUBP=')) {
        throw new SetupError('Authentication failed; refresh your cookie from Chrome DevTools and pass it with WEIBO_COOKIE');
    }
    return cookie;
}

async function main(): Promise<number> {
    let options: CliOptions;
    let cookie: string;

    try {
        options = parseArgs(Bun.argv.slice(2));
        cookie = validateCookie();
    } catch (error) {
        console.error(error instanceof Error ? error.message : 'Fatal setup error');
        return 1;
    }

    const requestContext: RequestContext = {
        cookie,
        delayMs: options.delayMs,
        maxRetries: options.maxRetries,
        retryBaseMs: options.retryBaseMs,
    };
    const runState: RunState = { usefulWorkCompleted: false, hadFailure: false };
    const archiveRoot = join(options.out, 'users', options.uid);
    const manifestPath = join(archiveRoot, 'manifest.json');
    const runId = crypto.randomUUID();
    const startedAt = nowShanghaiIso();
    let manifest: Manifest | undefined;
    let run: ManifestRun | undefined;

    try {
        if (!options.dryRun) {
            manifest = await loadManifest(manifestPath, options.uid);
            run = {
                id: runId,
                startedAt,
                uid: options.uid,
                from: options.from,
                to: options.to,
                refresh: options.refresh,
                dryRun: options.dryRun,
                pagesFetched: 0,
                matchedPosts: 0,
                processedPosts: 0,
                status: 'running',
            };
            manifest.runs.push(run);
            await saveManifest(manifestPath, manifest);
        }

        const matchedPosts = await discoverTimeline(options, requestContext, manifest, manifestPath, run);
        if (run) {
            run.matchedPosts = matchedPosts.length;
            await saveManifest(manifestPath, manifestOrThrow(manifest));
        }

        if (options.dryRun) {
            for (const post of matchedPosts) {
                console.log(`${post.createdAt.isoShanghai} ${post.url}`);
            }
            return 0;
        }

        manifest = manifestOrThrow(manifest);
        run = runOrThrow(run);
        assignPostDirectories(matchedPosts, manifest);
        const selected = (await selectPostsForWork(matchedPosts, manifest, archiveRoot, options)).slice(0, options.maxPostsPerRun);

        if (selected.length === 0) {
            console.log('No posts need download or refresh.');
        }

        for (const post of selected) {
            try {
                const failureCountBefore = manifest.failures.length;
                const didWrite = await archivePost(post, options, requestContext, manifest, manifestPath, archiveRoot);
                if (didWrite) {
                    runState.usefulWorkCompleted = true;
                    run.processedPosts += 1;
                    await saveManifest(manifestPath, manifest);
                }
                if (manifest.failures.length > failureCountBefore) {
                    runState.hadFailure = true;
                }
            } catch (error) {
                if (error instanceof RiskSignalError) {
                    recordFailure(manifest, error.stage, error.message, error.url, error.mblogid);
                    run.status = 'risk';
                    await saveManifest(manifestPath, manifest);
                    console.error('Risk signal detected; stopping immediately.');
                    return 3;
                }
                runState.hadFailure = true;
                const entry = manifest.posts[post.mblogid];
                if (entry && (await Bun.file(join(archiveRoot, entry.postDir)).exists())) {
                    runState.usefulWorkCompleted = true;
                }
                const message = error instanceof Error ? error.message : 'Unknown post failure';
                recordFailure(manifest, 'detail', message, post.url, post.mblogid);
                await saveManifest(manifestPath, manifest);
                console.error(`Post failed: ${post.url} (${sanitizeMessage(message)})`);
            }
        }

        run.finishedAt = nowShanghaiIso();
        run.status = runState.hadFailure ? 'failed' : 'completed';
        await saveManifest(manifestPath, manifest);

        if (runState.hadFailure) {
            return runState.usefulWorkCompleted ? 2 : 1;
        }
        return 0;
    } catch (error) {
        if (error instanceof RiskSignalError) {
            if (manifest) {
                recordFailure(manifest, error.stage, error.message, error.url, error.mblogid);
                if (run) {
                    run.status = 'risk';
                    run.finishedAt = nowShanghaiIso();
                }
                await saveManifest(manifestPath, manifest);
            }
            console.error('Risk signal detected; stopping immediately.');
            return 3;
        }

        if (error instanceof TransientStopError) {
            if (manifest) {
                recordFailure(manifest, error.stage, error.message, error.url, error.mblogid);
                if (run) {
                    run.status = 'failed';
                    run.finishedAt = nowShanghaiIso();
                }
                await saveManifest(manifestPath, manifest);
            }
            console.error(`Transient failure limit reached: ${sanitizeMessage(error.message)}`);
            return runState.usefulWorkCompleted ? 2 : 1;
        }

        const message = error instanceof Error ? error.message : 'Fatal error';
        if (manifest && run) {
            recordFailure(manifest, 'timeline', message);
            run.status = 'failed';
            run.finishedAt = nowShanghaiIso();
            await saveManifest(manifestPath, manifest);
        }
        console.error(sanitizeMessage(message));
        return runState.usefulWorkCompleted ? 2 : 1;
    }
}

async function discoverTimeline(
    options: CliOptions,
    requestContext: RequestContext,
    manifest: Manifest | undefined,
    manifestPath: string,
    run: ManifestRun | undefined,
): Promise<TimelinePost[]> {
    const fromMs = startOfShanghaiDayMs(options.from);
    const toExclusiveMs = endExclusiveShanghaiDayMs(options.to);
    const seen = new Set<string>();
    const matched: TimelinePost[] = [];
    let olderOriginalPages = 0;
    let page = 1;

    while (!options.maxPages || page <= options.maxPages) {
        const url = `https://weibo.com/ajax/statuses/mymblog?uid=${encodeURIComponent(options.uid)}&page=${page}&feature=0`;
        const json = await requestJson(url, 'timeline', requestContext);
        const list = readTimelineList(json);
        if (list.length === 0) {
            break;
        }

        const pageOriginals: TimelinePost[] = [];
        for (const status of list) {
            const post = normalizeTimelineStatus(status, options.uid);
            if (!post || seen.has(post.mblogid)) {
                continue;
            }
            seen.add(post.mblogid);
            if (!isOriginalPost(status, options.uid)) {
                continue;
            }
            pageOriginals.push(post);
            if (post.createdAt.instantMs >= fromMs && post.createdAt.instantMs < toExclusiveMs) {
                matched.push(post);
            }
        }

        if (pageOriginals.length > 0 && pageOriginals.every((post) => post.createdAt.instantMs < fromMs)) {
            olderOriginalPages += 1;
        } else {
            olderOriginalPages = 0;
        }

        if (run && manifest) {
            run.pagesFetched = page;
            run.matchedPosts = matched.length;
            manifest.updatedAt = nowShanghaiIso();
            await saveManifest(manifestPath, manifest);
        }

        if (olderOriginalPages >= 2) {
            break;
        }
        page += 1;
    }

    return matched.sort((left, right) => left.createdAt.instantMs - right.createdAt.instantMs);
}

function readTimelineList(json: unknown): WeiboStatus[] {
    if (!isRecord(json)) {
        throw new Error('Malformed timeline response');
    }
    const data = json.data;
    if (!isRecord(data)) {
        throw new Error('Malformed timeline response');
    }
    const list = data.list;
    if (!Array.isArray(list)) {
        throw new Error('Malformed timeline response');
    }
    return list.filter(isRecord) as WeiboStatus[];
}

function normalizeTimelineStatus(status: WeiboStatus, uid: string): TimelinePost | undefined {
    const mblogid = typeof status.mblogid === 'string' ? status.mblogid : undefined;
    const createdAtText = typeof status.created_at === 'string' ? status.created_at : undefined;
    if (!mblogid || !createdAtText) {
        return undefined;
    }
    const createdAt = parseWeiboCreatedAt(createdAtText);
    return {
        mblogid,
        mid: typeof status.idstr === 'string' ? status.idstr : typeof status.mid === 'string' ? status.mid : undefined,
        url: `https://weibo.com/${uid}/${mblogid}`,
        createdAt,
        raw: status,
    };
}

function isOriginalPost(status: WeiboStatus, uid: string): boolean {
    const userId = status.user?.idstr ?? status.user?.id;
    return String(userId ?? '') === uid && !status.retweeted_status;
}

async function archivePost(
    timelinePost: TimelinePost,
    options: CliOptions,
    requestContext: RequestContext,
    manifest: Manifest,
    manifestPath: string,
    archiveRoot: string,
): Promise<boolean> {
    const entry = manifest.posts[timelinePost.mblogid];
    if (!entry) {
        throw new Error(`Missing manifest entry for ${timelinePost.mblogid}`);
    }
    if (!options.refresh && (await isPostComplete(archiveRoot, entry))) {
        return false;
    }

    const postRoot = join(archiveRoot, entry.postDir);
    await Bun.$`mkdir -p ${postRoot}`.quiet();

    let detail: WeiboStatus;
    try {
        detail = await fetchDetail(timelinePost.mblogid, requestContext);
    } catch (error) {
        if (error instanceof UnavailablePostError && options.refresh) {
            await markUnavailable(archiveRoot, entry, manifest, timelinePost.mblogid);
            await saveManifest(manifestPath, manifest);
            return true;
        }
        throw error;
    }

    const longTextContent = await resolveLongText(detail, timelinePost.mblogid, requestContext, postRoot);
    await writeJson(join(postRoot, 'payload.json'), detail);
    const metadata = buildMetadata(options.uid, timelinePost, detail);
    const images = await archiveImages(detail, postRoot, entry, options.refresh, requestContext, manifest);
    await writeJson(join(postRoot, 'metadata.json'), metadata);
    await writeJson(join(postRoot, 'images.json'), { images });
    const markdown = buildMarkdown(options.uid, timelinePost, detail, metadata, images, longTextContent);
    await Bun.write(join(postRoot, 'post.md'), markdown);

    const now = nowShanghaiIso();
    entry.mid = timelinePost.mid ?? entry.mid;
    entry.availability = 'available';
    entry.lastSavedAt = now;
    if (options.refresh) {
        entry.lastRefreshedAt = now;
        manifest.events.push({ id: crypto.randomUUID(), timestamp: now, type: 'refreshed', mblogid: timelinePost.mblogid });
    } else {
        manifest.events.push({ id: crypto.randomUUID(), timestamp: now, type: 'saved', mblogid: timelinePost.mblogid });
    }
    manifest.updatedAt = now;
    return true;
}

async function fetchDetail(mblogid: string, requestContext: RequestContext): Promise<WeiboStatus> {
    const url = `https://weibo.com/ajax/statuses/show?id=${encodeURIComponent(mblogid)}&locale=en-US&isGetLongText=true`;
    const json = await requestJson(url, 'detail', requestContext, mblogid);
    if (isUnavailableResponse(json)) {
        throw new UnavailablePostError('Post is unavailable');
    }
    const status = isRecord(json) && isRecord(json.data) ? json.data : json;
    if (!isRecord(status)) {
        throw new Error('Malformed detail response');
    }
    const mblogidValue = status.mblogid;
    if (typeof mblogidValue !== 'string' && typeof status.idstr !== 'string') {
        throw new Error('Malformed detail response');
    }
    return status as WeiboStatus;
}

async function resolveLongText(status: WeiboStatus, mblogid: string, requestContext: RequestContext, postRoot: string): Promise<string | undefined> {
    if (!status.isLongText) {
        return undefined;
    }

    const inline = status.longText?.content ?? status.longText?.text_raw;
    if (inline && !looksTruncated(status, inline)) {
        await writeJson(join(postRoot, 'longtext.json'), status.longText ?? { content: inline });
        return inline;
    }

    const url = `https://weibo.com/ajax/statuses/longtext?id=${encodeURIComponent(mblogid)}`;
    const json = await requestJson(url, 'longText', requestContext, mblogid);
    const content = readLongTextContent(json);
    await writeJson(join(postRoot, 'longtext.json'), json);
    return content;
}

function looksTruncated(status: WeiboStatus, text: string): boolean {
    const rawLength = stripHtml(text).length;
    return Boolean((typeof status.textLength === 'number' && status.textLength > rawLength) || text.includes('…全文') || text.includes('...全文'));
}

function readLongTextContent(json: unknown): string | undefined {
    if (!isRecord(json)) {
        return undefined;
    }
    const data = json.data;
    if (!isRecord(data)) {
        return undefined;
    }
    return typeof data.longTextContent === 'string' ? data.longTextContent : undefined;
}

async function archiveImages(
    status: WeiboStatus,
    postRoot: string,
    entry: ManifestPost,
    refresh: boolean,
    requestContext: RequestContext,
    manifest: Manifest,
): Promise<ImageEntry[]> {
    const picIds = Array.isArray(status.pic_ids) ? status.pic_ids : Object.keys(status.pic_infos ?? {});
    const picInfos = status.pic_infos ?? {};
    if (picIds.length === 0) {
        return [];
    }

    const imagesDir = join(postRoot, 'images');
    await Bun.$`mkdir -p ${imagesDir}`.quiet();
    const previous = await readExistingImages(postRoot);
    const results: ImageEntry[] = [];

    for (let index = 0; index < picIds.length; index += 1) {
        const picId = picIds[index];
        if (!picId) {
            continue;
        }
        const picInfo = picInfos[picId];
        const existing = previous.find((image) => image.index === index + 1);
        const variants = collectVariantUrls(picInfo);
        const reusable = await reusableImage(existing, variants, postRoot, refresh);
        if (reusable) {
            results.push(reusable);
            continue;
        }

        const image = await downloadImageVariant(index + 1, variants, imagesDir, requestContext, entry.mblogid, manifest);
        results.push(image);
    }

    return results;
}

async function readExistingImages(postRoot: string): Promise<ImageEntry[]> {
    const path = join(postRoot, 'images.json');
    const file = Bun.file(path);
    if (!(await file.exists())) {
        return [];
    }
    try {
        const json = (await file.json()) as ImagesFile;
        return Array.isArray(json.images) ? json.images : [];
    } catch {
        return [];
    }
}

async function reusableImage(
    existing: ImageEntry | undefined,
    variants: Partial<Record<ImageVariant, string>>,
    postRoot: string,
    refresh: boolean,
): Promise<ImageEntry | undefined> {
    if (!existing?.downloaded || !existing.localPath || !existing.sourceUrl || typeof existing.byteSize !== 'number') {
        return undefined;
    }
    const localPath = join(postRoot, existing.localPath);
    const file = Bun.file(localPath);
    if (!(await file.exists())) {
        return undefined;
    }
    const stat = await fileStat(localPath);
    if (stat.size !== existing.byteSize) {
        return undefined;
    }
    const selected = selectVariant(variants);
    if (refresh && selected?.url !== existing.sourceUrl) {
        return undefined;
    }
    return existing;
}

async function fileStat(path: string): Promise<{ size: number }> {
    return await Bun.file(path).stat();
}

function collectVariantUrls(picInfo: PicInfo | undefined): Partial<Record<ImageVariant, string>> {
    const variants: Partial<Record<ImageVariant, string>> = {};
    if (!picInfo) {
        return variants;
    }
    for (const variant of IMAGE_VARIANTS) {
        const candidate = readImageUrl(picInfo, variant);
        if (candidate) {
            variants[variant] = candidate;
        }
    }
    return variants;
}

function readImageUrl(picInfo: PicInfo, variant: ImageVariant): string | undefined {
    const value = picInfo[variant];
    if (typeof value === 'string') {
        return value;
    }
    if (isRecord(value)) {
        const url = value.url ?? value.url_short ?? value.pic_url;
        return typeof url === 'string' && url.length > 0 ? url : undefined;
    }
    return undefined;
}

function selectVariant(variants: Partial<Record<ImageVariant, string>>): { variant: ImageVariant; url: string } | undefined {
    for (const variant of IMAGE_VARIANTS) {
        const url = variants[variant];
        if (url) {
            return { variant, url };
        }
    }
    return undefined;
}

async function downloadImageVariant(
    index: number,
    variants: Partial<Record<ImageVariant, string>>,
    imagesDir: string,
    requestContext: RequestContext,
    mblogid: string,
    manifest: Manifest,
): Promise<ImageEntry> {
    const variantErrors: string[] = [];
    for (const variant of IMAGE_VARIANTS) {
        const url = variants[variant];
        if (!url) {
            continue;
        }
        try {
            const response = await requestRaw(url, 'image', requestContext, mblogid, { accept: '*/*', referer: 'https://weibo.com/' });
            const bytes = new Uint8Array(await response.arrayBuffer());
            const filename = `${pad2(index)}-${sanitizeFilename(basename(new URL(url).pathname) || `${variant}.jpg`)}`;
            const localPath = join('images', filename);
            await Bun.write(join(imagesDir, filename), bytes);
            return {
                index,
                variant,
                sourceUrl: url,
                localPath,
                contentType: response.headers.get('content-type') ?? undefined,
                byteSize: bytes.byteLength,
                downloaded: true,
            };
        } catch (error) {
            if (error instanceof RiskSignalError || error instanceof TransientStopError) {
                throw error;
            }
            const message = error instanceof Error ? error.message : 'Image download failed';
            variantErrors.push(`${variant}: ${sanitizeMessage(message)}`);
        }
    }
    const message = variantErrors.length > 0 ? `All image variants failed (${variantErrors.join('; ')})` : 'No usable image variants found';
    recordFailure(manifest, 'image', message, undefined, mblogid);
    return { index, downloaded: false, error: message };
}

function buildMetadata(uid: string, timelinePost: TimelinePost, detail: WeiboStatus): MetadataFile {
    const now = nowShanghaiIso();
    return {
        mblogid: timelinePost.mblogid,
        mid: timelinePost.mid,
        uid,
        url: timelinePost.url,
        createdAt: timelinePost.createdAt.isoShanghai,
        archivedAt: now,
        availability: 'available',
        lastCheckedAt: now,
        source: detail.source,
        region: detail.region_name ?? detail.region,
        repostsCount: Number(detail.reposts_count ?? 0),
        commentsCount: Number(detail.comments_count ?? 0),
        attitudesCount: Number(detail.attitudes_count ?? 0),
        screenName: detail.user?.screen_name ?? timelinePost.raw.user?.screen_name ?? uid,
    };
}

function buildMarkdown(
    uid: string,
    timelinePost: TimelinePost,
    detail: WeiboStatus,
    metadata: MetadataFile,
    images: ImageEntry[],
    longTextContent: string | undefined,
): string {
    const rawText = longTextContent ?? detail.text_raw ?? detail.text ?? '';
    const text = normalizeMarkdownText(rawText);
    const lines: string[] = [`# ${metadata.screenName} - ${formatTitleTime(timelinePost.createdAt)}`, ''];
    if (text) {
        lines.push(text, '');
    }
    for (const image of images) {
        if (image.downloaded && image.localPath) {
            lines.push(`![](${image.localPath})`, '');
        }
    }
    lines.push('---', '');
    lines.push(`- URL: https://weibo.com/${uid}/${timelinePost.mblogid}`);
    if (metadata.source) {
        lines.push(`- Source: ${normalizeMarkdownText(metadata.source)}`);
    }
    if (metadata.region) {
        lines.push(`- Region: ${normalizeMarkdownText(metadata.region)}`);
    }
    lines.push(`- Counts at archive time: reposts ${metadata.repostsCount}, comments ${metadata.commentsCount}, likes ${metadata.attitudesCount}`);
    if (metadata.availability === 'unavailable') {
        lines.push(`- Archived copy; source currently unavailable as of ${metadata.lastCheckedAt}.`);
    }
    lines.push('');
    return lines.join('\n');
}

function formatTitleTime(createdAt: ParsedPostDate): string {
    return `${createdAt.isoShanghai.slice(0, 10)} ${createdAt.hm}`;
}

function normalizeMarkdownText(value: string): string {
    return decodeHtmlEntities(convertHtmlLinks(value))
        .replace(/[\u200b-\u200f\u202a-\u202e\ufeff]+/g, '')
        .replace(/\u200d/g, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>\s*<p>/gi, '\n\n')
        .replace(/<[^>]+>/g, '')
        .replace(/[ \t]+\n/g, '\n')
        .trim();
}

function convertHtmlLinks(value: string): string {
    return value.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi, (_match, href: string, label: string) => {
        const cleanLabel = stripHtml(label).trim();
        if (!cleanLabel) {
            return '';
        }
        return `[${cleanLabel}](${href})`;
    });
}

function stripHtml(value: string): string {
    return value.replace(/<[^>]+>/g, '');
}

function decodeHtmlEntities(value: string): string {
    return value
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
}

async function markUnavailable(archiveRoot: string, entry: ManifestPost, manifest: Manifest, mblogid: string): Promise<void> {
    const postRoot = join(archiveRoot, entry.postDir);
    const now = nowShanghaiIso();
    entry.availability = 'unavailable';
    manifest.events.push({ id: crypto.randomUUID(), timestamp: now, type: 'unavailable_detected', mblogid });

    const metadataPath = join(postRoot, 'metadata.json');
    try {
        const metadata = (await Bun.file(metadataPath).json()) as MetadataFile;
        metadata.availability = 'unavailable';
        metadata.lastCheckedAt = now;
        await writeJson(metadataPath, metadata);
        const images = await readExistingImages(postRoot);
        const timelinePost: TimelinePost = {
            mblogid,
            mid: entry.mid,
            url: entry.url,
            createdAt: parseIsoShanghai(entry.createdAt),
            raw: {},
        };
        const payload = await readOptionalJson<WeiboStatus>(join(postRoot, 'payload.json'));
        const markdown = buildMarkdown(metadata.uid, timelinePost, payload ?? {}, metadata, images, undefined);
        await Bun.write(join(postRoot, 'post.md'), markdown);
    } catch {
        recordFailure(manifest, 'markdown', 'Post unavailable, but existing metadata or markdown could not be updated', undefined, mblogid);
    }
}

function parseIsoShanghai(value: string): ParsedPostDate {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\+08:00$/.exec(value);
    if (!match) {
        throw new Error(`Malformed manifest createdAt: ${value}`);
    }
    const instantMs = wallClockToUtcMs(
        {
            year: Number(match[1]),
            month: Number(match[2]),
            day: Number(match[3]),
            hour: Number(match[4]),
            minute: Number(match[5]),
            second: Number(match[6]),
        },
        SHANGHAI_OFFSET_MINUTES,
    );
    return {
        instantMs,
        isoShanghai: value,
        ymd: `${match[1]}${match[2]}${match[3]}`,
        hm: `${match[4]}:${match[5]}`,
        dirPrefix: `${match[1]}${match[2]}${match[3]}-${match[4]}`,
    };
}

async function requestJson(url: string, stage: FailureStage, requestContext: RequestContext, mblogid?: string, referer = DEFAULT_REFERER): Promise<unknown> {
    const response = await requestRaw(url, stage, requestContext, mblogid, { accept: ACCEPT_JSON, referer });
    const text = await response.text();
    detectTextRisk(text, stage, url, mblogid);
    try {
        const json = JSON.parse(text) as unknown;
        detectJsonRisk(json, stage, url, mblogid);
        return json;
    } catch (error) {
        if (error instanceof RiskSignalError) {
            throw error;
        }
        throw new Error('Malformed API response');
    }
}

async function requestRaw(
    url: string,
    stage: FailureStage,
    requestContext: RequestContext,
    mblogid?: string,
    options: { accept: string; referer?: string } = { accept: 'application/json' },
): Promise<Response> {
    for (let attempt = 0; attempt <= requestContext.maxRetries; attempt += 1) {
        if (attempt > 0) {
            await sleep(backoffMs(requestContext.retryBaseMs, attempt));
        }
        await requestDelay(requestContext.delayMs);
        try {
            const response = await fetchWithTimeout(url, {
                headers: {
                    'User-Agent': USER_AGENT,
                    Accept: options.accept,
                    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
                    'Client-Version': 'v2.47.50',
                    Cookie: requestContext.cookie,
                    'X-Requested-With': 'XMLHttpRequest',
                    ...(options.referer ? { Referer: options.referer } : {}),
                },
            });
            if ([403, 418, 429].includes(response.status)) {
                throw new RiskSignalError(`HTTP ${response.status}`, stage, sanitizeUrl(url), mblogid);
            }
            if (response.status >= 500) {
                if (attempt >= requestContext.maxRetries) {
                    throw new TransientStopError(`HTTP ${response.status}`, stage, sanitizeUrl(url), mblogid);
                }
                continue;
            }
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            return response;
        } catch (error) {
            if (error instanceof RiskSignalError || error instanceof TransientStopError) {
                throw error;
            }
            if (!isTransientNetworkError(error) || attempt >= requestContext.maxRetries) {
                const message = error instanceof Error ? error.message : 'Network request failed';
                if (isTransientNetworkError(error)) {
                    throw new TransientStopError(message, stage, sanitizeUrl(url), mblogid);
                }
                throw new Error(message);
            }
        }
    }

    throw new TransientStopError('Retry limit reached', stage, sanitizeUrl(url), mblogid);
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        return await fetch(url, { ...init, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

function detectTextRisk(text: string, stage: FailureStage, url: string, mblogid?: string): void {
    const lower = text.toLowerCase();
    if (
        lower.includes('sina visitor system') ||
        lower.includes('<html') ||
        lower.includes('login') ||
        lower.includes('captcha') ||
        text.includes('验证码') ||
        text.includes('安全验证') ||
        text.includes('访问频繁') ||
        text.includes('账号异常')
    ) {
        throw new RiskSignalError('Risk or authentication response detected', stage, sanitizeUrl(url), mblogid);
    }
}

function detectJsonRisk(json: unknown, stage: FailureStage, url: string, mblogid?: string): void {
    if (!isRecord(json)) {
        return;
    }
    if (isUnavailableResponse(json)) {
        return;
    }
    const ok = json.ok;
    const message = String(json.msg ?? json.message ?? json.error ?? '');
    if (ok === 0 || ok === false || /rate|频繁|验证|captcha|login|登录|异常/i.test(message)) {
        throw new RiskSignalError('API risk or authentication signal detected', stage, sanitizeUrl(url), mblogid);
    }
}

function isUnavailableResponse(json: unknown): boolean {
    if (!isRecord(json)) {
        return false;
    }
    const text = String(json.msg ?? json.message ?? json.error ?? json.error_code ?? '');
    return /deleted|not\s*exist|permission|forbidden|不可见|不存在|删除|权限|暂无权限/i.test(text);
}

function isTransientNetworkError(error: unknown): boolean {
    if (!(error instanceof Error)) {
        return false;
    }
    return /abort|timeout|timed out|socket|reset|econnreset|network|fetch failed/i.test(error.message);
}

function backoffMs(baseMs: number, attempt: number): number {
    const jitter = 0.8 + Math.random() * 0.4;
    return Math.round(baseMs * 2 ** (attempt - 1) * jitter);
}

async function requestDelay(fixedDelayMs: number | undefined): Promise<void> {
    const delay = fixedDelayMs ?? RANDOM_DELAY_MIN_MS + Math.floor(Math.random() * (RANDOM_DELAY_MAX_MS - RANDOM_DELAY_MIN_MS + 1));
    if (delay > 0) {
        await sleep(delay);
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadManifest(path: string, uid: string): Promise<Manifest> {
    await pruneStaleManifestTempFiles(path);
    const file = Bun.file(path);
    if (!(await file.exists())) {
        return { schemaVersion: ARCHIVE_SCHEMA_VERSION, uid, runs: [], posts: {}, failures: [], events: [] };
    }
    const manifest = (await file.json()) as Manifest;
    if (manifest.uid !== uid || manifest.schemaVersion !== ARCHIVE_SCHEMA_VERSION || !isRecord(manifest.posts)) {
        throw new Error('Malformed or incompatible manifest.json');
    }
    manifest.runs ??= [];
    manifest.failures ??= [];
    manifest.events ??= [];
    pruneManifestDiagnostics(manifest);
    return manifest;
}

async function saveManifest(path: string, manifest: Manifest): Promise<void> {
    manifest.updatedAt = nowShanghaiIso();
    pruneManifestDiagnostics(manifest);
    const dir = dirname(path);
    await Bun.$`mkdir -p ${dir}`.quiet();
    const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
    await Bun.write(tempPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await Bun.$`mv ${tempPath} ${path}`.quiet();
}

async function pruneStaleManifestTempFiles(path: string): Promise<void> {
    const dir = dirname(path);
    const manifestFile = basename(path);
    let filenames: string[];
    try {
        filenames = await readdir(dir);
    } catch {
        return;
    }

    for (const filename of filenames) {
        if (!filename.startsWith(`${manifestFile}.`) || !filename.endsWith('.tmp')) {
            continue;
        }
        try {
            await unlink(join(dir, filename));
        } catch {
            // Best-effort cleanup only; an old temp file should not block a run.
        }
    }
}

function pruneManifestDiagnostics(manifest: Manifest): void {
    manifest.runs = keepLast(manifest.runs, MAX_MANIFEST_RUNS);
    manifest.events = keepLast(manifest.events, MAX_MANIFEST_EVENTS);
    manifest.failures = keepLast(manifest.failures, MAX_MANIFEST_FAILURES);
}

function keepLast<T>(items: T[], limit: number): T[] {
    return items.length > limit ? items.slice(items.length - limit) : items;
}

async function writeJson(path: string, value: unknown): Promise<void> {
    await Bun.write(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function readOptionalJson<T>(path: string): Promise<T | undefined> {
    const file = Bun.file(path);
    if (!(await file.exists())) {
        return undefined;
    }
    try {
        return (await file.json()) as T;
    } catch {
        return undefined;
    }
}

function assignPostDirectories(posts: TimelinePost[], manifest: Manifest): void {
    const byDay = new Map<string, TimelinePost[]>();
    for (const post of posts) {
        if (manifest.posts[post.mblogid]) {
            continue;
        }
        const group = byDay.get(post.createdAt.ymd) ?? [];
        group.push(post);
        byDay.set(post.createdAt.ymd, group);
    }

    for (const [ymd, group] of byDay.entries()) {
        group.sort((left, right) => left.createdAt.instantMs - right.createdAt.instantMs);
        let sequence = maxSequenceForDay(manifest, ymd) + 1;
        for (const post of group) {
            const postDir = `posts/${post.createdAt.dirPrefix}-${pad3(sequence)}-${post.mblogid}`;
            manifest.posts[post.mblogid] = {
                mblogid: post.mblogid,
                mid: post.mid,
                url: post.url,
                createdAt: post.createdAt.isoShanghai,
                postDir,
                availability: 'available',
            };
            sequence += 1;
        }
    }
}

function maxSequenceForDay(manifest: Manifest, ymd: string): number {
    let max = 0;
    for (const entry of Object.values(manifest.posts)) {
        const match = new RegExp(`^posts/${ymd}-\\d{2}-(\\d{3})-`).exec(entry.postDir);
        if (match) {
            max = Math.max(max, Number(match[1]));
        }
    }
    return max;
}

async function selectPostsForWork(posts: TimelinePost[], manifest: Manifest, archiveRoot: string, options: CliOptions): Promise<TimelinePost[]> {
    const selected: TimelinePost[] = [];
    for (const post of posts) {
        const entry = manifest.posts[post.mblogid];
        if (!entry) {
            continue;
        }
        if (options.refresh || !(await isPostComplete(archiveRoot, entry))) {
            selected.push(post);
        }
    }
    return selected.sort((left, right) => left.createdAt.instantMs - right.createdAt.instantMs);
}

async function isPostComplete(archiveRoot: string, entry: ManifestPost): Promise<boolean> {
    const postRoot = join(archiveRoot, entry.postDir);
    for (const name of ['payload.json', 'metadata.json', 'images.json', 'post.md']) {
        const file = Bun.file(join(postRoot, name));
        if (!(await file.exists())) {
            return false;
        }
        if (name.endsWith('.json')) {
            try {
                await file.json();
            } catch {
                return false;
            }
        }
    }
    const images = await readExistingImages(postRoot);
    for (const image of images) {
        if (image.downloaded && image.localPath && !(await Bun.file(join(postRoot, image.localPath)).exists())) {
            return false;
        }
    }
    return true;
}

function recordFailure(manifest: Manifest, stage: FailureStage, message: string, url?: string, mblogid?: string): void {
    manifest.failures.push({
        id: crypto.randomUUID(),
        timestamp: nowShanghaiIso(),
        stage,
        mblogid,
        url: url ? sanitizeUrl(url) : undefined,
        message: sanitizeMessage(message),
    });
}

function sanitizeMessage(message: string): string {
    return message
        .replace(/SUB=[^;\s]+/g, 'SUB=[redacted]')
        .replace(/SUBP=[^;\s]+/g, 'SUBP=[redacted]')
        .slice(0, 500);
}

function sanitizeUrl(url: string): string {
    try {
        const parsed = new URL(url);
        const allowed = new URLSearchParams();
        for (const key of ['id', 'uid', 'page']) {
            const value = parsed.searchParams.get(key);
            if (value) {
                allowed.set(key, value);
            }
        }
        parsed.search = allowed.toString();
        parsed.hash = '';
        return parsed.toString();
    } catch {
        return url.slice(0, 200);
    }
}

function sanitizeFilename(value: string): string {
    return value.replace(/[^A-Za-z0-9._-]/g, '_');
}

function manifestOrThrow(manifest: Manifest | undefined): Manifest {
    if (!manifest) {
        throw new Error('Manifest not initialized');
    }
    return manifest;
}

function runOrThrow(run: ManifestRun | undefined): ManifestRun {
    if (!run) {
        throw new Error('Run not initialized');
    }
    return run;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

const exitCode = await main();
process.exit(exitCode);
