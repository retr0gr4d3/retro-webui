/**
 * Markdown → HTML with local syntax highlighting; output sanitized (no remote fetches).
 * Served build: import from markdown.bundle.js (run `npm run build:markdown` after edits).
 */
import { marked } from '../node_modules/marked/lib/marked.esm.js';
import DOMPurify from '../node_modules/dompurify/dist/purify.es.mjs';
import hljs from '../node_modules/highlight.js/es/core.js';
import javascript from '../node_modules/highlight.js/es/languages/javascript.js';
import typescript from '../node_modules/highlight.js/es/languages/typescript.js';
import python from '../node_modules/highlight.js/es/languages/python.js';
import bash from '../node_modules/highlight.js/es/languages/bash.js';
import shell from '../node_modules/highlight.js/es/languages/shell.js';
import json from '../node_modules/highlight.js/es/languages/json.js';
import css from '../node_modules/highlight.js/es/languages/css.js';
import xml from '../node_modules/highlight.js/es/languages/xml.js';
import markdown from '../node_modules/highlight.js/es/languages/markdown.js';
import sql from '../node_modules/highlight.js/es/languages/sql.js';
import yaml from '../node_modules/highlight.js/es/languages/yaml.js';
import plaintext from '../node_modules/highlight.js/es/languages/plaintext.js';
import cpp from '../node_modules/highlight.js/es/languages/cpp.js';
import rust from '../node_modules/highlight.js/es/languages/rust.js';
import java from '../node_modules/highlight.js/es/languages/java.js';
import go from '../node_modules/highlight.js/es/languages/go.js';
import csharp from '../node_modules/highlight.js/es/languages/csharp.js';
import php from '../node_modules/highlight.js/es/languages/php.js';
import ruby from '../node_modules/highlight.js/es/languages/ruby.js';
import diff from '../node_modules/highlight.js/es/languages/diff.js';

const LANG_ALIASES = {
	js: 'javascript',
	ts: 'typescript',
	jsx: 'javascript',
	tsx: 'typescript',
	py: 'python',
	sh: 'bash',
	zsh: 'bash',
	yml: 'yaml',
	rs: 'rust',
	cs: 'csharp',
	rb: 'ruby',
	html: 'xml',
	htm: 'xml',
	vue: 'xml',
	text: 'plaintext',
	txt: 'plaintext',
	'c++': 'cpp',
	cpp: 'cpp',
	cc: 'cpp',
	hpp: 'cpp',
};

function normalizeLang(lang) {
	if (lang == null || String(lang).trim() === '') return null;
	const key = String(lang).trim().toLowerCase();
	return LANG_ALIASES[key] || key;
}

function escapeHtmlText(s) {
	return String(s)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

const hlRegistrations = [
	['javascript', javascript],
	['js', javascript],
	['typescript', typescript],
	['ts', typescript],
	['python', python],
	['py', python],
	['bash', bash],
	['shell', shell],
	['sh', shell],
	['zsh', shell],
	['json', json],
	['css', css],
	['scss', css],
	['xml', xml],
	['html', xml],
	['markdown', markdown],
	['md', markdown],
	['sql', sql],
	['yaml', yaml],
	['plaintext', plaintext],
	['text', plaintext],
	['txt', plaintext],
	['cpp', cpp],
	['rust', rust],
	['rs', rust],
	['java', java],
	['go', go],
	['csharp', csharp],
	['cs', csharp],
	['php', php],
	['ruby', ruby],
	['rb', ruby],
	['diff', diff],
];

for (const [name, mod] of hlRegistrations) {
	hljs.registerLanguage(name, mod);
}

marked.use({
	breaks: true,
	gfm: true,
	renderer: {
		code({ text, lang }) {
			const raw = text.replace(/\n$/, '');
			const name = normalizeLang(lang);
			let highlighted;
			try {
				if (name && hljs.getLanguage(name)) {
					highlighted = hljs.highlight(raw, { language: name }).value;
				} else {
					highlighted = hljs.highlight(raw, { language: 'plaintext' }).value;
				}
			} catch {
				highlighted = escapeHtmlText(raw);
			}
			const safeName =
				name && hljs.getLanguage(name)
					? String(name).replace(/[^\w-]/g, '-').replace(/^-|-$/g, '') || 'lang'
					: 'plaintext';
			return `<pre><code class="hljs language-${safeName}">${highlighted}</code></pre>\n`;
		},
	},
});

const PURIFY_FORBID_TAGS = [
	'img',
	'svg',
	'picture',
	'iframe',
	'object',
	'embed',
	'form',
	'button',
	'base',
	'link',
	'meta',
	'style',
	'script',
	'template',
];

if (typeof window !== 'undefined') {
	DOMPurify.addHook('afterSanitizeAttributes', (node) => {
		if (node.tagName === 'A' && node instanceof HTMLAnchorElement) {
			node.setAttribute('target', '_blank');
			node.setAttribute('rel', 'noopener noreferrer');
		}
	});
}

/**
 * @param {string} src
 * @returns {string}
 */
export function renderMarkdownToSafeHtml(src) {
	if (src == null || src === '') return '';
	let html;
	try {
		html = marked.parse(String(src), { async: false });
	} catch {
		return `<p>${escapeHtmlText(String(src))}</p>`;
	}
	return DOMPurify.sanitize(html, {
		FORBID_TAGS: PURIFY_FORBID_TAGS,
		ALLOW_UNKNOWN_PROTOCOLS: false,
		ADD_ATTR: ['align'],
	});
}

/**
 * @param {HTMLElement} bodyEl
 * @param {string} text
 */
export function fillMessageBodyMarkdown(bodyEl, text) {
	bodyEl.classList.add('webui-msg__body--md');
	bodyEl.innerHTML = renderMarkdownToSafeHtml(text);
}

/**
 * Streaming / plain fallback — no HTML parsing.
 * @param {HTMLElement} bodyEl
 * @param {string} text
 */
export function fillMessageBodyPlain(bodyEl, text) {
	bodyEl.classList.remove('webui-msg__body--md');
	bodyEl.textContent = text;
}
