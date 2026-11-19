'use strict';

// Generic magnet-site adapter. The site URL and search path come from
// resources/match-sources.json, so the business logic stays source agnostic.
const CODE_RE = /(?:^|[^A-Za-z0-9])([A-Za-z]{2,12}[-_]\d{2,7}(?:[-_]\d+)?)(?=$|[^A-Za-z0-9])/i;
const decodeHtml = value => String(value ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();

function magnetTitle(magnet) {
    const query = String(magnet || '').split('?')[1] || '';
    const params = new URLSearchParams(query);
    return decodeHtml(params.get('dn') || '');
}

function extractCode(value) {
    return String(value || '').match(CODE_RE)?.[1]?.toUpperCase() || '';
}

class MagnetSource {
    constructor(options = {}) {
        this.baseUrl = options.baseUrl || '';
        this.searchPath = options.searchPath || '/api/magnets/search';
        this.queryParam = options.queryParam || 'query';
        this.timeout = Number(options.timeout) || 20000;
        this.fetcher = options.fetcher || ((...args) => (require('electron').net?.fetch || globalThis.fetch)(...args));
    }

    async search(keyword, options = {}) {
        if (!this.baseUrl) return [];
        const base = new URL(this.baseUrl);
        const url = new URL(this.searchPath, base);
        url.searchParams.set(this.queryParam, String(keyword || '').slice(0, 200));
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeout);
        try {
            const response = await this.fetcher(url, {
                signal: controller.signal,
                headers: {
                    Accept: 'application/json,text/html;q=0.9',
                    'User-Agent': 'Mozilla/5.0 (compatible; RxAiMatchAssistant/1.0)',
                    Referer: base.origin
                }
            });
            if (!response.ok) throw new Error(`数据源返回 HTTP ${response.status}`);
            const html = await response.text();
            if (html.trim().startsWith('{')) {
                const payload = JSON.parse(html);
                if (!Array.isArray(payload.data)) throw new Error('搜索接口返回格式异常');
                return payload.data.slice(0, options.limit || 25).map(item => ({
                    title: item.name || '',
                    fileTitle: String(item.largest_file || '').split(/[\\/]/).pop(),
                    code: extractCode(item.name) || extractCode(item.largest_file),
                    magnet: item.magnet_link || '',
                    sourceUrl: item.web_url || url.href,
                    size: item.size || 0
                }));
            }
            if (this.searchPath.startsWith('/api/')) throw new Error('搜索接口未返回 JSON，可能遇到验证页面或网站故障');
            return this.parse(html, url.href).slice(0, options.limit || 30);
        } finally {
            clearTimeout(timer);
        }
    }

    parse(html, pageUrl) {
        const results = new Map();
        const add = item => {
            if (!item.title && !item.magnet) return;
            const key = item.magnet || item.title;
            if (!key) return;
            const normalized = { ...item, source: 'magnet' };
            if (!results.has(key)) results.set(key, normalized);
        };

        // Magnet links are the most stable signal across sites.
        const magnetRe = /(?:href|data-href)\s*=\s*["']?(magnet:\?[^"'\s<>]+)/gi;
        for (const match of html.matchAll(magnetRe)) {
            const magnet = decodeHtml(match[1]);
            add({ title: magnetTitle(magnet), magnet, sourceUrl: pageUrl });
        }

        // Some sites wrap results as regular links. Treat anchor text as a title
        // when it contains a code or a long descriptive phrase.
        const anchorRe = /<a\b[^>]*href\s*=\s*["']?([^"'\s<>]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
        for (const match of html.matchAll(anchorRe)) {
            const href = decodeHtml(match[1]);
            const text = decodeHtml(match[2].replace(/<[^>]*>/g, ' '));
            if (!text || text.length < 4) continue;
            if (magnetRe.test(href) || href.startsWith('magnet:')) {
                const magnet = href.startsWith('magnet:') ? href : '';
                add({ title: text, magnet, sourceUrl: pageUrl });
            }
        }

        return [...results.values()].map(item => ({
            ...item,
            code: item.code || extractCode(item.title)
        }));
    }
}

module.exports = { MagnetSource, extractCode };
