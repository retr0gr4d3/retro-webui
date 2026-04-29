import { getSettings } from './storage.js';

function baseUrl() {
	const s = getSettings();
	return (s.apiUrl || 'http://localhost:5001/v1').replace(/\/$/, '');
}

function authHeaders() {
	const s = getSettings();
	const h = {};
	if (s.apiKey) h.Authorization = `Bearer ${s.apiKey}`;
	return h;
}

/**
 * @param {string} endpoint path starting with / or full URL
 */
export async function apiRequest(endpoint, options = {}) {
	const b = baseUrl();
	const url = endpoint.startsWith('http') ? endpoint : `${b}${endpoint.startsWith('/') ? '' : '/'}${endpoint}`;
	const headers = {
		'Content-Type': 'application/json',
		...authHeaders(),
		...options.headers,
	};
	const res = await fetch(url, { ...options, headers });
	const ct = res.headers.get('Content-Type') || '';
	if (ct.includes('application/json')) {
		const data = await res.json();
		if (!res.ok) {
			const msg = data.error?.message || data.error || JSON.stringify(data);
			throw new Error(msg || `HTTP ${res.status}`);
		}
		return data;
	}
	const text = await res.text();
	if (!res.ok) throw new Error(text || `HTTP ${res.status}`);
	return text;
}

export async function testConnection(overrideUrl) {
	const url = (overrideUrl || baseUrl()).replace(/\/$/, '');
	try {
		const res = await fetch(`${url}/models`, { headers: { ...authHeaders() } });
		if (res.ok) return { success: true, message: 'Connected (models listing OK)' };
		const t = await res.text();
		return { success: false, message: t || res.statusText || String(res.status) };
	} catch (e) {
		return { success: false, message: e.message || 'Connection failed' };
	}
}

function modelContextLengthFromPayload(m) {
	if (!m || typeof m !== 'object') return null;
	const raw =
		m.context_length ??
		m.max_context ??
		m.n_ctx ??
		m.contextLength ??
		m.ctx_size ??
		m.context ??
		m.model_params?.n_ctx;
	if (raw == null) return null;
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/** @returns {Promise<Array<{ id: string, name: string, contextLength: number|null }>>} */
export async function fetchModels() {
	const url = `${baseUrl()}/models`;
	try {
		const res = await fetch(url, { headers: { ...authHeaders() } });
		if (!res.ok) return [{ id: 'default', name: 'Default', contextLength: null }];
		const data = await res.json();
		if (data?.data && Array.isArray(data.data)) {
			return data.data.map((m) => ({
				id: m.id,
				name: m.id,
				contextLength: modelContextLengthFromPayload(m),
			}));
		}
		return [{ id: 'default', name: 'Default', contextLength: null }];
	} catch {
		return [{ id: 'default', name: 'Default', contextLength: null }];
	}
}

function inferenceParams(extra = {}) {
	const s = getSettings();
	return {
		model: extra.model ?? s.model ?? 'default',
		temperature: Number(extra.temperature ?? s.temperature ?? 0.7),
		max_tokens: parseInt(String(extra.max_tokens ?? s.max_tokens ?? 2048), 10),
		top_p: Number(extra.top_p ?? s.top_p ?? 0.9),
		frequency_penalty: Number(extra.frequency_penalty ?? s.frequency_penalty ?? 0),
		presence_penalty: Number(extra.presence_penalty ?? s.presence_penalty ?? 0),
	};
}

function chatPayload(messages, extra = {}) {
	return {
		...inferenceParams(extra),
		messages,
		stream: Boolean(extra.stream),
	};
}

function completionsPayload(prompt, extra = {}) {
	return {
		...inferenceParams(extra),
		prompt,
		stream: Boolean(extra.stream),
	};
}

/**
 * @param {Array<{role:string,content:string}>} messages
 * @returns {Promise<{ content: string, role: string }>}
 */
export async function sendChatCompletion(messages, opts = {}) {
	const body = chatPayload(messages, { stream: false });
	const url = `${baseUrl()}/chat/completions`;
	const res = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...authHeaders() },
		body: JSON.stringify(body),
		signal: opts.signal,
	});
	if (!res.ok) {
		const t = await res.text();
		throw new Error(t || `HTTP ${res.status}`);
	}
	const data = await res.json();
	const choice = data.choices?.[0];
	const msg = choice?.message;
	if (!msg?.content) throw new Error('Invalid response from API');
	return { content: msg.content, role: msg.role || 'assistant' };
}

/**
 * Legacy / text completions (single prompt string). Used with Kobold-style adapters.
 * @param {string} prompt
 * @returns {Promise<{ content: string, role: string }>}
 */
export async function sendPromptCompletion(prompt, opts = {}) {
	const body = completionsPayload(prompt, { stream: false });
	const url = `${baseUrl()}/completions`;
	const res = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...authHeaders() },
		body: JSON.stringify(body),
		signal: opts.signal,
	});
	if (!res.ok) {
		const t = await res.text();
		throw new Error(t || `HTTP ${res.status}`);
	}
	const data = await res.json();
	const choice = data.choices?.[0];
	const text = choice?.text;
	if (text == null) throw new Error('Invalid response from completions API');
	const s = String(text);
	if (!s.trim()) throw new Error('Empty completions response from API');
	return { content: s, role: 'assistant' };
}

/**
 * Stream chat completion (SSE). Calls onDelta with accumulated text.
 * @param {Array<{role:string,content:string}>} messages
 * @param {{ signal?: AbortSignal, onDelta?: (full: string) => void }} opts
 * @returns {Promise<{ content: string, role: string }>}
 */
export async function streamChatCompletion(messages, opts = {}) {
	const { signal, onDelta } = opts;
	const body = chatPayload(messages, { stream: true });
	const url = `${baseUrl()}/chat/completions`;
	const res = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...authHeaders() },
		body: JSON.stringify(body),
		signal,
	});
	if (!res.ok) {
		const t = await res.text();
		throw new Error(t || `HTTP ${res.status}`);
	}
	const reader = res.body?.getReader();
	if (!reader) throw new Error('No response body');

	const dec = new TextDecoder();
	let buf = '';
	let full = '';

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buf += dec.decode(value, { stream: true });
		const lines = buf.split('\n');
		buf = lines.pop() || '';
		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed.startsWith('data:')) continue;
			const data = trimmed.slice(5).trim();
			if (data === '[DONE]') continue;
			try {
				const json = JSON.parse(data);
				const delta = json.choices?.[0]?.delta;
				const piece =
					delta?.content ??
					delta?.text ??
					(typeof json.choices?.[0]?.text === 'string' ? json.choices[0].text : '');
				if (piece) {
					full += piece;
					onDelta?.(full);
				}
			} catch {
				// ignore parse errors for non-JSON lines
			}
		}
	}

	if (!String(full).trim()) {
		throw new Error('Empty model response (API returned no text — try empty-send again or adjust continuation prompt)');
	}

	return { content: full, role: 'assistant' };
}

/**
 * Stream text completions (SSE). Chunks may use choices[0].text or delta fields.
 * @param {string} prompt
 * @param {{ signal?: AbortSignal, onDelta?: (full: string) => void }} opts
 * @returns {Promise<{ content: string, role: string }>}
 */
export async function streamPromptCompletion(prompt, opts = {}) {
	const { signal, onDelta } = opts;
	const body = completionsPayload(prompt, { stream: true });
	const url = `${baseUrl()}/completions`;
	const res = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...authHeaders() },
		body: JSON.stringify(body),
		signal,
	});
	if (!res.ok) {
		const t = await res.text();
		throw new Error(t || `HTTP ${res.status}`);
	}
	const reader = res.body?.getReader();
	if (!reader) throw new Error('No response body');

	const dec = new TextDecoder();
	let buf = '';
	let full = '';

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buf += dec.decode(value, { stream: true });
		const lines = buf.split('\n');
		buf = lines.pop() || '';
		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed.startsWith('data:')) continue;
			const data = trimmed.slice(5).trim();
			if (data === '[DONE]') continue;
			try {
				const json = JSON.parse(data);
				const ch0 = json.choices?.[0];
				const delta = ch0?.delta;
				const t0 = typeof ch0?.text === 'string' ? ch0.text : '';
				const t1 = typeof delta?.text === 'string' ? delta.text : '';
				const t2 = delta?.content != null ? String(delta.content) : '';
				const piece = t0 || t1 || t2;
				if (piece) {
					full += piece;
					onDelta?.(full);
				}
			} catch {
				// ignore parse errors for non-JSON lines
			}
		}
	}

	if (!String(full).trim()) {
		throw new Error(
			'Empty model response from completions endpoint — check adapter and that /v1/completions is enabled',
		);
	}

	return { content: full, role: 'assistant' };
}
