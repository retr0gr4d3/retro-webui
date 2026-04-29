/**
 * Rough token estimate (~4 chars per token) for context budgeting without a tokenizer.
 * @param {string|null|undefined} s
 */
export function approxTokensFromChars(s) {
	if (s == null || s === '') return 0;
	return Math.ceil(String(s).length / 4);
}

/**
 * @param {Array<{role:string,content:string}>} apiMessages
 * @param {object} settings
 * @param {number|null|undefined} modelContextLength from /v1/models when available
 * @returns {Array<{role:string,content:string}>}
 */
export function trimApiMessagesForContext(apiMessages, settings, modelContextLength) {
	const mode = settings.contextLimitMode || 'full';
	if (!Array.isArray(apiMessages) || apiMessages.length === 0) return apiMessages;
	if (mode === 'full') return apiMessages;

	const systemIdx = apiMessages.findIndex((m) => String(m?.role).toLowerCase() === 'system');
	const systemMsgs = systemIdx === 0 ? [apiMessages[0]] : [];
	const chat = systemIdx === 0 ? apiMessages.slice(1) : [...apiMessages];

	if (chat.length === 0) return apiMessages;

	if (mode === 'messages') {
		const max = Math.max(2, Number(settings.contextMaxMessages) || 50);
		if (chat.length <= max) return apiMessages;
		return [...systemMsgs, ...chat.slice(-max)];
	}

	let budget = Math.max(1024, Number(settings.contextMaxTokensBudget) || 8192);
	if (mode === 'backend') {
		const derived =
			modelContextLength != null && Number.isFinite(modelContextLength) && modelContextLength > 0
				? Math.floor(modelContextLength)
				: null;
		if (derived != null) {
			budget = derived;
		}
	}

	const reserveOut = Math.max(256, Number(settings.max_tokens) || 2048);
	const systemCost = approxTokensFromChars(systemMsgs[0]?.content);
	budget = Math.max(512, budget - reserveOut - systemCost);

	let used = 0;
	const kept = [];
	for (let i = chat.length - 1; i >= 0; i--) {
		const t = approxTokensFromChars(chat[i]?.content);
		if (used + t > budget && kept.length > 0) break;
		kept.push(chat[i]);
		used += t;
	}
	kept.reverse();
	if (kept.length === 0) kept.push(chat[chat.length - 1]);
	return [...systemMsgs, ...kept];
}
