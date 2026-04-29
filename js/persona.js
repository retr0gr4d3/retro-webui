/**
 * SillyTavern-style placeholders in character cards and messages.
 * @param {string|null|undefined} text
 * @param {string} userName Display name for the human user (replaces {{user}})
 * @param {string} characterName Assistant / card name (replaces {{char}})
 */
export function substitutePersonaPlaceholders(text, userName, characterName) {
	if (text == null || text === '') return '';
	const u = (userName && String(userName).trim()) || 'User';
	const c = (characterName && String(characterName).trim()) || 'Assistant';
	return String(text)
		.replace(/\{\{user\}\}/gi, u)
		.replace(/\{\{char\}\}/gi, c);
}
