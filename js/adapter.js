/**
 * KoboldCPP-style chat adapters: wrap each role’s content with instruction tokens,
 * then call /v1/completions with the concatenated prompt.
 */

const ADAPTER_KEYS = [
	'system_start',
	'system_end',
	'user_start',
	'user_end',
	'assistant_start',
	'assistant_end',
	'assistant_gen',
];

/** @param {Record<string, unknown>} raw */
export function normalizeAdapter(raw) {
	const out = {};
	for (const k of ADAPTER_KEYS) {
		out[k] = raw[k] != null ? String(raw[k]) : '';
	}
	return out;
}

/**
 * @param {Record<string, unknown>} data parsed JSON
 * @returns {asserts data is Record<string, string>}
 */
export function assertFlatAdapter(data) {
	if (data == null || typeof data !== 'object' || Array.isArray(data)) {
		throw new Error('Adapter must be a JSON object');
	}
}

/**
 * @param {ReturnType<typeof normalizeAdapter>} a
 * @param {Array<{role:string,content:string}>} messages
 */
export function formatChatWithAdapter(a, messages) {
	let buf = '';
	for (const m of messages) {
		const r = String(m.role || '').toLowerCase();
		const c = m.content != null ? String(m.content) : '';
		if (r === 'system') buf += a.system_start + c + a.system_end;
		else if (r === 'user') buf += a.user_start + c + a.user_end;
		else if (r === 'assistant') buf += a.assistant_start + c + a.assistant_end;
	}
	const genOpen = a.assistant_gen !== '' ? a.assistant_gen : a.assistant_start;
	buf += genOpen;
	return buf;
}

const adapterObjectCache = new Map();

/**
 * @param {string} filename e.g. ChatML.json
 * @param {string} [basePath] default adapters/
 */
export async function fetchAdapter(filename, basePath = 'adapters') {
	if (!filename || !String(filename).trim()) return null;
	const key = String(filename).trim();
	if (adapterObjectCache.has(key)) return adapterObjectCache.get(key);
	const url = `${basePath.replace(/\/$/, '')}/${encodeURIComponent(key)}`;
	const res = await fetch(url, { cache: 'force-cache' });
	if (!res.ok) throw new Error(`Could not load adapter “${key}”: HTTP ${res.status}`);
	const data = await res.json();
	assertFlatAdapter(data);
	const normalized = normalizeAdapter(data);
	adapterObjectCache.set(key, normalized);
	return normalized;
}

/** @returns {Promise<Array<{ file: string, label: string }>>} */
export async function fetchAdapterManifest(basePath = 'adapters') {
	try {
		const res = await fetch(`${basePath.replace(/\/$/, '')}/manifest.json`, { cache: 'force-cache' });
		if (!res.ok) return [];
		const data = await res.json();
		const list = data?.adapters;
		if (!Array.isArray(list)) return [];
		return list
			.filter((x) => x && typeof x.file === 'string')
			.map((x) => ({ file: x.file, label: typeof x.label === 'string' ? x.label : x.file }));
	} catch {
		return [];
	}
}
