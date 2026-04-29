import { generateId } from './storage.js';

/**
 * @param {string|object} jsonData
 * @returns {object} character shape for storage
 */
export function parseCharacterJson(jsonData) {
	let data = jsonData;
	if (typeof jsonData === 'string') {
		try {
			data = JSON.parse(jsonData);
		} catch (e) {
			throw new Error(`Invalid JSON: ${e.message}`);
		}
	}
	if (!data) throw new Error('No character data provided');

	const character = {
		id: generateId(),
		name: 'Unknown Character',
		avatar: null,
		description: '',
		personality: '',
		first_message: '',
		example_messages: '',
	};

	if (data.spec === 'chara_card_v2' && data.data) {
		const cardData = data.data;
		if (cardData.name) character.name = cardData.name;
		if (cardData.description) character.description = cardData.description;
		if (cardData.personality) character.personality = cardData.personality;
		if (cardData.avatar) character.avatar = cardData.avatar;
		if (cardData.first_mes) character.first_message = cardData.first_mes;
		if (cardData.mes_example) character.example_messages = cardData.mes_example;
		return character;
	}

	if (data.character) data = data.character;

	const dataField = data.data || {};

	if (data.name) character.name = data.name;
	else if (data.char_name) character.name = data.char_name;
	else if (dataField.name) character.name = dataField.name;
	else if (data.bot_name) character.name = data.bot_name;
	else if (data.character_name) character.name = data.character_name;

	if (data.avatar) character.avatar = data.avatar;
	else if (data.avatar_uri) character.avatar = data.avatar_uri;
	else if (data.img) character.avatar = data.img;
	else if (dataField.avatar) character.avatar = dataField.avatar;
	else if (data.image) character.avatar = data.image;

	if (data.description) character.description = data.description;
	else if (dataField.description) character.description = dataField.description;
	else if (data.char_description) character.description = data.char_description;
	else if (data.summary) character.description = data.summary;

	if (data.personality) character.personality = data.personality;
	else if (data.char_persona) character.personality = data.char_persona;
	else if (dataField.personality) character.personality = dataField.personality;
	else if (data.persona) character.personality = data.persona;

	if (data.first_message) character.first_message = data.first_message;
	else if (data.char_greeting) character.first_message = data.char_greeting;
	else if (data.first_mes) character.first_message = data.first_mes;
	else if (data.greeting) character.first_message = data.greeting;
	else if (dataField.first_message) character.first_message = dataField.first_message;
	else if (dataField.first_mes) character.first_message = dataField.first_mes;
	else if (data.welcome_message) character.first_message = data.welcome_message;
	else if (data.opening) character.first_message = data.opening;
	else if (data.introduction) character.first_message = data.introduction;

	if (data.example_messages) character.example_messages = data.example_messages;
	else if (data.example_dialogue) character.example_messages = data.example_dialogue;
	else if (data.mes_example) character.example_messages = data.mes_example;
	else if (dataField.example_messages) character.example_messages = dataField.example_messages;
	else if (dataField.mes_example) character.example_messages = dataField.mes_example;
	else if (data.examples || data.sample_dialogue) {
		character.example_messages = data.examples || data.sample_dialogue;
	}

	return character;
}
