export type SessionStatus = 'active' | 'idle' | 'archived';
export type MessageRole = 'user' | 'assistant' | 'tool';
export type ModelId = 'claude-sonnet-4-6' | 'claude-opus-4-6' | 'gpt-5.4' | 'gpt-5-mini';
export type ChannelType = 'telegram' | 'whatsapp' | 'slack' | 'discord';

// WebSocket protocol between channel connectors and gateway
export interface GatewayInboundMessage {
  type: 'message';
  channel: ChannelType;
  channelId: string;
  text: string;
}

export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

export interface InlineKeyboard {
  inline_keyboard: InlineKeyboardButton[][];
}

export interface GatewayOutboundMessage {
  type: 'response';
  channelId: string;
  text: string;
  photo?: string;
  replyMarkup?: InlineKeyboard;
}
