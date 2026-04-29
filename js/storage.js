/**
 * Local-only persistence for WebUI v2.
 */

export const STORAGE_VERSION_EXPORT = '2.0';

const KEYS = {
	CHARACTERS: 'webui_v2_characters',
	CONVERSATIONS: 'webui_v2_conversations',
	SETTINGS: 'webui_v2_settings',
	CURRENT_CHARACTER: 'webui_v2_current_character',
	CURRENT_CONVERSATION: 'webui_v2_current_conversation',
};

const LEGACY_KEYS = {
	CHARACTERS: 'rao_characters',
	CONVERSATIONS: 'rao_conversations',
	SETTINGS: 'rao_settings',
	CURRENT_CHARACTER: 'rao_current_character',
	CURRENT_CONVERSATION: 'rao_current_conversation',
};

function defaultSettings() {
	return {
		apiUrl: 'http://localhost:5001/v1',
		apiKey: '',
		model: 'default',
		temperature: 0.7,
		max_tokens: 2048,
		top_p: 0.9,
		frequency_penalty: 0,
		presence_penalty: 0,
		streaming: false,
		theme: 'dark',
		accentColor: '#d4000b',
		fontSize: 16,
		userPersonaName: 'User',
		userPersonaAbout: 'I am a 348 year old wizard who lives on a mountain',
		contextLimitMode: 'full',
		contextMaxMessages: 40,
		contextMaxTokensBudget: 8192,
		continuePrompt: '',
		chatAdapter: '',
		/** IANA zone id, or empty string = use browser default. */
		displayTimeZone: '',
	};
}

export function generateId() {
	return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/** Stable id so the built-in Assistant can be re-seeded if missing. */
export const DEFAULT_CHARACTER_ID = 'webui-default-assistant';

function buildDefaultAssistantCharacter() {
	const now = new Date().toISOString();
	return {
		id: DEFAULT_CHARACTER_ID,
		name: 'Assistant',
		avatar: null,
		description:
			'You are Assistant, a helpful AI assistant that is ready to help the user with any requests they may have.',
		personality: 'Helpful, fun',
		first_message:
			"Hi {{user}}! I'm your helpful AI assistant, here to help you with any tasks you may have.",
		example_messages: [
			'User: Hello',
			"Assistant: Hi! I'm your helpful AI assistant, here to help you in any tasks you may have.",
			'User: What is the answer to 8 divided by 2?',
			"Assistant: That's easy! It's 4.",
		].join('\n'),
		created_at: now,
	};
}

/** Ensures the default Assistant character exists (e.g. after first load or wipe). Does not overwrite if already present. */
export function ensureDefaultCharacter() {
	const chars = getCharacters();
	if (chars.some((c) => c.id === DEFAULT_CHARACTER_ID)) return;
	saveCharacter(buildDefaultAssistantCharacter());
}

function isAvailable() {
	try {
		const t = '__webui_v2_test__';
		localStorage.setItem(t, t);
		localStorage.removeItem(t);
		return true;
	} catch {
		return false;
	}
}

function getRaw(key) {
	try {
		const item = localStorage.getItem(key);
		return item ? JSON.parse(item) : null;
	} catch (e) {
		console.error('storage get', key, e);
		return null;
	}
}

function setRaw(key, value) {
	try {
		localStorage.setItem(key, JSON.stringify(value));
		return true;
	} catch (e) {
		console.error('storage set', key, e);
		return false;
	}
}

function removeRaw(key) {
	try {
		localStorage.removeItem(key);
		return true;
	} catch (e) {
		return false;
	}
}

export function initStorage() {
	if (!isAvailable()) return false;

	if (!getRaw(KEYS.CHARACTERS)) setRaw(KEYS.CHARACTERS, []);
	if (!getRaw(KEYS.CONVERSATIONS)) setRaw(KEYS.CONVERSATIONS, []);
	if (!getRaw(KEYS.SETTINGS)) setRaw(KEYS.SETTINGS, defaultSettings());

	return true;
}

export function getCharacters() {
	return getRaw(KEYS.CHARACTERS) || [];
}

export function saveCharacter(character) {
	const list = getCharacters();
	const i = list.findIndex((c) => c.id === character.id);
	if (i !== -1) list[i] = character;
	else list.push(character);
	return setRaw(KEYS.CHARACTERS, list);
}

export function deleteCharacter(characterId) {
	const list = getCharacters().filter((c) => c.id !== characterId);
	setRaw(KEYS.CHARACTERS, list);
	const convos = getConversations().filter((c) => c.character_id !== characterId);
	setRaw(KEYS.CONVERSATIONS, convos);
	const cur = getCurrentCharacter();
	if (cur && cur.id === characterId) clearCurrentCharacter();
	return true;
}

export function getConversations() {
	return getRaw(KEYS.CONVERSATIONS) || [];
}

export function getConversationsByCharacter(characterId) {
	return getConversations().filter((c) => c.character_id === characterId);
}

export function saveConversation(conversation) {
	const list = getConversations();
	const i = list.findIndex((c) => c.id === conversation.id);
	if (i !== -1) list[i] = conversation;
	else list.push(conversation);
	setRaw(KEYS.CONVERSATIONS, list);
	const cur = getCurrentConversation();
	if (cur && cur.id === conversation.id) {
		setRaw(KEYS.CURRENT_CONVERSATION, conversation);
	}
	return true;
}

export function deleteConversation(conversationId) {
	const list = getConversations().filter((c) => c.id !== conversationId);
	setRaw(KEYS.CONVERSATIONS, list);
	const cur = getCurrentConversation();
	if (cur && cur.id === conversationId) clearCurrentConversation();
	return true;
}

export function getSettings() {
	const s = getRaw(KEYS.SETTINGS);
	return s && typeof s === 'object' ? { ...defaultSettings(), ...s } : defaultSettings();
}

export function saveSettings(settings) {
	const merged = { ...defaultSettings(), ...settings };
	return setRaw(KEYS.SETTINGS, merged);
}

export function getCurrentCharacter() {
	return getRaw(KEYS.CURRENT_CHARACTER);
}

export function setCurrentCharacter(character) {
	return setRaw(KEYS.CURRENT_CHARACTER, character);
}

export function clearCurrentCharacter() {
	removeRaw(KEYS.CURRENT_CHARACTER);
}

export function getCurrentConversation() {
	return getRaw(KEYS.CURRENT_CONVERSATION);
}

export function setCurrentConversation(conversation) {
	return setRaw(KEYS.CURRENT_CONVERSATION, conversation);
}

export function clearCurrentConversation() {
	removeRaw(KEYS.CURRENT_CONVERSATION);
}

/** Remove every v2 key including settings and API secrets. */
export function wipeAll() {
	Object.values(KEYS).forEach(removeRaw);
	initStorage();
}

export function exportAll() {
	return {
		version: STORAGE_VERSION_EXPORT,
		characters: getCharacters(),
		conversations: getConversations(),
		settings: getSettings(),
	};
}

function num(raw, fallback) {
	const n = Number(raw);
	return Number.isFinite(n) ? n : fallback;
}

function normalizeImportedSettings(raw) {
	const d = defaultSettings();
	if (!raw || typeof raw !== 'object') return d;
	return {
		apiUrl: typeof raw.apiUrl === 'string' ? raw.apiUrl : d.apiUrl,
		apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : d.apiKey,
		model: typeof raw.model === 'string' ? raw.model : d.model,
		temperature: num(raw.temperature, d.temperature),
		max_tokens: num(raw.max_tokens, d.max_tokens),
		top_p: num(raw.top_p, d.top_p),
		frequency_penalty: num(raw.frequency_penalty, d.frequency_penalty),
		presence_penalty: num(raw.presence_penalty, d.presence_penalty),
		streaming: Boolean(raw.streaming),
		theme: raw.theme === 'light' ? 'light' : 'dark',
		accentColor: typeof raw.accentColor === 'string' ? raw.accentColor : d.accentColor,
		fontSize: num(raw.fontSize, d.fontSize),
		userPersonaName:
			typeof raw.userPersonaName === 'string' ? raw.userPersonaName : d.userPersonaName,
		userPersonaAbout:
			typeof raw.userPersonaAbout === 'string' ? raw.userPersonaAbout : d.userPersonaAbout,
		contextLimitMode: ['full', 'messages', 'tokens', 'backend'].includes(raw.contextLimitMode)
			? raw.contextLimitMode
			: d.contextLimitMode,
		contextMaxMessages: Math.max(2, num(raw.contextMaxMessages, d.contextMaxMessages)),
		contextMaxTokensBudget: Math.max(512, num(raw.contextMaxTokensBudget, d.contextMaxTokensBudget)),
		continuePrompt:
			typeof raw.continuePrompt === 'string' ? raw.continuePrompt : d.continuePrompt,
		chatAdapter: typeof raw.chatAdapter === 'string' ? raw.chatAdapter : d.chatAdapter,
		displayTimeZone:
			typeof raw.displayTimeZone === 'string' ? raw.displayTimeZone.trim() : d.displayTimeZone,
	};
}

/**
 * @param {object} data
 * @returns {{ ok: boolean, error?: string }}
 */
export function importBundle(data) {
	if (!data || typeof data !== 'object') {
		return { ok: false, error: 'Invalid file' };
	}

	try {
		// Legacy export from Retro AI Online (storage.exportData)
		if (data.version === '1.0' || (Array.isArray(data.characters) && !data.version)) {
			if (Array.isArray(data.characters)) setRaw(KEYS.CHARACTERS, data.characters);
			if (Array.isArray(data.conversations)) setRaw(KEYS.CONVERSATIONS, data.conversations);
			if (data.settings && typeof data.settings === 'object') {
				const s = { ...getSettings(), ...data.settings };
				if (typeof s.streaming !== 'boolean') s.streaming = false;
				setRaw(KEYS.SETTINGS, normalizeImportedSettings(s));
			}
			return { ok: true };
		}

		if (data.version === '2.0' || data.version === STORAGE_VERSION_EXPORT) {
			if (Array.isArray(data.characters)) setRaw(KEYS.CHARACTERS, data.characters);
			if (Array.isArray(data.conversations)) setRaw(KEYS.CONVERSATIONS, data.conversations);
			if (data.settings) setRaw(KEYS.SETTINGS, normalizeImportedSettings(data.settings));
			return { ok: true };
		}

		return { ok: false, error: 'Unsupported export version' };
	} catch (e) {
		return { ok: false, error: e.message || 'Import failed' };
	}
}

export const storageKeys = KEYS;
export const legacyStorageKeys = LEGACY_KEYS;
