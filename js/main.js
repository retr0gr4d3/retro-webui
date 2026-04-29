import {
	initStorage,
	getCharacters,
	saveCharacter,
	deleteCharacter,
	getConversations,
	getConversationsByCharacter,
	saveConversation,
	deleteConversation,
	getSettings,
	saveSettings,
	getCurrentCharacter,
	setCurrentCharacter,
	clearCurrentCharacter,
	getCurrentConversation,
	setCurrentConversation,
	clearCurrentConversation,
	exportAll,
	importBundle,
	wipeAll,
	generateId,
	ensureDefaultCharacter,
	DEFAULT_CHARACTER_ID,
} from './storage.js';
import {
	fetchModels,
	sendChatCompletion,
	streamChatCompletion,
	sendPromptCompletion,
	streamPromptCompletion,
	testConnection,
} from './api.js';
import { fetchAdapter, formatChatWithAdapter, fetchAdapterManifest } from './adapter.js';
import { fillMessageBodyMarkdown, fillMessageBodyPlain } from './markdown.bundle.js';
import { buildSystemMessage } from './prompt.js';
import { substitutePersonaPlaceholders } from './persona.js';
import { parseCharacterJson } from './character-import.js';
import { trimApiMessagesForContext } from './context.js';

const DEFAULT_AVATAR = 'img/default-avatar.svg';

/** @type {Record<string, number|null>} */
let modelsContextById = {};

const PRIVACY_BANNER_DISMISS_KEY = 'webui_v2_privacy_banner_dismissed_version';

const el = (id) => document.getElementById(id);

function isUserRole(role) {
	return String(role ?? '').toLowerCase() === 'user';
}
function isAssistantRole(role) {
	return String(role ?? '').toLowerCase() === 'assistant';
}
function isUserMessage(m) {
	return isUserRole(m?.role);
}
function isAssistantMessage(m) {
	return isAssistantRole(m?.role);
}
/** User + assistant turns only (tolerates legacy capitalized roles from imports). */
function visibleChatTurns(messages) {
	return messages.filter((m) => isUserMessage(m) || isAssistantMessage(m));
}

let editingCharacterId = null;
let streamAbort = null;
let lastFocusBeforeModal = null;

function toast(message, type = 'info') {
	const host = el('webui-toast-host');
	const t = document.createElement('div');
	t.className = `webui-toast webui-toast--${type}`;
	t.textContent = message;
	host.appendChild(t);
	setTimeout(() => t.remove(), 4500);
}

function applyAppearance() {
	const s = getSettings();
	document.documentElement.style.setProperty('--color-accent', s.accentColor);
	document.documentElement.classList.toggle('webui-theme-light', s.theme === 'light');
	document.documentElement.classList.toggle('webui-theme-dark', s.theme !== 'light');
	document.documentElement.style.setProperty('--webui-font-size', `${s.fontSize}px`);
}

function syncSettingsForm() {
	const s = getSettings();
	el('webui-api-url').value = s.apiUrl;
	el('webui-api-key').value = s.apiKey;
	el('webui-temperature').value = String(s.temperature);
	el('webui-temperature-val').textContent = String(s.temperature);
	el('webui-max-tokens').value = String(s.max_tokens);
	el('webui-max-tokens-val').textContent = String(s.max_tokens);
	el('webui-context-mode').value =
		['full', 'messages', 'tokens', 'backend'].includes(s.contextLimitMode) ? s.contextLimitMode : 'full';
	el('webui-context-max-messages').value = String(s.contextMaxMessages ?? 40);
	el('webui-context-tokens-budget').value = String(s.contextMaxTokensBudget ?? 8192);
	el('webui-continue-prompt').value = s.continuePrompt ?? '';
	updateContextLimitFieldsVisibility();
	el('webui-top-p').value = String(s.top_p);
	el('webui-top-p-val').textContent = String(s.top_p);
	el('webui-freq-pen').value = String(s.frequency_penalty);
	el('webui-freq-pen-val').textContent = String(s.frequency_penalty);
	el('webui-pres-pen').value = String(s.presence_penalty);
	el('webui-pres-pen-val').textContent = String(s.presence_penalty);
	el('webui-streaming').checked = s.streaming;
	el('webui-theme').value = s.theme;
	el('webui-accent').value = s.accentColor;
	el('webui-font-size').value = String(s.fontSize);
	el('webui-font-size-val').textContent = String(s.fontSize);
	el('webui-persona-name').value = s.userPersonaName ?? 'User';
	el('webui-persona-about').value = s.userPersonaAbout ?? '';
	populateTimezoneSelect();
	const tzDet = el('webui-display-timezone-detected');
	if (tzDet) tzDet.textContent = getResolvedLocalTimeZone() || '—';
	const tzSel = el('webui-display-timezone');
	if (tzSel) {
		const saved = (s.displayTimeZone != null ? String(s.displayTimeZone) : '').trim();
		const hasOpt = saved === '' || [...tzSel.options].some((o) => o.value === saved);
		if (saved && !hasOpt) {
			const o = document.createElement('option');
			o.value = saved;
			o.textContent = `${saved} (imported)`;
			tzSel.appendChild(o);
		}
		tzSel.value = saved;
	}
	const adSel = el('webui-chat-adapter');
	if (adSel && adSel.options.length > 0) {
		syncChatAdapterSelectValue(s.chatAdapter ?? '');
	}
}

function populateTimezoneSelect() {
	const sel = el('webui-display-timezone');
	if (!sel || sel.dataset.populated === '1') return;
	const auto = document.createElement('option');
	auto.value = '';
	auto.textContent = 'Automatic (browser)';
	sel.appendChild(auto);
	let zones = [];
	try {
		zones = Intl.supportedValuesOf('timeZone');
	} catch {
		zones = [
			'UTC',
			'Africa/Cairo',
			'America/Argentina/Buenos_Aires',
			'America/Sao_Paulo',
			'America/New_York',
			'America/Chicago',
			'America/Denver',
			'America/Los_Angeles',
			'America/Mexico_City',
			'Asia/Dubai',
			'Asia/Kolkata',
			'Asia/Shanghai',
			'Asia/Tokyo',
			'Asia/Seoul',
			'Australia/Sydney',
			'Europe/London',
			'Europe/Berlin',
			'Europe/Paris',
			'Europe/Moscow',
			'Pacific/Auckland',
		];
	}
	zones = [...new Set(zones)].sort((a, b) => a.localeCompare(b));
	for (const z of zones) {
		const o = document.createElement('option');
		o.value = z;
		o.textContent = z;
		sel.appendChild(o);
	}
	sel.dataset.populated = '1';
}

function updateContextLimitFieldsVisibility() {
	const mode = el('webui-context-mode')?.value || 'full';
	const msgWrap = el('webui-context-messages-wrap');
	const tokWrap = el('webui-context-tokens-wrap');
	const backNote = el('webui-context-backend-note');
	if (msgWrap) msgWrap.hidden = mode !== 'messages';
	if (tokWrap) tokWrap.hidden = mode !== 'tokens' && mode !== 'backend';
	if (backNote) backNote.hidden = mode !== 'backend';
}

async function populateModelSelect() {
	const select = el('webui-model-select');
	const s = getSettings();
	const models = await fetchModels();
	modelsContextById = Object.fromEntries(models.map((m) => [m.id, m.contextLength ?? null]));
	select.innerHTML = '';
	for (const m of models) {
		const o = document.createElement('option');
		o.value = m.id;
		o.textContent = m.name;
		select.appendChild(o);
	}
	if (models.some((m) => m.id === s.model)) select.value = s.model;
	else {
		const o = document.createElement('option');
		o.value = s.model;
		o.textContent = s.model;
		select.appendChild(o);
		select.value = s.model;
	}
}

function syncChatAdapterSelectValue(savedFile) {
	const select = el('webui-chat-adapter');
	if (!select) return;
	if (savedFile && ![...select.options].some((o) => o.value === savedFile)) {
		const o = document.createElement('option');
		o.value = savedFile;
		o.textContent = savedFile + ' (missing from manifest)';
		select.appendChild(o);
	}
	select.value = savedFile || '';
}

async function populateAdapterSelect() {
	const select = el('webui-chat-adapter');
	if (!select) return;
	const s = getSettings();
	const saved = s.chatAdapter ?? '';
	const entries = await fetchAdapterManifest();
	select.innerHTML = '';
	const none = document.createElement('option');
	none.value = '';
	none.textContent = 'None (OpenAI chat /messages)';
	select.appendChild(none);
	for (const { file, label } of entries) {
		const o = document.createElement('option');
		o.value = file;
		o.textContent = label;
		select.appendChild(o);
	}
	syncChatAdapterSelectValue(saved);
}

function readSettingsFromForm() {
	return {
		apiUrl: el('webui-api-url').value.trim() || 'http://localhost:5001/v1',
		apiKey: el('webui-api-key').value,
		model: el('webui-model-select').value,
		temperature: parseFloat(el('webui-temperature').value),
		max_tokens: parseInt(el('webui-max-tokens').value, 10),
		top_p: parseFloat(el('webui-top-p').value),
		frequency_penalty: parseFloat(el('webui-freq-pen').value),
		presence_penalty: parseFloat(el('webui-pres-pen').value),
		streaming: el('webui-streaming').checked,
		contextLimitMode: el('webui-context-mode').value,
		contextMaxMessages: Math.max(2, parseInt(el('webui-context-max-messages').value, 10) || 40),
		contextMaxTokensBudget: Math.max(512, parseInt(el('webui-context-tokens-budget').value, 10) || 8192),
		continuePrompt: el('webui-continue-prompt').value,
		theme: el('webui-theme').value,
		accentColor: el('webui-accent').value,
		fontSize: parseInt(el('webui-font-size').value, 10),
		displayTimeZone: el('webui-display-timezone')?.value?.trim() ?? '',
		userPersonaName: el('webui-persona-name').value.trim() || 'User',
		userPersonaAbout: el('webui-persona-about').value.trim(),
		chatAdapter: el('webui-chat-adapter')?.value ?? '',
	};
}

function persistSettingsFromForm() {
	const prevTz = getSettings().displayTimeZone ?? '';
	saveSettings(readSettingsFromForm());
	applyAppearance();
	const nextTz = getSettings().displayTimeZone ?? '';
	if (String(prevTz).trim() !== String(nextTz).trim()) {
		const conv = getStateConversation();
		if (conv) renderMessages(conv);
		refreshConversationList();
	}
}

function getStateCharacter() {
	return getCurrentCharacter();
}

/** Active conversation from storage — always the copy in the conversations list so it stays in sync after saves. */
function getStateConversation() {
	const cur = getCurrentConversation();
	if (!cur?.id) return cur ?? null;
	const latest = getConversations().find((c) => c.id === cur.id);
	return latest ?? cur;
}

function setStateCharacter(c) {
	if (c) setCurrentCharacter(c);
	else clearCurrentCharacter();
}

function setStateConversation(c) {
	if (c) setCurrentConversation(c);
	else clearCurrentConversation();
}

function avatarSrc(character) {
	if (character?.avatar) return character.avatar;
	return DEFAULT_AVATAR;
}

function showWelcome(textTitle, textBody) {
	const box = document.createElement('div');
	box.className = 'webui-welcome';
	box.innerHTML = `<h3>${escapeHtml(textTitle)}</h3><p>${escapeHtml(textBody)}</p>`;
	const root = el('webui-messages');
	root.innerHTML = '';
	root.appendChild(box);
}

function escapeHtml(s) {
	const d = document.createElement('div');
	d.textContent = s;
	return d.innerHTML;
}

/** Parse stored message / conversation timestamps (ISO, epoch ms, or epoch seconds). */
function parseMessageTimestamp(raw) {
	if (raw == null || raw === '') return null;
	if (raw instanceof Date) {
		return Number.isNaN(raw.getTime()) ? null : raw;
	}
	if (typeof raw === 'number' && Number.isFinite(raw)) {
		const ms = raw < 1e12 ? raw * 1000 : raw;
		const d = new Date(ms);
		return Number.isNaN(d.getTime()) ? null : d;
	}
	if (typeof raw === 'string') {
		const trimmed = raw.trim();
		if (!trimmed) return null;
		if (/^\d+$/.test(trimmed)) {
			const n = Number(trimmed);
			const ms = n < 1e12 ? n * 1000 : n;
			const d = new Date(ms);
			return Number.isNaN(d.getTime()) ? null : d;
		}
		const d = new Date(trimmed);
		if (!Number.isNaN(d.getTime())) return d;
		const n = Number(trimmed);
		if (Number.isFinite(n)) {
			const ms = n < 1e12 ? n * 1000 : n;
			const d2 = new Date(ms);
			return Number.isNaN(d2.getTime()) ? null : d2;
		}
	}
	return null;
}

function timestampMsForSort(raw) {
	const d = parseMessageTimestamp(raw);
	return d && !Number.isNaN(d.getTime()) ? d.getTime() : 0;
}

/** IANA zone from the runtime (browser), for explicit local wall-clock formatting. */
function getResolvedLocalTimeZone() {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone;
	} catch {
		return undefined;
	}
}

/** IANA id from Settings, or browser default when empty / "auto". */
function getEffectiveDisplayTimeZone() {
	const raw = getSettings().displayTimeZone;
	const trimmed = raw != null ? String(raw).trim() : '';
	if (trimmed === '' || trimmed.toLowerCase() === 'auto') {
		return getResolvedLocalTimeZone();
	}
	return trimmed;
}

/** Format an absolute instant in the selected (or browser) timezone and locale. */
function formatInstantForDisplay(d) {
	if (!d || Number.isNaN(d.getTime())) return '';
	const tz = getEffectiveDisplayTimeZone();
	const options = {
		dateStyle: 'short',
		timeStyle: 'short',
	};
	if (tz) options.timeZone = tz;
	try {
		return new Intl.DateTimeFormat(undefined, options).format(d);
	} catch {
		try {
			return tz ? d.toLocaleString(undefined, { timeZone: tz }) : d.toLocaleString();
		} catch {
			const fallback = getResolvedLocalTimeZone();
			return fallback
				? d.toLocaleString(undefined, { timeZone: fallback })
				: d.toLocaleString();
		}
	}
}

/** Visible label + valid `datetime` attribute for `<time>`. */
function formatMessageTimeForUi(raw) {
	const d = parseMessageTimestamp(raw);
	if (!d || Number.isNaN(d.getTime())) return { label: '', dateTime: '' };
	return {
		label: formatInstantForDisplay(d),
		dateTime: d.toISOString(),
	};
}

function renderMessages(conversation) {
	const root = el('webui-messages');
	root.innerHTML = '';
	if (!conversation) {
		showWelcome('Retrograde WebUI', 'Select a character to start.');
		return;
	}
	const visible = visibleChatTurns(conversation.messages);
	if (visible.length === 0 && !conversation.messages.some((m) => m.role === 'system')) {
		showWelcome('New conversation', 'Send a message below.');
		return;
	}
	for (let i = 0; i < conversation.messages.length; i++) {
		const m = conversation.messages[i];
		if (m.role === 'system') continue;
		root.appendChild(messageElement(m, conversation, i));
	}
	root.scrollTop = root.scrollHeight;
}

function personaContextForConversation(conversation) {
	const settings = getSettings();
	const userName = (settings.userPersonaName && String(settings.userPersonaName).trim()) || 'User';
	let charName = 'Assistant';
	if (conversation?.character_id) {
		const ch = getCharacters().find((c) => c.id === conversation.character_id);
		if (ch?.name) charName = String(ch.name).trim();
	}
	return { userName, charName };
}

function formatMessageContentForDisplay(text, conversation) {
	const { userName, charName } = personaContextForConversation(conversation);
	return substitutePersonaPlaceholders(text ?? '', userName, charName);
}

function createMessageEditButton() {
	const btn = document.createElement('button');
	btn.type = 'button';
	btn.className = 'webui-msg__edit';
	btn.setAttribute('aria-label', 'Edit this message');
	btn.title = 'Edit message';
	btn.innerHTML =
		'<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>';
	return btn;
}

function ensureMessageHasEditButton(bubble, msg) {
	if (bubble.querySelector('.webui-msg__edit')) return;
	if (msg.incomplete) return;
	if (!isUserMessage(msg) && !isAssistantMessage(msg)) return;
	bubble.appendChild(createMessageEditButton());
}

/** @param {number} messageIndex index in conversation.messages (includes system messages) */
function messageElement(msg, conversation, messageIndex) {
	const div = document.createElement('div');
	const role = isUserMessage(msg) ? 'user' : isAssistantMessage(msg) ? 'assistant' : 'system';
	div.className = `webui-msg webui-msg--${role}${msg.incomplete ? ' webui-msg--incomplete' : ''}`;
	div.dataset.msgIndex = String(messageIndex);
	const body = document.createElement('div');
	body.className = 'webui-msg__body';
	const display = formatMessageContentForDisplay(msg.content || '', conversation);
	if (msg.incomplete && !String(msg.content || '').trim()) {
		fillMessageBodyPlain(body, '');
	} else if (msg.incomplete) {
		fillMessageBodyPlain(body, display);
	} else {
		fillMessageBodyMarkdown(body, display);
	}
	div.appendChild(body);
	const { label, dateTime } = formatMessageTimeForUi(msg.timestamp);
	if (label) {
		const timeEl = document.createElement('time');
		timeEl.className = 'webui-msg__time';
		timeEl.dateTime = dateTime;
		timeEl.textContent = label;
		div.appendChild(timeEl);
	}
	ensureMessageHasEditButton(div, msg);
	return div;
}

function beginMessageEdit(wrap) {
	if (isGenerating) {
		toast('Wait for the current reply to finish.', 'info');
		return;
	}
	if (document.querySelector('#webui-messages .webui-msg--editing')) {
		toast('Finish or cancel the current edit first.', 'info');
		return;
	}
	const conv = getStateConversation();
	if (!conv) return;
	const idx = parseInt(wrap.dataset.msgIndex, 10);
	if (Number.isNaN(idx) || idx < 0 || idx >= conv.messages.length) return;
	const msg = conv.messages[idx];
	if (!msg || msg.incomplete || (!isUserMessage(msg) && !isAssistantMessage(msg))) return;

	wrap.classList.add('webui-msg--editing');
	const editBtn = wrap.querySelector('.webui-msg__edit');
	if (editBtn) editBtn.hidden = true;

	const body = wrap.querySelector('.webui-msg__body');
	if (!body) return;
	const raw = msg.content ?? '';
	const ta = document.createElement('textarea');
	ta.className = 'webui-input webui-msg__edit-input';
	ta.value = raw;
	ta.rows = Math.min(14, Math.max(3, raw.split('\n').length));
	const actions = document.createElement('div');
	actions.className = 'webui-msg__edit-actions';
	const saveBtn = document.createElement('button');
	saveBtn.type = 'button';
	saveBtn.className = 'webui-btn webui-btn--small webui-msg__edit-save';
	saveBtn.textContent = 'Save';
	const cancelBtn = document.createElement('button');
	cancelBtn.type = 'button';
	cancelBtn.className = 'webui-btn webui-btn--secondary webui-btn--small webui-msg__edit-cancel';
	cancelBtn.textContent = 'Cancel';
	actions.append(saveBtn, cancelBtn);
	body.replaceWith(ta);
	ta.insertAdjacentElement('afterend', actions);
	ta.focus();
	ta.setSelectionRange(ta.value.length, ta.value.length);
	ta.addEventListener('keydown', (e) => {
		if (e.key === 'Escape') {
			e.preventDefault();
			renderMessages(getStateConversation());
		}
	});
}

function commitMessageEdit(wrap) {
	const conv = getStateConversation();
	if (!conv) return;
	const idx = parseInt(wrap.dataset.msgIndex, 10);
	if (Number.isNaN(idx) || idx < 0 || idx >= conv.messages.length) {
		renderMessages(conv);
		return;
	}
	const ta = wrap.querySelector('.webui-msg__edit-input');
	if (!ta) return;
	const trimmed = ta.value.trim();
	if (!trimmed) {
		toast('Message cannot be empty.', 'error');
		return;
	}
	const msg = conv.messages[idx];
	if (!msg || (!isUserMessage(msg) && !isAssistantMessage(msg))) {
		renderMessages(conv);
		return;
	}
	msg.content = trimmed;
	if (idx < conv.messages.length - 1) {
		conv.messages.splice(idx + 1);
	}
	conv.updated_at = new Date().toISOString();
	saveConversation(conv);
	setStateConversation(conv);
	renderMessages(conv);
	refreshConversationList();
	toast('Message updated. Later messages were removed.', 'info');
}

function appendMessageToUI(msg, conversation = null) {
	const root = el('webui-messages');
	const welcome = root.querySelector('.webui-welcome');
	if (welcome) welcome.remove();
	const conv = conversation ?? getStateConversation();
	const idx = conv ? conv.messages.length - 1 : 0;
	root.appendChild(messageElement(msg, conv, idx));
	root.scrollTop = root.scrollHeight;
}

function removeTyping() {
	el('webui-typing')?.remove();
}

function showTyping() {
	removeTyping();
	const root = el('webui-messages');
	const t = document.createElement('div');
	t.id = 'webui-typing';
	t.className = 'webui-typing';
	t.innerHTML =
		'<span class="webui-typing__dots"><span>.</span><span>.</span><span>.</span></span>';
	t.setAttribute('aria-hidden', 'true');
	root.appendChild(t);
	root.scrollTop = root.scrollHeight;
}

function attachStreamingDotsPlaceholder(bodyEl) {
	clearStreamingDotsPlaceholder(bodyEl);
	const wrap = document.createElement('span');
	wrap.className = 'webui-msg__streaming-dots';
	wrap.setAttribute('aria-hidden', 'true');
	const inner = document.createElement('span');
	inner.className = 'webui-typing__dots';
	inner.innerHTML = '<span>.</span><span>.</span><span>.</span>';
	wrap.appendChild(inner);
	bodyEl.appendChild(wrap);
}

function clearStreamingDotsPlaceholder(bodyEl) {
	bodyEl.querySelector('.webui-msg__streaming-dots')?.remove();
}

let isGenerating = false;

function setGenerating(on) {
	el('webui-send-btn').disabled = on;
	el('webui-resend-btn').disabled = on;
	el('webui-back-msg-btn').disabled = on;
	el('webui-stop-btn').hidden = !on;
	isGenerating = on;
}

function buildApiMessages(conversation) {
	const settings = getSettings();
	const character = getCharacters().find((c) => c.id === conversation.character_id);
	const userName = (settings.userPersonaName && String(settings.userPersonaName).trim()) || 'User';
	const charName = (character?.name && String(character.name).trim()) || 'Assistant';
	const visible = visibleChatTurns(conversation.messages);
	const apiMessages = [];
	const systemContent = character
		? buildSystemMessage(character, settings)
		: conversation.messages.find((m) => m.role === 'system')?.content;
	if (systemContent) {
		apiMessages.push({ role: 'system', content: systemContent });
	}
	apiMessages.push(
		...visible.map((m) => ({
			role: isUserMessage(m) ? 'user' : 'assistant',
			content: substitutePersonaPlaceholders(m.content, userName, charName),
		})),
	);
	return apiMessages;
}

/** Ephemeral user line so APIs that require a user turn after assistant still generate (not saved to transcript). */
function applyContinuationToApiMessages(apiMessages, settings, useContinuation) {
	if (!useContinuation || !Array.isArray(apiMessages) || apiMessages.length === 0) return apiMessages;
	const last = apiMessages[apiMessages.length - 1];
	if (String(last?.role).toLowerCase() !== 'assistant') return apiMessages;
	const prompt =
		settings.continuePrompt != null ? String(settings.continuePrompt).trim() : '';
	return [...apiMessages, { role: 'user', content: prompt }];
}

async function sendToModel(conversation, opts = {}) {
	const settings = getSettings();
	let apiMessages = buildApiMessages(conversation);
	apiMessages = applyContinuationToApiMessages(apiMessages, settings, opts.continuation === true);
	const modelCtx = modelsContextById[settings.model];
	apiMessages = trimApiMessagesForContext(apiMessages, settings, modelCtx ?? null);
	removeTyping();
	setGenerating(true);
	streamAbort = new AbortController();

	const assistantMsg = {
		role: 'assistant',
		content: '',
		timestamp: new Date().toISOString(),
		incomplete: true,
	};
	conversation.messages.push(assistantMsg);
	saveConversation(conversation);

	const assistantIdx = conversation.messages.length - 1;
	const bubble = messageElement(assistantMsg, conversation, assistantIdx);
	bubble.classList.remove('webui-msg--incomplete');
	bubble.classList.add('webui-streaming');
	const root = el('webui-messages');
	root.querySelector('.webui-welcome')?.remove();
	root.appendChild(bubble);
	const bodyEl = bubble.querySelector('.webui-msg__body');
	attachStreamingDotsPlaceholder(bodyEl);
	root.scrollTop = root.scrollHeight;

	const onStreamDelta = (full) => {
		assistantMsg.content = full;
		clearStreamingDotsPlaceholder(bodyEl);
		if (full.length > 0) {
			fillMessageBodyPlain(bodyEl, formatMessageContentForDisplay(full, conversation));
		} else {
			attachStreamingDotsPlaceholder(bodyEl);
		}
		root.scrollTop = root.scrollHeight;
	};

	try {
		const adapterFile = (settings.chatAdapter && String(settings.chatAdapter).trim()) || '';
		const useAdapter = adapterFile.length > 0;

		if (useAdapter) {
			const adapter = await fetchAdapter(adapterFile);
			const prompt = formatChatWithAdapter(adapter, apiMessages);
			if (settings.streaming) {
				const result = await streamPromptCompletion(prompt, {
					signal: streamAbort.signal,
					onDelta: onStreamDelta,
				});
				assistantMsg.content = result.content;
				clearStreamingDotsPlaceholder(bodyEl);
				fillMessageBodyMarkdown(
					bodyEl,
					formatMessageContentForDisplay(assistantMsg.content, conversation),
				);
			} else {
				const result = await sendPromptCompletion(prompt, { signal: streamAbort.signal });
				assistantMsg.content = result.content;
				clearStreamingDotsPlaceholder(bodyEl);
				fillMessageBodyMarkdown(
					bodyEl,
					formatMessageContentForDisplay(assistantMsg.content, conversation),
				);
			}
		} else if (settings.streaming) {
			const result = await streamChatCompletion(apiMessages, {
				signal: streamAbort.signal,
				onDelta: onStreamDelta,
			});
			assistantMsg.content = result.content;
			clearStreamingDotsPlaceholder(bodyEl);
			fillMessageBodyMarkdown(bodyEl, formatMessageContentForDisplay(assistantMsg.content, conversation));
		} else {
			const result = await sendChatCompletion(apiMessages, { signal: streamAbort.signal });
			assistantMsg.content = result.content;
			clearStreamingDotsPlaceholder(bodyEl);
			fillMessageBodyMarkdown(bodyEl, formatMessageContentForDisplay(assistantMsg.content, conversation));
		}
		assistantMsg.incomplete = false;
		bubble.classList.remove('webui-streaming', 'webui-msg--incomplete');
		ensureMessageHasEditButton(bubble, assistantMsg);
		conversation.updated_at = new Date().toISOString();
		saveConversation(conversation);
		setStateConversation(conversation);
		maybeRetitle(conversation);
		refreshConversationList();
	} catch (e) {
		if (e.name === 'AbortError') {
			assistantMsg.incomplete = false;
			bubble.classList.remove('webui-streaming');
			if (!assistantMsg.content.trim()) {
				conversation.messages.pop();
				bubble.remove();
			} else {
				clearStreamingDotsPlaceholder(bodyEl);
				fillMessageBodyMarkdown(
					bodyEl,
					formatMessageContentForDisplay(assistantMsg.content + '\n\n[stopped]', conversation),
				);
				bubble.classList.remove('webui-msg--incomplete');
				ensureMessageHasEditButton(bubble, assistantMsg);
			}
			saveConversation(conversation);
			toast('Generation stopped', 'info');
		} else {
			assistantMsg.incomplete = false;
			bubble.classList.remove('webui-streaming');
			const errText = e.message || 'Request failed';
			clearStreamingDotsPlaceholder(bodyEl);
			fillMessageBodyMarkdown(
				bodyEl,
				formatMessageContentForDisplay(
					assistantMsg.content ? `${assistantMsg.content}\n\n[Error: ${errText}]` : `[Error: ${errText}]`,
					conversation,
				),
			);
			conversation.messages.pop();
			bubble.remove();
			toast(errText, 'error');
		}
	} finally {
		streamAbort = null;
		setGenerating(false);
		removeTyping();
	}
}

function maybeRetitle(conversation) {
	const userCount = conversation.messages.filter((m) => isUserMessage(m)).length;
	if (userCount !== 2) return;
	const firstUser = conversation.messages.find((m) => isUserMessage(m));
	if (!firstUser) return;
	let title = firstUser.content.trim().slice(0, 30);
	if (firstUser.content.length > 30) title += '…';
	conversation.title = title;
	conversation.updated_at = new Date().toISOString();
	saveConversation(conversation);
}

function refreshCharacterList() {
	const list = el('webui-character-list');
	list.innerHTML = '';
	const chars = getCharacters();
	const cur = getStateCharacter();
	if (chars.length === 0) {
		const p = document.createElement('p');
		p.className = 'webui-hint';
		p.textContent = 'No characters yet. Import JSON or create one.';
		list.appendChild(p);
		return;
	}
	for (const c of chars) {
		const row = document.createElement('div');
		row.className = 'webui-list-item' + (cur?.id === c.id ? ' is-active' : '');
		row.setAttribute('role', 'listitem');
		row.innerHTML = `
			<div class="webui-list-item__main">
				<div class="webui-list-item__title"></div>
				<div class="webui-list-item__meta"></div>
			</div>
			<button type="button" class="webui-list-item__del" title="Delete character" aria-label="Delete">×</button>
		`;
		row.querySelector('.webui-list-item__title').textContent = c.name;
		row.querySelector('.webui-list-item__meta').textContent = c.description
			? c.description.slice(0, 48) + (c.description.length > 48 ? '…' : '')
			: '—';
		row.addEventListener('click', (e) => {
			if (e.target.closest('.webui-list-item__del')) return;
			selectCharacterById(c.id);
		});
		row.querySelector('.webui-list-item__del').addEventListener('click', (e) => {
			e.stopPropagation();
			if (confirm(`Delete character “${c.name}” and their conversations?`)) {
				deleteCharacter(c.id);
				if (getStateCharacter()?.id === c.id) {
					setStateCharacter(null);
					setStateConversation(null);
					el('webui-character-name').textContent = 'Select a character';
					el('webui-character-avatar').src = DEFAULT_AVATAR;
					showWelcome('Retrograde WebUI', 'Select a character to start.');
					refreshConversationList();
				}
				refreshCharacterList();
				toast('Character deleted', 'info');
			}
		});
		list.appendChild(row);
	}
}

function refreshConversationList() {
	const list = el('webui-conversation-list');
	list.innerHTML = '';
	const character = getStateCharacter();
	if (!character) {
		const p = document.createElement('p');
		p.className = 'webui-hint';
		p.textContent = 'Pick a character first.';
		list.appendChild(p);
		return;
	}
	let convos = getConversationsByCharacter(character.id);
	convos = [...convos].sort((a, b) => timestampMsForSort(b.updated_at) - timestampMsForSort(a.updated_at));
	const cur = getStateConversation();
	if (convos.length === 0) {
		const p = document.createElement('p');
		p.className = 'webui-hint';
		p.textContent = 'No conversations. Tap + to start.';
		list.appendChild(p);
		return;
	}
	for (const conv of convos) {
		const row = document.createElement('div');
		row.className = 'webui-list-item' + (cur?.id === conv.id ? ' is-active' : '');
		row.setAttribute('role', 'listitem');
		const n = visibleChatTurns(conv.messages).length;
		row.innerHTML = `
			<div class="webui-list-item__main">
				<div class="webui-list-item__title"></div>
				<div class="webui-list-item__meta"></div>
			</div>
			<button type="button" class="webui-list-item__del" title="Delete" aria-label="Delete conversation">×</button>
		`;
		row.querySelector('.webui-list-item__title').textContent = conv.title || 'Conversation';
		const upd = parseMessageTimestamp(conv.updated_at);
		const when = upd ? formatInstantForDisplay(upd) : '—';
		row.querySelector('.webui-list-item__meta').textContent = `${n} messages · ${when}`;
		row.addEventListener('click', (e) => {
			if (e.target.closest('.webui-list-item__del')) return;
			loadConversationById(conv.id);
		});
		row.querySelector('.webui-list-item__del').addEventListener('click', (e) => {
			e.stopPropagation();
			if (!confirm('Delete this conversation?')) return;
			const wasActive = getStateConversation()?.id === conv.id;
			deleteConversation(conv.id);
			if (wasActive) {
				setStateConversation(null);
			}
			refreshConversationList();
			toast('Conversation deleted', 'info');
			if (
				getConversationsByCharacter(character.id).length === 0 &&
				getStateCharacter()?.id === character.id
			) {
				startNewConversation(null);
			} else if (wasActive) {
				showWelcome(character.name, 'Start a new conversation or pick one from the list.');
			}
		});
		list.appendChild(row);
	}
}

function selectCharacterById(id) {
	const c = getCharacters().find((x) => x.id === id);
	if (!c) return;
	setStateCharacter(c);
	el('webui-character-name').textContent = c.name;
	el('webui-character-avatar').src = avatarSrc(c);
	refreshCharacterList();
	refreshConversationList();
	const convos = [...getConversationsByCharacter(c.id)].sort(
		(a, b) => timestampMsForSort(b.updated_at) - timestampMsForSort(a.updated_at),
	);
	if (convos.length === 0) {
		startNewConversation(null);
	} else {
		loadConversationById(convos[0].id);
	}
	closeSidebarMobile();
}

function loadConversationById(id) {
	const conv = getConversations().find((c) => c.id === id);
	if (!conv) {
		toast('Conversation not found', 'error');
		return;
	}
	setStateConversation(conv);
	refreshConversationList();
	renderMessages(conv);
	closeSidebarMobile();
}

function startNewConversation(initialUserText = null) {
	const character = getStateCharacter();
	if (!character) {
		toast('Select a character first', 'error');
		return;
	}
	const conversation = {
		id: generateId(),
		character_id: character.id,
		title: `Chat with ${character.name}`,
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
		messages: [],
	};
	conversation.messages.push({
		role: 'system',
		content: buildSystemMessage(character, getSettings()),
		timestamp: new Date().toISOString(),
	});
	saveConversation(conversation);
	setStateConversation(conversation);
	el('webui-messages').innerHTML = '';

	if (character.first_message?.trim() && initialUserText == null) {
		const first = {
			role: 'assistant',
			content: character.first_message.trim(),
			timestamp: new Date().toISOString(),
		};
		conversation.messages.push(first);
		conversation.updated_at = new Date().toISOString();
		saveConversation(conversation);
		appendMessageToUI(first, conversation);
	} else if (initialUserText != null && initialUserText !== '') {
		if (character.first_message?.trim()) {
			const first = {
				role: 'assistant',
				content: character.first_message.trim(),
				timestamp: new Date().toISOString(),
			};
			conversation.messages.push(first);
			conversation.updated_at = new Date().toISOString();
			saveConversation(conversation);
			appendMessageToUI(first, conversation);
		}
		const userMessage = {
			role: 'user',
			content: initialUserText,
			timestamp: new Date().toISOString(),
		};
		conversation.messages.push(userMessage);
		saveConversation(conversation);
		appendMessageToUI(userMessage, conversation);
		el('webui-chat-input').value = '';
		showTyping();
		sendToModel(conversation);
	} else {
		showWelcome('New conversation', 'Send a message below.');
	}
	refreshConversationList();
	closeSidebarMobile();
}

async function sendUserMessage() {
	const character = getStateCharacter();
	if (!character) {
		toast('Select a character first', 'error');
		return;
	}
	let text = el('webui-chat-input').value.trim();
	let conv = getStateConversation();
	if (!conv) {
		if (text === '') {
			startNewConversation(null);
			continueAssistantIfLastTurnIsAssistant();
		} else {
			startNewConversation(text || null);
		}
		return;
	}
	if (text === '') {
		continueAssistant();
		return;
	}
	const message = {
		role: 'user',
		content: text,
		timestamp: new Date().toISOString(),
	};
	conv.messages.push(message);
	saveConversation(conv);
	appendMessageToUI(message, conv);
	el('webui-chat-input').value = '';
	showTyping();
	await sendToModel(conv);
}

/** If the transcript has no user/assistant turns yet, insert the card opening line so we can continue. */
function ensureAssistantOpeningFromCard(conv, character) {
	if (!character?.first_message?.trim()) return false;
	const visible = visibleChatTurns(conv.messages);
	if (visible.length > 0) return false;
	const first = {
		role: 'assistant',
		content: character.first_message.trim(),
		timestamp: new Date().toISOString(),
	};
	conv.messages.push(first);
	conv.updated_at = new Date().toISOString();
	saveConversation(conv);
	setStateConversation(conv);
	renderMessages(conv);
	refreshConversationList();
	return true;
}

function continueAssistant() {
	if (isGenerating) {
		toast('Wait for the current reply to finish.', 'info');
		return;
	}
	const character = getStateCharacter();
	const conv = getStateConversation();
	if (!character || !conv) {
		toast('Select a character and conversation', 'error');
		return;
	}
	let visible = visibleChatTurns(conv.messages);
	if (visible.length === 0) {
		ensureAssistantOpeningFromCard(conv, character);
		visible = visibleChatTurns(conv.messages);
	}
	if (visible.length === 0) {
		toast('Nothing to continue', 'error');
		return;
	}
	const last = visible[visible.length - 1];
	sendToModel(conv, { continuation: isAssistantMessage(last) });
}

/** After empty-send creates a new conversation, call the model if the card’s greeting left the last turn as assistant. */
function continueAssistantIfLastTurnIsAssistant() {
	const conv = getStateConversation();
	if (!conv) return;
	const visible = visibleChatTurns(conv.messages);
	const last = visible[visible.length - 1];
	if (visible.length > 0 && isAssistantMessage(last)) {
		continueAssistant();
	}
}

/** Remove a specific message object from the transcript (same reference as in conv.messages). */
function removeConversationTurn(conv, turn) {
	const idx = conv.messages.lastIndexOf(turn);
	if (idx === -1) return false;
	conv.messages.splice(idx, 1);
	conv.updated_at = new Date().toISOString();
	return true;
}

function deleteLastChatMessage() {
	if (isGenerating) {
		toast('Wait for the current reply to finish.', 'info');
		return;
	}
	const conv = getStateConversation();
	if (!conv) {
		toast('No active conversation', 'error');
		return;
	}
	for (let i = conv.messages.length - 1; i >= 0; i--) {
		const role = conv.messages[i].role;
		if (isUserRole(role) || isAssistantRole(role)) {
			conv.messages.splice(i, 1);
			conv.updated_at = new Date().toISOString();
			saveConversation(conv);
			setStateConversation(conv);
			renderMessages(conv);
			refreshConversationList();
			toast('Removed last message', 'info');
			return;
		}
	}
	toast('Nothing to remove', 'info');
}

async function resendToModel() {
	if (isGenerating) {
		toast('Wait for the current reply to finish.', 'info');
		return;
	}
	const character = getStateCharacter();
	if (!character) {
		toast('Select a character first', 'error');
		return;
	}
	const conv = getStateConversation();
	if (!conv) {
		toast('No active conversation', 'error');
		return;
	}
	const visible = visibleChatTurns(conv.messages);
	if (visible.length === 0) {
		toast('Nothing to resend', 'error');
		return;
	}
	const last = visible[visible.length - 1];
	const hasUser = visible.some((m) => isUserMessage(m));

	if (isUserMessage(last)) {
		await sendToModel(conv);
		return;
	}

	// Last turn is assistant: either only the card greeting, or a model reply after user text.
	if (!hasUser) {
		continueAssistant();
		return;
	}

	if (!removeConversationTurn(conv, last)) {
		toast('Could not remove last reply', 'error');
		return;
	}
	saveConversation(conv);
	setStateConversation(conv);
	renderMessages(conv);
	await sendToModel(conv);
}

async function regenerate() {
	const conv = getStateConversation();
	if (!conv) {
		toast('No active conversation', 'error');
		return;
	}
	const visible = visibleChatTurns(conv.messages);
	if (visible.length === 0) {
		toast('No messages to regenerate', 'error');
		return;
	}
	const last = visible[visible.length - 1];
	const hasUser = visible.some((m) => isUserMessage(m));
	if (isAssistantMessage(last)) {
		if (!hasUser) {
			continueAssistant();
			return;
		}
		if (!removeConversationTurn(conv, last)) {
			toast('Could not update conversation', 'error');
			return;
		}
		saveConversation(conv);
		renderMessages(conv);
		showTyping();
		await sendToModel(conv);
	} else {
		const content = last.content;
		if (!removeConversationTurn(conv, last)) {
			toast('Could not update conversation', 'error');
			return;
		}
		const userMessage = {
			role: 'user',
			content,
			timestamp: new Date().toISOString(),
		};
		conv.messages.push(userMessage);
		saveConversation(conv);
		renderMessages(conv);
		showTyping();
		await sendToModel(conv);
	}
}

function clearChat() {
	const conv = getStateConversation();
	if (!conv) return;
	if (!confirm('Clear all messages in this conversation?')) return;
	conv.messages = conv.messages.filter((m) => m.role === 'system');
	conv.updated_at = new Date().toISOString();
	saveConversation(conv);
	renderMessages(conv);
	toast('Chat cleared', 'info');
}

function openModal(node) {
	lastFocusBeforeModal = document.activeElement;
	node.hidden = false;
	const panel = node.querySelector('.webui-modal__panel');
	const bodyFirst = panel?.querySelector(
		'.webui-modal__body input, .webui-modal__body textarea, .webui-modal__body select'
	);
	const focusable =
		bodyFirst ||
		panel?.querySelector('button:not(.webui-modal__close), [href], input, select, textarea');
	(focusable || panel || node).focus();

	const onKey = (e) => {
		if (e.key === 'Escape') {
			closeModal(node);
		}
		if (e.key === 'Tab' && panel && node.contains(document.activeElement)) {
			const list = panel.querySelectorAll(
				'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
			);
			const arr = [...list].filter((x) => !x.disabled && x.offsetParent !== null);
			if (arr.length === 0) return;
			const i = arr.indexOf(document.activeElement);
			if (e.shiftKey && (i <= 0 || i === -1)) {
				e.preventDefault();
				arr[arr.length - 1].focus();
			} else if (!e.shiftKey && (i === arr.length - 1 || i === -1)) {
				e.preventDefault();
				arr[0].focus();
			}
		}
	};
	node._webuiKey = onKey;
	document.addEventListener('keydown', onKey);
}

function closeModal(node) {
	node.hidden = true;
	if (node._webuiKey) {
		document.removeEventListener('keydown', node._webuiKey);
		delete node._webuiKey;
	}
	lastFocusBeforeModal?.focus?.();
	lastFocusBeforeModal = null;
}

function wireModals() {
	document.querySelectorAll('[data-close-modal]').forEach((btn) => {
		btn.addEventListener('click', () => {
			const modal = btn.closest('.webui-modal');
			if (modal) closeModal(modal);
		});
	});
}

function openCharacterModal(character) {
	editingCharacterId = character?.id ?? null;
	el('webui-character-modal-title').textContent = editingCharacterId ? 'Edit character' : 'New character';
	el('webui-char-name').value = character?.name ?? '';
	el('webui-char-desc').value = character?.description ?? '';
	el('webui-char-personality').value = character?.personality ?? '';
	el('webui-char-first').value = character?.first_message ?? '';
	el('webui-char-examples').value = character?.example_messages ?? '';
	const prev = el('webui-char-avatar-preview');
	prev.src = avatarSrc(character || {});
	openModal(el('webui-character-modal'));
}

function saveCharacterFromForm() {
	const name = el('webui-char-name').value.trim();
	if (!name) {
		toast('Name is required', 'error');
		return;
	}
	const prev = el('webui-char-avatar-preview');
	const existing = editingCharacterId ? getCharacters().find((c) => c.id === editingCharacterId) : null;
	let avatar = existing?.avatar ?? null;
	const isDefaultPreview = prev.src.endsWith(DEFAULT_AVATAR) || prev.src.endsWith('/default-avatar.svg');
	if (prev.src.startsWith('data:')) avatar = prev.src;
	else if (existing?.avatar && prev.src === existing.avatar) avatar = existing.avatar;
	else if (!isDefaultPreview) avatar = prev.src;
	else if (!editingCharacterId) avatar = null;
	const character = {
		name,
		description: el('webui-char-desc').value.trim(),
		personality: el('webui-char-personality').value.trim(),
		first_message: el('webui-char-first').value.trim(),
		example_messages: el('webui-char-examples').value.trim(),
		avatar,
	};
	if (editingCharacterId) {
		const existing = getCharacters().find((c) => c.id === editingCharacterId);
		character.id = editingCharacterId;
		character.created_at = existing?.created_at ?? new Date().toISOString();
		character.updated_at = new Date().toISOString();
	} else {
		character.id = generateId();
		character.created_at = new Date().toISOString();
	}
	saveCharacter(character);
	closeModal(el('webui-character-modal'));
	refreshCharacterList();
	selectCharacterById(character.id);
	toast(editingCharacterId ? 'Character updated' : 'Character created', 'success');
	editingCharacterId = null;
}

function openImportModal() {
	el('webui-import-json').value = '';
	el('webui-import-file').value = '';
	openModal(el('webui-import-modal'));
}

function confirmImportCharacter() {
	const raw = el('webui-import-json').value.trim();
	if (!raw) {
		toast('Paste JSON or choose a file', 'error');
		return;
	}
	try {
		const character = parseCharacterJson(raw);
		character.created_at = new Date().toISOString();
		saveCharacter(character);
		closeModal(el('webui-import-modal'));
		refreshCharacterList();
		selectCharacterById(character.id);
		toast('Character imported', 'success');
	} catch (e) {
		toast(e.message || 'Import failed', 'error');
	}
}

function openForgetModal() {
	el('webui-forget-confirm').value = '';
	el('webui-forget-do').disabled = true;
	openModal(el('webui-forget-modal'));
}

function doForget() {
	wipeAll();
	ensureDefaultCharacter();
	try {
		localStorage.removeItem(PRIVACY_BANNER_DISMISS_KEY);
	} catch {
		/* ignore */
	}
	const privacyBanner = document.getElementById('webui-privacy-banner');
	if (privacyBanner) privacyBanner.hidden = false;
	setStateConversation(null);
	editingCharacterId = null;
	syncSettingsForm();
	applyAppearance();
	void Promise.all([populateModelSelect(), populateAdapterSelect()]);
	selectCharacterById(DEFAULT_CHARACTER_ID);
	refreshCharacterList();
	refreshConversationList();
	closeModal(el('webui-forget-modal'));
	toast('All local data removed', 'info');
}

function exportData() {
	const blob = new Blob([JSON.stringify(exportAll(), null, 2)], { type: 'application/json' });
	const a = document.createElement('a');
	a.href = URL.createObjectURL(blob);
	a.download = 'retro-ai-webui-data.json';
	a.click();
	URL.revokeObjectURL(a.href);
	toast('Export started', 'success');
}

function importDataFile() {
	const input = document.createElement('input');
	input.type = 'file';
	input.accept = '.json,application/json';
	input.addEventListener('change', () => {
		const f = input.files?.[0];
		if (!f) return;
		const reader = new FileReader();
		reader.onload = () => {
			try {
				const data = JSON.parse(reader.result);
				if (!confirm('Replace all data with this file?')) return;
				const r = importBundle(data);
				if (!r.ok) {
					toast(r.error || 'Import failed', 'error');
					return;
				}
				toast('Imported. Reloading…', 'success');
				setTimeout(() => location.reload(), 400);
			} catch (e) {
				toast(e.message || 'Invalid JSON', 'error');
			}
		};
		reader.readAsText(f);
	});
	input.click();
}

function toggleSidebarMobile(open) {
	const side = el('webui-sidebar');
	const back = el('webui-sidebar-backdrop');
	const btn = el('webui-sidebar-toggle');
	const want = open ?? !side.classList.contains('is-open');
	side.classList.toggle('is-open', want);
	back.hidden = !want;
	document.body.classList.toggle('webui-sidebar-open', want);
	btn.setAttribute('aria-expanded', want ? 'true' : 'false');
}

function closeSidebarMobile() {
	if (window.matchMedia('(max-width: 880px)').matches) toggleSidebarMobile(false);
}

function initPrivacyBanner() {
	const banner = document.getElementById('webui-privacy-banner');
	if (!banner) return;
	let v = banner.getAttribute('data-announcement-version');
	if (v == null || v === '') v = '1';
	const dismissBtn = banner.querySelector('.announcement-dismiss');
	try {
		if (localStorage.getItem(PRIVACY_BANNER_DISMISS_KEY) === String(v)) {
			banner.hidden = true;
		}
	} catch {
		/* ignore */
	}
	if (!dismissBtn) return;
	dismissBtn.addEventListener('click', () => {
		banner.hidden = true;
		try {
			localStorage.setItem(PRIVACY_BANNER_DISMISS_KEY, String(v));
		} catch {
			/* ignore */
		}
	});
}

function restoreSession() {
	const c = getCurrentCharacter();
	if (c) {
		el('webui-character-name').textContent = c.name;
		el('webui-character-avatar').src = avatarSrc(c);
		const conv = getCurrentConversation();
		const convos = [...getConversationsByCharacter(c.id)].sort(
			(a, b) => timestampMsForSort(b.updated_at) - timestampMsForSort(a.updated_at),
		);
		const convOk = conv && conv.character_id === c.id && convos.some((x) => x.id === conv.id);
		if (convOk) {
			renderMessages(conv);
		} else if (convos.length === 0) {
			startNewConversation(null);
		} else {
			loadConversationById(convos[0].id);
		}
	} else {
		showWelcome('Retrograde WebUI', 'Select a character to start.');
	}
	refreshCharacterList();
	refreshConversationList();
}

function init() {
	if (!initStorage()) toast('localStorage unavailable', 'error');

	ensureDefaultCharacter();

	initPrivacyBanner();

	applyAppearance();
	syncSettingsForm();
	void Promise.all([populateModelSelect(), populateAdapterSelect()]);
	wireModals();
	restoreSession();

	if (!getCurrentCharacter()) {
		const def = getCharacters().find((c) => c.id === DEFAULT_CHARACTER_ID);
		if (def) selectCharacterById(def.id);
	}

	el('webui-settings-btn').addEventListener('click', async () => {
		syncSettingsForm();
		openModal(el('webui-settings-modal'));
		const loading = el('webui-settings-loading');
		const content = el('webui-settings-content');
		loading.hidden = false;
		content.hidden = true;
		try {
			await Promise.all([populateModelSelect(), populateAdapterSelect()]);
			syncChatAdapterSelectValue(getSettings().chatAdapter ?? '');
			syncSettingsForm();
		} finally {
			loading.hidden = true;
			content.hidden = false;
		}
	});
	el('webui-help-btn').addEventListener('click', () => openModal(el('webui-help-modal')));

	document.querySelectorAll('.webui-open-disclaimer').forEach((btn) => {
		btn.addEventListener('click', () => openModal(el('webui-disclaimer-modal')));
	});

	el('webui-new-character-btn').addEventListener('click', () => openCharacterModal(null));
	el('webui-edit-character-btn').addEventListener('click', () => {
		const c = getStateCharacter();
		if (!c) toast('Select a character first', 'error');
		else openCharacterModal(c);
	});
	el('webui-import-character-btn').addEventListener('click', openImportModal);
	el('webui-char-save').addEventListener('click', saveCharacterFromForm);
	el('webui-import-confirm').addEventListener('click', confirmImportCharacter);

	el('webui-char-avatar').addEventListener('change', () => {
		const f = el('webui-char-avatar').files?.[0];
		if (!f) return;
		const r = new FileReader();
		r.onload = () => {
			el('webui-char-avatar-preview').src = r.result;
		};
		r.readAsDataURL(f);
	});

	el('webui-new-conversation-btn').addEventListener('click', () => startNewConversation(null));

	el('webui-messages').addEventListener('click', (e) => {
		const save = e.target.closest('.webui-msg__edit-save');
		if (save) {
			e.preventDefault();
			commitMessageEdit(save.closest('.webui-msg'));
			return;
		}
		const cancel = e.target.closest('.webui-msg__edit-cancel');
		if (cancel) {
			e.preventDefault();
			renderMessages(getStateConversation());
			return;
		}
		const pen = e.target.closest('.webui-msg__edit');
		if (pen && !pen.closest('.webui-msg--editing')) {
			e.preventDefault();
			const wrap = pen.closest('.webui-msg');
			if (wrap) beginMessageEdit(wrap);
		}
	});

	el('webui-send-btn').addEventListener('click', () => sendUserMessage());
	el('webui-chat-input').addEventListener('keydown', (e) => {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			const v = el('webui-chat-input').value.trim();
			if (v === '') {
				if (!getStateConversation()) {
					if (getStateCharacter()) {
						startNewConversation(null);
						continueAssistantIfLastTurnIsAssistant();
					} else toast('Select a character first', 'error');
				} else continueAssistant();
				return;
			}
			sendUserMessage();
		}
	});

	el('webui-regenerate-btn').addEventListener('click', () => regenerate());
	el('webui-resend-btn').addEventListener('click', () => resendToModel());
	el('webui-back-msg-btn').addEventListener('click', () => deleteLastChatMessage());
	el('webui-clear-chat-btn').addEventListener('click', clearChat);
	el('webui-stop-btn').addEventListener('click', () => streamAbort?.abort());

	el('webui-sidebar-toggle').addEventListener('click', () => toggleSidebarMobile());
	el('webui-sidebar-backdrop').addEventListener('click', () => toggleSidebarMobile(false));

	const bindSlider = (id, valId, key) => {
		const sl = el(id);
		const v = el(valId);
		sl.addEventListener('input', () => {
			v.textContent = sl.value;
			persistSettingsFromForm();
		});
	};
	bindSlider('webui-temperature', 'webui-temperature-val');
	bindSlider('webui-max-tokens', 'webui-max-tokens-val');
	bindSlider('webui-top-p', 'webui-top-p-val');
	bindSlider('webui-freq-pen', 'webui-freq-pen-val');
	bindSlider('webui-pres-pen', 'webui-pres-pen-val');
	bindSlider('webui-font-size', 'webui-font-size-val');

	['webui-api-url', 'webui-api-key', 'webui-persona-name'].forEach((id) => {
		el(id).addEventListener('change', persistSettingsFromForm);
	});
	el('webui-context-mode')?.addEventListener('change', () => {
		updateContextLimitFieldsVisibility();
		persistSettingsFromForm();
	});
	el('webui-context-max-messages')?.addEventListener('change', persistSettingsFromForm);
	el('webui-context-tokens-budget')?.addEventListener('change', persistSettingsFromForm);
	el('webui-continue-prompt')?.addEventListener('input', persistSettingsFromForm);
	el('webui-persona-about').addEventListener('input', persistSettingsFromForm);
	el('webui-model-select').addEventListener('change', persistSettingsFromForm);
	el('webui-chat-adapter')?.addEventListener('change', persistSettingsFromForm);
	el('webui-streaming').addEventListener('change', persistSettingsFromForm);
	el('webui-theme').addEventListener('change', persistSettingsFromForm);
	el('webui-accent').addEventListener('input', persistSettingsFromForm);
	el('webui-display-timezone')?.addEventListener('change', persistSettingsFromForm);

	el('webui-test-connection-btn').addEventListener('click', async () => {
		persistSettingsFromForm();
		const r = await testConnection();
		toast(r.message, r.success ? 'success' : 'error');
	});

	el('webui-export-btn').addEventListener('click', exportData);
	el('webui-import-btn').addEventListener('click', importDataFile);
	el('webui-forget-btn').addEventListener('click', openForgetModal);
	el('webui-forget-confirm').addEventListener('input', () => {
		el('webui-forget-do').disabled = el('webui-forget-confirm').value !== 'FORGET';
	});
	el('webui-forget-do').addEventListener('click', doForget);

	el('webui-import-file').addEventListener('change', () => {
		const f = el('webui-import-file').files?.[0];
		if (!f) return;
		const reader = new FileReader();
		reader.onload = () => {
			el('webui-import-json').value = reader.result;
		};
		reader.readAsText(f);
	});
}

init();
