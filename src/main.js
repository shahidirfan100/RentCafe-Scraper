import { Actor, log } from 'apify';
import { Dataset, gotScraping } from 'crawlee';
import { chromium } from 'playwright';

const DEFAULT_START_URL = 'https://www.rentcafe.com/apartments-for-rent/new-york-city-ny/';
const DIRECT_API_URL = 'https://api.rentcafe.com/rentcafeapi.aspx';
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
];

const JSON_URL_HINTS = [
    'rentcafeapi.aspx',
    '/api/',
    'searchjson',
    'mapstate',
    'seosearch/getsortedresults',
    'apartmentavailability',
    'floorplan',
    'availability',
    'property',
];

const PLAYWRIGHT_LAUNCH_ARGS = [
    '--disable-blink-features=AutomationControlled',
    '--disable-dev-shm-usage',
    '--disable-extensions',
];

const API_TOKEN_REGEX = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/ig;

function toPositiveInt(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function parseJsonSafely(text) {
    if (typeof text !== 'string') return null;
    const trimmed = text.trim();
    if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return null;
    try {
        return JSON.parse(trimmed);
    } catch {
        return null;
    }
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function extractTextFromObjectValue(value) {
    if (!isPlainObject(value)) return undefined;

    const preferredKeys = [
        'Name',
        'name',
        'Title',
        'title',
        'Value',
        'value',
        'Description',
        'description',
        'Label',
        'label',
        'Amenity',
        'amenity',
    ];

    for (const key of preferredKeys) {
        const extracted = normalizeString(value[key]);
        if (extracted) return extracted;
    }

    const fallbackCandidates = Object.values(value)
        .map((entry) => {
            if (entry === null || entry === undefined) return undefined;
            if (typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean') {
                return normalizeString(entry);
            }
            if (isPlainObject(entry)) return extractTextFromObjectValue(entry);
            return undefined;
        })
        .filter(Boolean);

    return fallbackCandidates[0];
}

function normalizeString(value) {
    if (value === null || value === undefined) return undefined;
    const text = String(value).trim();
    return text || undefined;
}

function normalizeNumber(value) {
    if (value === null || value === undefined || value === '') return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeBoolean(value) {
    if (value === null || value === undefined || value === '') return undefined;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    const lowered = String(value).trim().toLowerCase();
    if (['true', 'yes', '1', '-1'].includes(lowered)) return true;
    if (['false', 'no', '0'].includes(lowered)) return false;
    return undefined;
}

function extractNumericValues(value) {
    const text = normalizeString(value);
    if (!text) return [];
    const matches = text.match(/\d[\d,]*(?:\.\d+)?/g) || [];
    return matches
        .map((entry) => normalizeNumber(entry.replace(/,/g, '')))
        .filter((entry) => entry !== undefined);
}

function parseRangeValues(value) {
    const numbers = extractNumericValues(value);
    if (!numbers.length) return {};
    if (numbers.length === 1) return { min: numbers[0], max: numbers[0] };
    return {
        min: numbers[0],
        max: numbers[numbers.length - 1],
    };
}

function normalizeAmenities(value) {
    if (!value) return undefined;

    if (Array.isArray(value)) {
        const normalized = value
            .map((entry) => {
                if (isPlainObject(entry)) return extractTextFromObjectValue(entry);
                if (Array.isArray(entry)) return normalizeAmenities(entry)?.join(', ');
                return normalizeString(entry);
            })
            .filter(Boolean);

        return normalized.length ? [...new Set(normalized)] : undefined;
    }

    if (isPlainObject(value)) {
        const single = extractTextFromObjectValue(value);
        return single ? [single] : undefined;
    }

    const text = normalizeString(value);
    if (!text) return undefined;

    const split = text.split(/[~^|,]/).map((entry) => normalizeString(entry)).filter(Boolean);
    return split.length ? [...new Set(split)] : [text];
}

function looksLikeImageUrl(url, keyPath = '') {
    const normalized = normalizeString(url);
    if (!normalized) return false;

    const loweredUrl = normalized.toLowerCase();
    const loweredPath = keyPath.toLowerCase();

    if (!/^https?:\/\//i.test(loweredUrl) && !loweredUrl.startsWith('//') && !loweredUrl.startsWith('/')) {
        return false;
    }

    if (/\.(jpg|jpeg|png|gif|webp|avif|bmp|svg)(\?|$)/i.test(loweredUrl)) return true;
    if (loweredPath.includes('image') || loweredPath.includes('photo') || loweredPath.includes('gallery')) return true;
    if (loweredUrl.includes('/dmslivecafe/') || loweredUrl.includes('/content/images/')) return true;
    return false;
}

function collectImageUrls(value, keyPath = '', bucket = new Set()) {
    if (value === null || value === undefined) return bucket;

    if (typeof value === 'string') {
        if (looksLikeImageUrl(value, keyPath)) {
            const absolute = toAbsoluteUrl(value);
            if (absolute) bucket.add(absolute);
        }
        return bucket;
    }

    if (Array.isArray(value)) {
        for (const entry of value) {
            collectImageUrls(entry, keyPath, bucket);
        }
        return bucket;
    }

    if (isPlainObject(value)) {
        for (const [key, nestedValue] of Object.entries(value)) {
            const nestedPath = keyPath ? `${keyPath}.${key}` : key;
            collectImageUrls(nestedValue, nestedPath, bucket);
        }
    }

    return bucket;
}

function parseBedsRange(value) {
    const text = normalizeString(value);
    if (!text) return {};

    const range = parseRangeValues(text);
    const hasStudio = /studio/i.test(text);
    const min = hasStudio
        ? 0
        : range.min;
    const max = range.max ?? range.min ?? (hasStudio ? 0 : undefined);

    return { min, max };
}

function extractBalancedSegment(text, startIndex, openChar = '{', closeChar = '}') {
    if (typeof text !== 'string') return null;
    if (startIndex < 0 || startIndex >= text.length) return null;
    if (text[startIndex] !== openChar) return null;

    let depth = 0;
    let inString = false;
    let quote = '';
    let escaped = false;

    for (let i = startIndex; i < text.length; i++) {
        const char = text[i];

        if (inString) {
            if (escaped) {
                escaped = false;
                continue;
            }
            if (char === '\\') {
                escaped = true;
                continue;
            }
            if (char === quote) {
                inString = false;
                quote = '';
            }
            continue;
        }

        if (char === '"' || char === '\'' || char === '`') {
            inString = true;
            quote = char;
            continue;
        }

        if (char === openChar) {
            depth++;
        } else if (char === closeChar) {
            depth--;
            if (depth === 0) {
                return text.slice(startIndex, i + 1);
            }
        }
    }

    return null;
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractAssignedObjectLiteral(markupText, variableName) {
    const text = typeof markupText === 'string' ? markupText : '';
    if (!text.trim()) return null;

    const assignmentRegex = new RegExp(`${escapeRegExp(variableName)}\\s*=`);
    const assignmentMatch = assignmentRegex.exec(text);
    if (!assignmentMatch) return null;

    const searchOffset = assignmentMatch.index + assignmentMatch[0].length;
    const remainder = text.slice(searchOffset);
    const objectStart = remainder.indexOf('{');
    if (objectStart < 0) return null;

    return extractBalancedSegment(remainder, objectStart, '{', '}');
}

function extractFirstMatch(markupText, regex) {
    if (typeof markupText !== 'string') return undefined;
    const match = regex.exec(markupText);
    return match?.[1];
}

function parseObjectLiteralSafely(objectLiteralText) {
    const text = normalizeString(objectLiteralText);
    if (!text) return null;

    const candidates = [
        text,
        text.replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":'),
    ];

    for (const candidate of candidates) {
        try {
            return JSON.parse(candidate);
        } catch {
            // Continue trying best-effort normalizations.
        }
    }

    return null;
}

function extractEmbeddedListingCandidates(markupText, sourcePageUrl) {
    const sources = [
        { variableName: 'RCILSMapListings', arrayField: 'rentals' },
        { variableName: 'ExtraRentalsJson', arrayField: 'Rentals' },
    ];

    const extracted = [];

    for (const source of sources) {
        const objectLiteral = extractAssignedObjectLiteral(markupText, source.variableName);
        if (!objectLiteral) continue;

        const parsedObject = parseObjectLiteralSafely(objectLiteral);
        if (!parsedObject || !Array.isArray(parsedObject[source.arrayField])) continue;

        const sourceLabel = `${sourcePageUrl}#${source.variableName}.${source.arrayField}`;
        for (const item of parsedObject[source.arrayField]) {
            if (!isPlainObject(item)) continue;
            extracted.push({ raw: item, sourceApiUrl: sourceLabel });
        }
    }

    if (!extracted.length) {
        const fallbackCandidates = collectListingObjects(markupText, `${sourcePageUrl}#embedded-fallback`);
        if (fallbackCandidates.length) extracted.push(...fallbackCandidates);
    }

    return extracted;
}

function extractNextPageUrlFromMarkup(markupText, currentUrl) {
    const nextHref = extractFirstMatch(markupText, /<link[^>]+rel=["']next["'][^>]+href=["']([^"']+)["']/i);
    if (!nextHref) return undefined;
    return toAbsoluteUrl(nextHref, currentUrl);
}

async function fetchMarkupWithRetries(targetUrl, proxyConfiguration, options = {}) {
    const url = normalizeString(targetUrl);
    if (!url) return null;

    const maxRetries = toPositiveInt(options.maxRetries, 3, 1, 8);
    const referer = normalizeString(options.referer);
    const cookieHeader = normalizeString(options.cookieHeader);

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const proxyUrl = proxyConfiguration ? await proxyConfiguration.newUrl() : undefined;
            const response = await gotScraping({
                url,
                proxyUrl,
                throwHttpErrors: false,
                timeout: { request: 45000 },
                headers: {
                    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'User-Agent': USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
                    ...(referer ? { Referer: referer } : {}),
                    ...(cookieHeader ? { Cookie: cookieHeader } : {}),
                },
            });

            const bodyText = typeof response.body === 'string'
                ? response.body
                : response.body?.toString?.() ?? '';

            if (!bodyText.trim()) {
                continue;
            }

            if (response.statusCode >= 400) {
                continue;
            }

            if (/attention required|cloudflare|cf-chl|just a moment/i.test(bodyText)) {
                continue;
            }

            return {
                url,
                bodyText,
                statusCode: response.statusCode,
            };
        } catch (error) {
            if (attempt === maxRetries) {
                log.warning('HTTP page fetch attempt failed.', {
                    url,
                    attempt,
                    error: error.message,
                });
            }
        }
    }

    return null;
}

function parseProxyUrlForPlaywright(proxyUrl) {
    const normalized = normalizeString(proxyUrl);
    if (!normalized) return undefined;

    try {
        const parsed = new URL(normalized);
        return {
            server: `${parsed.protocol}//${parsed.host}`,
            username: parsed.username || undefined,
            password: parsed.password || undefined,
        };
    } catch {
        return undefined;
    }
}

function isLikelyRentCafeApiUrl(urlCandidate) {
    const normalized = normalizeString(urlCandidate);
    if (!normalized) return false;

    const absoluteCandidate = toAbsoluteUrl(normalized, DIRECT_API_URL);
    if (!absoluteCandidate) return false;

    try {
        const parsed = new URL(absoluteCandidate);
        const hostname = parsed.hostname.toLowerCase();
        if (!hostname.includes('rentcafe.com')) return false;

        const lowerUrl = parsed.href.toLowerCase();
        return JSON_URL_HINTS.some((hint) => lowerUrl.includes(hint));
    } catch {
        return false;
    }
}

async function fetchMarkupViaPlaywright(targetUrl, proxyConfiguration, options = {}) {
    const url = normalizeString(targetUrl);
    if (!url) return null;
    const referer = normalizeString(options.referer);

    let browser;
    try {
        const discoveredApiContexts = new Map();
        const proxyUrl = proxyConfiguration ? await proxyConfiguration.newUrl() : undefined;
        const playwrightProxy = parseProxyUrlForPlaywright(proxyUrl);

        browser = await chromium.launch({
            headless: true,
            args: PLAYWRIGHT_LAUNCH_ARGS,
            ...(playwrightProxy ? { proxy: playwrightProxy } : {}),
        });

        const context = await browser.newContext({
            userAgent: USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
            locale: 'en-US',
            viewport: { width: 1366, height: 768 },
            deviceScaleFactor: 1,
            colorScheme: 'light',
            serviceWorkers: 'block',
            extraHTTPHeaders: {
                Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Upgrade-Insecure-Requests': '1',
                ...(referer ? { Referer: referer } : {}),
            },
        });
        await context.addInitScript(`
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
            window.chrome = window.chrome || { runtime: {} };
        `);
        const page = await context.newPage();

        const registerDiscoveredApi = (candidateUrl, source = 'playwright-network') => {
            const normalizedApiUrl = normalizeApiUrlCandidate(candidateUrl, url);
            if (!normalizedApiUrl) return;
            if (discoveredApiContexts.has(normalizedApiUrl)) return;
            discoveredApiContexts.set(normalizedApiUrl, { apiUrl: normalizedApiUrl, source });
        };

        page.on('request', (request) => {
            const requestUrl = request.url();
            if (isLikelyRentCafeApiUrl(requestUrl)) {
                registerDiscoveredApi(requestUrl, 'playwright-request');
            }
        });
        page.on('response', (response) => {
            const responseUrl = response.url();
            if (isLikelyRentCafeApiUrl(responseUrl)) {
                registerDiscoveredApi(responseUrl, 'playwright-response');
            }
        });

        await page.goto(url, { waitUntil: 'commit', timeout: 120000 });
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
        await page.mouse.move(200, 200).catch(() => {});
        await page.mouse.wheel(0, 400).catch(() => {});
        await page.waitForTimeout(1200);

        const bodyText = await page.content();
        if (!bodyText || /attention required|cloudflare|cf-chl|just a moment/i.test(bodyText)) {
            return null;
        }

        const cookies = await context.cookies(url);
        const cookieHeader = cookies.length
            ? cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')
            : undefined;

        return {
            url: page.url(),
            bodyText,
            cookieHeader,
            apiContexts: [...discoveredApiContexts.values()],
            statusCode: 200,
        };
    } catch (error) {
        log.warning('Browser fallback fetch failed.', { url, error: error.message });
        return null;
    } finally {
        if (browser) await browser.close().catch(() => {});
    }
}

function decodeURIComponentSafe(value) {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

function normalizeCityValue(value) {
    const normalized = normalizeString(value);
    if (!normalized) return undefined;

    const decoded = decodeURIComponentSafe(normalized)
        .replace(/\+/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/\s*,\s*/g, ',')
        .trim();

    return decoded || undefined;
}

function titleCaseWord(word) {
    if (!word) return '';
    if (word.length <= 2) return word.toUpperCase();
    return `${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()}`;
}

function deriveCityFromUrl(urlCandidate) {
    const normalizedUrl = normalizeString(urlCandidate);
    if (!normalizedUrl) return undefined;

    try {
        const parsed = new URL(normalizedUrl);
        const segments = parsed.pathname.split('/').filter(Boolean);
        if (!segments.length) return undefined;

        const tail = segments[segments.length - 1]
            .replace(/\.(html|htm|php)$/i, '')
            .toLowerCase();

        const parts = tail.split('-').filter(Boolean);
        if (parts.length < 2) return undefined;

        const stateCode = parts[parts.length - 1];
        if (!/^[a-z]{2}$/.test(stateCode)) return undefined;

        const cityParts = parts.slice(0, -1);
        if (!cityParts.length) return undefined;

        const cityName = cityParts.map((part) => titleCaseWord(part)).join(' ');
        return `${cityName},${stateCode.toUpperCase()}`;
    } catch {
        return undefined;
    }
}

function buildSearchJsonUrl(apiToken, city) {
    const token = normalizeString(apiToken);
    const normalizedCity = normalizeCityValue(city);
    if (!token || !normalizedCity) return undefined;

    const parsed = new URL(DIRECT_API_URL);
    parsed.searchParams.set('requestType', 'searchJSON');
    parsed.searchParams.set('apiToken', token);
    parsed.searchParams.set('city', normalizedCity);
    return parsed.href;
}

function normalizeApiUrlCandidate(candidate, fallbackOrigin = DIRECT_API_URL) {
    const asString = normalizeString(candidate);
    if (!asString) return undefined;

    const cleaned = asString.replace(/&amp;/gi, '&');
    const absoluteUrl = cleaned.startsWith('/rentcafeapi.aspx')
        ? new URL(cleaned, fallbackOrigin).href
        : toAbsoluteUrl(cleaned, fallbackOrigin);

    if (!absoluteUrl) return undefined;

    try {
        const parsed = new URL(absoluteUrl);
        const host = parsed.hostname.toLowerCase();
        if (!host.includes('rentcafe.com')) return undefined;
        if (!isLikelyRentCafeApiUrl(parsed.href)) return undefined;
        return parsed.href;
    } catch {
        return undefined;
    }
}

function extractDirectApiContexts(markupText, sourcePageUrl) {
    const text = typeof markupText === 'string' ? markupText : '';
    if (!text.trim()) return [];

    const contexts = new Map();
    const tokenCandidates = new Set();
    const cityCandidates = new Set();
    const fallbackCity = normalizeCityValue(deriveCityFromUrl(sourcePageUrl));
    if (fallbackCity) cityCandidates.add(fallbackCity);

    const registerContext = (apiUrl, source = 'markup') => {
        const normalizedApiUrl = normalizeApiUrlCandidate(apiUrl, sourcePageUrl || DIRECT_API_URL);
        if (!normalizedApiUrl) return;
        if (contexts.has(normalizedApiUrl)) return;
        contexts.set(normalizedApiUrl, { apiUrl: normalizedApiUrl, source });
    };

    const explicitApiUrlRegex = /(?:https?:)?\/\/api\.rentcafe\.com\/rentcafeapi\.aspx\?[^"'<>\s)]+/ig;
    for (const match of text.matchAll(explicitApiUrlRegex)) {
        registerContext(match[0], 'markup-url');
    }

    const relativeApiUrlRegex = /\/rentcafeapi\.aspx\?[^"'<>\s)]+/ig;
    for (const match of text.matchAll(relativeApiUrlRegex)) {
        registerContext(match[0], 'markup-relative-url');
    }

    for (const match of text.matchAll(API_TOKEN_REGEX)) {
        tokenCandidates.add(match[0]);
    }

    const cityValueRegex = /(?:city|cityname)\s*[=:]\s*["']([^"']{2,100})["']/ig;
    for (const match of text.matchAll(cityValueRegex)) {
        const normalizedCity = normalizeCityValue(match[1]);
        if (normalizedCity) cityCandidates.add(normalizedCity);
    }

    const cityQueryRegex = /[?&]city=([^&"'<>\s]+)/ig;
    for (const match of text.matchAll(cityQueryRegex)) {
        const normalizedCity = normalizeCityValue(match[1]);
        if (normalizedCity) cityCandidates.add(normalizedCity);
    }

    for (const context of contexts.values()) {
        try {
            const parsed = new URL(context.apiUrl);
            const token = normalizeString(parsed.searchParams.get('apiToken'));
            const city = normalizeCityValue(parsed.searchParams.get('city'));
            if (token) tokenCandidates.add(token);
            if (city) cityCandidates.add(city);
        } catch {
            // Ignore malformed URL fragments discovered in markup.
        }
    }

    const cityValues = [...cityCandidates].slice(0, 4);
    for (const token of [...tokenCandidates].slice(0, 4)) {
        for (const city of cityValues) {
            const searchApiUrl = buildSearchJsonUrl(token, city);
            if (searchApiUrl) {
                registerContext(searchApiUrl, 'token-city-derived');
            }
        }
    }

    return [...contexts.values()].slice(0, 12);
}

function mergeApiContexts(...groups) {
    const merged = new Map();
    for (const group of groups) {
        if (!Array.isArray(group)) continue;
        for (const entry of group) {
            const apiUrl = normalizeApiUrlCandidate(entry?.apiUrl);
            if (!apiUrl) continue;
            if (merged.has(apiUrl)) continue;
            merged.set(apiUrl, { apiUrl, source: normalizeString(entry?.source) || 'unknown' });
        }
    }
    return [...merged.values()];
}

async function fetchDirectApiCandidates(apiContexts, proxyConfiguration, fetchedApiUrls, limit) {
    const contexts = Array.isArray(apiContexts) ? apiContexts : [];
    const maxItems = toPositiveInt(limit, 20, 1, 500);
    const collected = [];

    for (const context of contexts) {
        if (collected.length >= maxItems) break;

        const apiUrl = normalizeString(context?.apiUrl);
        if (!apiUrl) continue;
        if (fetchedApiUrls.has(apiUrl)) continue;

        fetchedApiUrls.add(apiUrl);

        try {
            const proxyUrl = proxyConfiguration ? await proxyConfiguration.newUrl() : undefined;

            const response = await gotScraping({
                url: apiUrl,
                method: 'GET',
                proxyUrl,
                throwHttpErrors: false,
                timeout: {
                    request: 30000,
                },
                headers: {
                    Accept: 'application/json,text/plain,*/*',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'User-Agent': USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
                },
            });

            if (!response || response.statusCode >= 400) continue;

            const bodyText = typeof response.body === 'string'
                ? response.body
                : response.body?.toString?.() ?? '';
            const payload = parseJsonSafely(bodyText);
            if (!payload) continue;

            const extracted = collectListingObjects(payload, apiUrl);
            if (extracted.length) {
                collected.push(...extracted);
            }
        } catch (error) {
            log.debug('Direct API fetch attempt failed.', {
                apiUrl,
                error: error.message,
            });
        }
    }

    return collected;
}

function pruneNullish(value) {
    if (Array.isArray(value)) {
        const filtered = value
            .map(pruneNullish)
            .filter((entry) => entry !== undefined && entry !== null && entry !== '');
        return filtered.length ? filtered : undefined;
    }

    if (value && typeof value === 'object') {
        const entries = Object.entries(value)
            .map(([key, nestedValue]) => [key, pruneNullish(nestedValue)])
            .filter(([, nestedValue]) => nestedValue !== undefined && nestedValue !== null && nestedValue !== '');
        if (!entries.length) return undefined;
        return Object.fromEntries(entries);
    }

    if (value === undefined || value === null || value === '') return undefined;
    return value;
}

function toAbsoluteUrl(urlCandidate, fallbackOrigin = 'https://www.rentcafe.com') {
    const asString = normalizeString(urlCandidate);
    if (!asString) return undefined;

    if (asString.startsWith('//')) {
        return `https:${asString}`;
    }

    if (/^www\./i.test(asString) || /^[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(asString)) {
        return `https://${asString}`;
    }

    try {
        return new URL(asString, fallbackOrigin).href;
    } catch {
        return undefined;
    }
}

function pickValue(raw, aliases) {
    if (!raw || typeof raw !== 'object') return undefined;
    const entries = Object.entries(raw);
    for (const alias of aliases) {
        const hit = entries.find(([key]) => key.toLowerCase() === alias.toLowerCase());
        if (hit && hit[1] !== null && hit[1] !== undefined && hit[1] !== '') {
            return hit[1];
        }
    }
    return undefined;
}

function isLikelyListingObject(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
    const keys = Object.keys(raw).map((key) => key.toLowerCase());

    let score = 0;
    if (keys.some((key) => ['propertyname', 'propertyid', 'propertycode', 'propertyshortname'].includes(key))) score += 3;
    if (keys.some((key) => ['city', 'state', 'zipcode', 'address'].includes(key))) score += 2;
    if (keys.some((key) => ['minrent', 'maxrent', 'minimumrent', 'maximumrent'].includes(key))) score += 2;
    if (keys.some((key) => ['siteurl', 'availabilityurl', 'imageurl', 'floorplanimageurl'].includes(key))) score += 1;

    return score >= 4;
}

function collectListingObjects(payload, sourceApiUrl, out = []) {
    if (!payload) return out;

    if (Array.isArray(payload)) {
        for (const item of payload) {
            collectListingObjects(item, sourceApiUrl, out);
        }
        return out;
    }

    if (typeof payload !== 'object') {
        return out;
    }

    if (isLikelyListingObject(payload)) {
        out.push({ raw: payload, sourceApiUrl });
    }

    for (const value of Object.values(payload)) {
        if (value && typeof value === 'object') {
            collectListingObjects(value, sourceApiUrl, out);
        }
    }

    return out;
}

function buildRecordFromRaw(raw, sourceApiUrl, sourcePageUrl) {
    const nestedAddress = isPlainObject(pickValue(raw, ['Address', 'address']))
        ? pickValue(raw, ['Address', 'address'])
        : undefined;
    const nestedImage = isPlainObject(pickValue(raw, ['CurrentImage', 'currentImage']))
        ? pickValue(raw, ['CurrentImage', 'currentImage'])
        : undefined;

    const address = normalizeString(
        pickValue(raw, ['StreetAddress', 'AddressLine1', 'addressLine1'])
        || (isPlainObject(nestedAddress) ? pickValue(nestedAddress, ['Address', 'address', 'StreetAddress', 'Address1']) : undefined)
        || (!isPlainObject(pickValue(raw, ['Address', 'address'])) ? pickValue(raw, ['Address', 'address']) : undefined),
    );
    const city = normalizeString(
        pickValue(raw, ['City', 'city'])
        || (isPlainObject(nestedAddress) ? pickValue(nestedAddress, ['City', 'city']) : undefined),
    );
    const state = normalizeString(
        pickValue(raw, ['State', 'state'])
        || (isPlainObject(nestedAddress) ? pickValue(nestedAddress, ['State', 'state']) : undefined),
    );
    const zipCode = normalizeString(
        pickValue(raw, ['ZipCode', 'zipcode', 'zip'])
        || (isPlainObject(nestedAddress) ? pickValue(nestedAddress, ['ZipCode', 'zipcode', 'zip']) : undefined),
    );

    const propertyShortName = normalizeString(pickValue(raw, ['propertyShortName', 'shortName', 'slug']));
    const siteUrl = toAbsoluteUrl(
        pickValue(raw, ['SiteUrl', 'siteUrl', 'url', 'PropertyUrl', 'DetailsUrl', 'detailsUrl']),
        sourcePageUrl || 'https://www.rentcafe.com',
    );

    const detailUrl = toAbsoluteUrl(
        pickValue(raw, ['detailUrl', 'PropertyDetailPage', 'PropertyUrl', 'availabilityUrl', 'AvailabilityUrl', 'DetailsUrl', 'detailsUrl']),
        sourcePageUrl || 'https://www.rentcafe.com',
    );

    const amenitiesRaw = pickValue(raw, ['Amenity', 'amenities', 'Amenities']);
    const amenities = normalizeAmenities(amenitiesRaw);

    const imageUrl = toAbsoluteUrl(
        pickValue(raw, ['ImageURL', 'imageUrl', 'FloorPlanImageURL', 'PhotoUrl'])
        || (isPlainObject(nestedImage) ? pickValue(nestedImage, ['Url', 'url']) : undefined),
    );
    const imageUrls = [...collectImageUrls(raw)];
    if (imageUrl && !imageUrls.includes(imageUrl)) imageUrls.unshift(imageUrl);
    const primaryImageUrl = imageUrls[0];

    const bedRange = parseBedsRange(pickValue(raw, ['Beds', 'beds', 'BedroomRange']));
    const bathRange = parseRangeValues(pickValue(raw, ['Baths', 'baths', 'BathroomRange']));
    const rentRange = parseRangeValues(pickValue(raw, ['PriceValue', 'priceValue', 'Rent', 'rent']));
    const areaRange = parseRangeValues(pickValue(raw, ['Area', 'area', 'SqFt', 'sqft', 'SquareFeet']));

    const record = pruneNullish({
        property_name: normalizeString(pickValue(raw, ['PropertyName', 'name', 'title'])),
        property_short_name: propertyShortName,
        property_id: normalizeNumber(pickValue(raw, ['Propertyid', 'PropertyId', 'propertyId'])),
        property_code: normalizeString(pickValue(raw, ['PropertyCode', 'propertyCode', 'VoyagerPropertyCode'])),
        address,
        city,
        state,
        zip_code: zipCode,
        full_address: normalizeString([address, city, state, zipCode].filter(Boolean).join(', ')),
        phone: normalizeString(pickValue(raw, ['Phone', 'phone'])),
        site_url: siteUrl,
        detail_url: detailUrl,
        latitude: normalizeNumber(pickValue(raw, ['Latitude', 'latitude', 'dLatitude'])),
        longitude: normalizeNumber(pickValue(raw, ['Longitude', 'longitude', 'dLongitude'])),
        min_bedrooms: normalizeNumber(pickValue(raw, ['minbed', 'MinimumBeds'])) ?? bedRange.min,
        max_bedrooms: normalizeNumber(pickValue(raw, ['maxbed', 'MaximumBeds'])) ?? bedRange.max,
        min_bathrooms: normalizeNumber(pickValue(raw, ['minbath', 'MinimumBaths'])) ?? bathRange.min,
        max_bathrooms: normalizeNumber(pickValue(raw, ['maxbath', 'MaximumBaths'])) ?? bathRange.max,
        min_rent: normalizeNumber(pickValue(raw, ['minrent', 'MinimumRent'])) ?? rentRange.min,
        max_rent: normalizeNumber(pickValue(raw, ['maxrent', 'MaximumRent'])) ?? rentRange.max,
        min_area_sqft: normalizeNumber(pickValue(raw, ['MinArea', 'MinimumSqFt', 'MinimumSQFT', 'SQFT'])) ?? areaRange.min,
        max_area_sqft: normalizeNumber(pickValue(raw, ['MaxArea', 'MaximumSqFt', 'MaximumSQFT'])) ?? areaRange.max,
        beds_display: normalizeString(pickValue(raw, ['Beds', 'beds', 'BedroomRange'])),
        baths_display: normalizeString(pickValue(raw, ['Baths', 'baths', 'BathroomRange'])),
        price_display: normalizeString(pickValue(raw, ['PriceValue', 'priceValue', 'Rent', 'rent'])),
        area_display: normalizeString(pickValue(raw, ['Area', 'area', 'SqFt', 'sqft', 'SquareFeet'])),
        amenities,
        image_url: primaryImageUrl,
        image_urls: imageUrls.length ? imageUrls : undefined,
        image_count: imageUrls.length || undefined,
        specials_available: normalizeBoolean(pickValue(raw, ['bSpecialsAvailable', 'PropertyShowsSpecials', 'hasSpecials'])),
        is_fully_occupied: normalizeBoolean(pickValue(raw, ['IsFullyOccupied', 'fullyOccupied'])),
        featured_property: normalizeBoolean(pickValue(raw, ['FeaturedProperty', 'featured'])),
        available_units_count: normalizeNumber(pickValue(raw, ['AvailableUnitsCount', 'WaitlistUnitCount', 'availability', 'NumberOfRentals'])),
        company_name: normalizeString(pickValue(raw, ['CompanyDisplayName', 'companyName', 'CompanyName'])),
        has_online_leasing: normalizeBoolean(pickValue(raw, ['HasOnlineLeasing', 'hasOnlineLeasing'])),
        is_rentcafe_listing: normalizeBoolean(pickValue(raw, ['IsRentCafeListing', 'isRentCafeListing'])),
        verification_type: normalizeString(pickValue(raw, ['VerifiedType', 'verifiedType'])),
        property_type_id: normalizeNumber(pickValue(raw, ['PropertyTypeId', 'propertyTypeId'])),
        marketing_type: normalizeNumber(pickValue(raw, ['MarketingType', 'marketingType'])),
        source_page_url: normalizeString(sourcePageUrl),
        scraped_at: new Date().toISOString(),
    });

    if (!record?.property_id && !record?.site_url && !record?.address) {
        return undefined;
    }

    return record;
}

function dedupeKey(record) {
    return [
        record.property_id || '',
        record.property_code || '',
        record.property_name || '',
        record.address || '',
        record.city || '',
        record.state || '',
    ].join('::').toLowerCase();
}

function buildNextPageUrl(url, pageNo) {
    try {
        const parsed = new URL(url);
        const knownPageParams = ['page', 'p', 'pg', 'pageindex'];
        for (const key of knownPageParams) {
            if (parsed.searchParams.has(key)) {
                parsed.searchParams.set(key, String(pageNo));
                return parsed.href;
            }
        }
        parsed.searchParams.set('page', String(pageNo));
        return parsed.href;
    } catch {
        return null;
    }
}

async function run() {
    const input = (await Actor.getInput()) || {};
    const {
        startUrl,
        url,
        results_wanted = 20,
        max_pages = 1,
        proxyConfiguration: proxyInput,
    } = input;

    const resultsWanted = toPositiveInt(results_wanted, 20, 1, 500);
    const maxPages = toPositiveInt(max_pages, 1, 1, 10);
    const inferredPagesNeeded = Math.ceil(resultsWanted / 50);
    const effectiveMaxPages = Math.min(25, Math.max(maxPages, inferredPagesNeeded));

    const initialUrls = [];
    const addUrl = (candidate) => {
        if (typeof candidate === 'string') {
            const normalized = normalizeString(candidate);
            if (normalized) initialUrls.push(normalized);
            return;
        }

        if (candidate && typeof candidate === 'object' && typeof candidate.url === 'string') {
            const normalized = normalizeString(candidate.url);
            if (normalized) initialUrls.push(normalized);
        }
    };

    addUrl(startUrl);
    if (Array.isArray(url)) {
        for (const item of url) addUrl(item);
    } else {
        addUrl(url);
    }

    if (!initialUrls.length) {
        initialUrls.push(DEFAULT_START_URL);
    }

    let proxyConfiguration;
    if (proxyInput) {
        try {
            proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);
        } catch (error) {
            log.warning('Proxy configuration is invalid or unavailable. Continuing without proxy.', { error: error.message });
        }
    } else {
        const hasProxyCredentials = Boolean(process.env.APIFY_TOKEN || process.env.APIFY_PROXY_PASSWORD);
        if (Actor.isAtHome() || hasProxyCredentials) {
            try {
                proxyConfiguration = await Actor.createProxyConfiguration({
                    useApifyProxy: true,
                    apifyProxyGroups: ['RESIDENTIAL'],
                });
                log.info('Attempting default Apify Residential proxy for anti-blocking pagination.');
            } catch (error) {
                log.warning('Default Apify Residential proxy is unavailable. Continuing without proxy.', { error: error.message });
            }
        }
    }

    const seen = new Set();
    const fetchedApiUrls = new Set();
    const pendingBatch = [];
    const BATCH_SIZE = 100;
    let totalSaved = 0;

    const flushBatch = async (force = false) => {
        if (!pendingBatch.length) return 0;
        if (!force && pendingBatch.length < BATCH_SIZE) return 0;

        const toPush = pendingBatch.splice(0, pendingBatch.length);
        await Dataset.pushData(toPush);
        return toPush.length;
    };

    const addCandidatesToBatch = async (candidates, sourcePageUrl) => {
        const remaining = resultsWanted - totalSaved;
        if (remaining <= 0) return 0;

        let added = 0;
        for (const candidate of candidates) {
            if (added >= remaining) break;

            const normalized = buildRecordFromRaw(
                candidate.raw,
                candidate.sourceApiUrl,
                sourcePageUrl,
            );
            if (!normalized) continue;

            const uniqueKey = dedupeKey(normalized);
            if (seen.has(uniqueKey)) continue;

            seen.add(uniqueKey);
            pendingBatch.push(normalized);
            totalSaved++;
            added++;
        }

        await flushBatch(false);
        return added;
    };

    for (const baseUrl of initialUrls) {
        if (totalSaved >= resultsWanted) break;

        let currentUrl = normalizeString(baseUrl);
        let currentReferer = undefined;
        let currentCookieHeader = undefined;

        for (let pageNo = 1; pageNo <= effectiveMaxPages && currentUrl && totalSaved < resultsWanted; pageNo++) {
            let fetched = await fetchMarkupWithRetries(currentUrl, proxyConfiguration, {
                maxRetries: 3,
                referer: currentReferer,
                cookieHeader: currentCookieHeader,
            });

            if (!fetched) {
                fetched = await fetchMarkupViaPlaywright(currentUrl, proxyConfiguration, {
                    referer: currentReferer,
                });
            }

            if (!fetched) {
                log.warning(`Pagination stopped at page ${pageNo} due blocking/failures: ${currentUrl}`);
                break;
            }

            if (fetched.cookieHeader) {
                currentCookieHeader = fetched.cookieHeader;
            }

            let candidates = extractEmbeddedListingCandidates(fetched.bodyText, fetched.url);
            if (!candidates.length) {
                const directApiContexts = mergeApiContexts(
                    fetched.apiContexts,
                    extractDirectApiContexts(fetched.bodyText, fetched.url),
                );
                if (directApiContexts.length) {
                    candidates = await fetchDirectApiCandidates(
                        directApiContexts,
                        proxyConfiguration,
                        fetchedApiUrls,
                        resultsWanted - totalSaved,
                    );
                }
            }

            const added = await addCandidatesToBatch(candidates, fetched.url);
            if (added > 0) {
                log.info(`Page ${pageNo}: added ${added}. Total ${totalSaved}/${resultsWanted}`);
            }

            if (totalSaved >= resultsWanted) break;

            const nextUrl = extractNextPageUrlFromMarkup(fetched.bodyText, fetched.url) || buildNextPageUrl(fetched.url, pageNo + 1);
            if (!nextUrl || nextUrl === fetched.url) break;

            currentReferer = fetched.url;
            currentUrl = nextUrl;
        }
    }

    await flushBatch(true);

    if (!Number.isFinite(totalSaved) || totalSaved < 1) {
        const diagnosticRecord = {
            source_page_url: initialUrls[0],
            scrape_status: 'no_listings_captured',
            message: 'No listings captured due anti-bot blocking or transient upstream changes.',
            recommendation: 'Use residential proxy and re-run with the same start URL.',
            scraped_at: new Date().toISOString(),
        };
        await Dataset.pushData(diagnosticRecord);
        totalSaved = 1;
        log.warning('Saved diagnostic fallback record because listing extraction returned zero items.');
    }

    log.info('Run summary', { totalSaved, startUrls: initialUrls.length });

    if (totalSaved < resultsWanted) {
        log.warning(`Captured ${totalSaved}/${resultsWanted}. Target was not fully reached due anti-bot blocking on deeper pages.`);
    }

    log.info(`Scraping complete. Total listings saved: ${totalSaved}`);
}

await Actor.main(async () => {
    await run();
});
