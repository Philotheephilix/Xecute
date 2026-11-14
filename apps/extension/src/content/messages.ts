import { z } from 'zod';

export const OpenSheetMessageSchema = z.object({
  type: z.literal('OPEN_SHEET'),
  ticker: z.string(),
  postId: z.string().optional(),
});

export const SheetSignedMessageSchema = z.object({
  type: z.literal('SHEET_SIGNED'),
  ticker: z.string(),
  amount: z.string(),
  signature: z.string(),
  publicKey: z.string(),
  credentialId: z.string(),
  floorProtection: z.boolean(),
  quoteId: z.string(),
});

export const GetRegistryMessageSchema = z.object({
  type: z.literal('GET_REGISTRY'),
});

export const PingMessageSchema = z.object({
  type: z.literal('PING'),
});

/** Sent by bridge.content.ts to sync web-app localStorage keys into chrome.storage.local */
export const SyncStorageMessageSchema = z.object({
  type: z.literal('SYNC_STORAGE'),
  payload: z.record(z.string(), z.string()),
});

export const MessageSchema = z.discriminatedUnion('type', [
  OpenSheetMessageSchema,
  SheetSignedMessageSchema,
  GetRegistryMessageSchema,
  PingMessageSchema,
  SyncStorageMessageSchema,
]);

export type Message = z.infer<typeof MessageSchema>;
export type OpenSheetMessage = z.infer<typeof OpenSheetMessageSchema>;
export type SheetSignedMessage = z.infer<typeof SheetSignedMessageSchema>;
export type GetRegistryMessage = z.infer<typeof GetRegistryMessageSchema>;
export type PingMessage = z.infer<typeof PingMessageSchema>;
export type SyncStorageMessage = z.infer<typeof SyncStorageMessageSchema>;
