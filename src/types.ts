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

export interface GatewayOutboundMessage {
  type: 'response';
  channelId: string;
  text: string;
}
