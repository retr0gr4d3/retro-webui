import { substitutePersonaPlaceholders } from './persona.js';

/**
 * Build system prompt from character card (same intent as legacy conversations.js).
 * @param {object} character
 * @param {object} [settings] app settings (user persona name / about)
 */
export function buildSystemMessage(character, settings = {}) {
	const userName = (settings.userPersonaName && String(settings.userPersonaName).trim()) || 'User';
	const charName = (character?.name && String(character.name).trim()) || 'Assistant';

	let systemMessage = `You are ${charName}.`;
	if (character.personality) {
		systemMessage += `\n\nPersonality: ${substitutePersonaPlaceholders(character.personality, userName, charName)}`;
	}
	if (character.description) {
		systemMessage += `\n\nDescription: ${substitutePersonaPlaceholders(character.description, userName, charName)}`;
	}
	if (character.example_messages) {
		systemMessage += `\n\nExample conversations:\n${substitutePersonaPlaceholders(character.example_messages, userName, charName)}`;
	}

	const about = settings.userPersonaAbout != null ? String(settings.userPersonaAbout).trim() : '';
	systemMessage += `\n\n### Your conversation partner\n**Name:** ${userName}\n`;
	if (about) {
		systemMessage += `**About them:** ${about}\n`;
	}

	return systemMessage;
}
