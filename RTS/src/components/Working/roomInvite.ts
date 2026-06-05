/**
 * Pure builders for the "invite a friend to my room" share flow.
 *
 * The game is a static client-side app (no backend), so it cannot send a
 * message itself — every channel hands the invite off to a third-party app via
 * a deep link or web intent. Two delivery styles exist:
 *
 *   • Prefilled hand-off: the app accepts the message in its URL (mailto, sms,
 *     WhatsApp, Telegram, Teams). Opening the link drops the player into a
 *     pre-written message; some also pre-target a recipient.
 *   • Copy-and-paste hand-off: the app exposes no prefill API to an outside web
 *     page (Signal, Messenger, Discord, Slack, Snapchat, WeChat). The honest
 *     best is to copy the invite to the clipboard and open the app so the
 *     player can paste it into the conversation they choose.
 *
 * All URL/string construction lives here, free of React and the DOM, so it can
 * be unit tested and reused by whichever channel the player selects. The
 * component decides *how* to act on a ShareAction (new tab vs. clipboard).
 */

/** Subject line used for the email invite and the native share-sheet title. */
export const INVITE_SUBJECT = 'Join my Animal RTS battle';

/**
 * Query-string key carrying the room code in a join link. When the game boots
 * with this parameter present, it routes straight to multiplayer and joins —
 * the recipient never types the code (see App boot + MultiplayerScreen).
 */
export const ROOM_CODE_PARAM = 'room';

/**
 * Build the one-tap join link: the live game URL with the room code attached as
 * a query parameter. Appends with the correct separator so an existing query
 * string is preserved, and normalizes the code to its canonical upper case.
 */
export function buildJoinUrl(roomCode: string, gameUrl: string): string {
  const normalizedCode = roomCode.trim().toUpperCase();
  const separator = gameUrl.includes('?') ? '&' : '?';
  return `${gameUrl}${separator}${ROOM_CODE_PARAM}=${encodeURIComponent(normalizedCode)}`;
}

/**
 * Extract a room code from a URL query string (e.g. `window.location.search`),
 * or null when absent/malformed. Room codes are short alphanumerics, so this
 * rejects anything outside that shape rather than feeding junk into the join
 * flow. The leading `?` is optional — URLSearchParams handles either form.
 */
export function readRoomCodeFromUrl(search: string): string | null {
  const rawCode = new URLSearchParams(search).get(ROOM_CODE_PARAM);
  if (!rawCode) return null;
  const normalizedCode = rawCode.trim().toUpperCase();
  return /^[A-Z0-9]{3,8}$/.test(normalizedCode) ? normalizedCode : null;
}

/** Whether a channel needs the player to type a recipient, and of what kind. */
export type RecipientKind = 'none' | 'email' | 'phone';

/** Identifiers for every share channel offered in the dropdown. */
export type ShareChannelId =
  | 'email'
  | 'sms'
  | 'whatsapp'
  | 'telegram'
  | 'messenger'
  | 'teams'
  | 'signal'
  | 'discord'
  | 'slack'
  | 'snapchat'
  | 'wechat'
  | 'copy';

/** Static description of a share channel, used to drive the dropdown + form. */
export interface ShareChannel {
  id: ShareChannelId;
  label: string;
  /** Recipient input to show beneath the dropdown (none hides the field). */
  recipient: RecipientKind;
  /** Placeholder for the recipient input, when one is shown. */
  recipientPlaceholder: string;
  /** When true, Send Code stays disabled until a recipient is entered. */
  recipientRequired: boolean;
  /** True when the app has no prefill API, so the player must paste manually. */
  requiresPaste: boolean;
}

/**
 * What the UI should do when the player presses Send Code for a channel. A URL
 * is opened (deep link or web app) and/or the invite is copied to the
 * clipboard; `requiresPaste` tells the UI to instruct the player to paste.
 */
export interface ShareAction {
  /** Deep link or web-app URL to open. Empty string means open nothing. */
  url: string;
  /** Copy the invite text to the clipboard as part of this action. */
  copyInvite: boolean;
  /** The opened app cannot be prefilled; the player must paste the invite. */
  requiresPaste: boolean;
}

/**
 * The ordered channel list shown in the dropdown. The native OS share sheet is
 * prepended by the component when the browser supports it (it covers any
 * installed app, including ones without a web deep link). Channels whose apps
 * cannot be prefilled are marked requiresPaste so the UI sets expectations.
 */
export const SHARE_CHANNELS: ShareChannel[] = [
  { id: 'email',     label: 'Email',                       recipient: 'email', recipientPlaceholder: 'Recipient email (optional)',   recipientRequired: false, requiresPaste: false },
  { id: 'sms',       label: 'Text Message (SMS / iMessage / Google Messages)', recipient: 'phone', recipientPlaceholder: 'Recipient phone (optional)', recipientRequired: false, requiresPaste: false },
  { id: 'whatsapp',  label: 'WhatsApp',                    recipient: 'phone', recipientPlaceholder: 'Phone w/ country code (optional)', recipientRequired: false, requiresPaste: false },
  { id: 'telegram',  label: 'Telegram',                    recipient: 'none',  recipientPlaceholder: '',                              recipientRequired: false, requiresPaste: false },
  { id: 'teams',     label: 'Microsoft Teams',             recipient: 'email', recipientPlaceholder: 'Recipient email (required)',   recipientRequired: true,  requiresPaste: false },
  { id: 'messenger', label: 'Facebook Messenger',          recipient: 'none',  recipientPlaceholder: '',                              recipientRequired: false, requiresPaste: true  },
  { id: 'signal',    label: 'Signal',                      recipient: 'phone', recipientPlaceholder: 'Phone w/ country code (optional)', recipientRequired: false, requiresPaste: true  },
  { id: 'discord',   label: 'Discord',                     recipient: 'none',  recipientPlaceholder: '',                              recipientRequired: false, requiresPaste: true  },
  { id: 'slack',     label: 'Slack',                       recipient: 'none',  recipientPlaceholder: '',                              recipientRequired: false, requiresPaste: true  },
  { id: 'snapchat',  label: 'Snapchat',                    recipient: 'none',  recipientPlaceholder: '',                              recipientRequired: false, requiresPaste: true  },
  { id: 'wechat',    label: 'WeChat',                      recipient: 'none',  recipientPlaceholder: '',                              recipientRequired: false, requiresPaste: true  },
  { id: 'copy',      label: 'Copy Invite to Clipboard',    recipient: 'none',  recipientPlaceholder: '',                              recipientRequired: false, requiresPaste: false },
];

/** Look up a channel descriptor by id (falls back to the copy channel). */
export function getShareChannel(channelId: ShareChannelId): ShareChannel {
  return SHARE_CHANNELS.find((channel) => channel.id === channelId) ?? SHARE_CHANNELS[SHARE_CHANNELS.length - 1];
}

/**
 * The human-readable invite. Leads with the one-tap join link so the recipient
 * jumps straight into the room with the code pre-filled, and still spells out
 * the manual fallback (open the game, Enter Code, type it) for clients that
 * strip links. The code is normalized to the same upper-case form the join
 * input enforces so a manual copy/paste matches regardless of how it was stored.
 */
export function buildInviteText(roomCode: string, gameUrl: string): string {
  const normalizedCode = roomCode.trim().toUpperCase();
  const joinUrl = buildJoinUrl(normalizedCode, gameUrl);
  return (
    `Join my 1v1 Animal RTS battle! Tap to jump right in — the room code ` +
    `fills in automatically: ${joinUrl}  ` +
    `(No link? Open ${gameUrl}, pick Multiplayer, choose "Enter Code", and type ${normalizedCode}.)`
  );
}

/** Keep only the characters a phone deep link accepts (digits and a leading +). */
function sanitizePhone(recipient: string): string {
  const digits = recipient.replace(/\D/g, '');
  return recipient.trim().startsWith('+') ? `+${digits}` : digits;
}

/**
 * Resolve the concrete action for a channel + recipient. This is the single
 * source of truth for how each app receives the invite; the component merely
 * executes the returned ShareAction.
 */
export function resolveShareAction(
  channelId: ShareChannelId,
  args: { roomCode: string; gameUrl: string; recipient: string },
): ShareAction {
  const { roomCode, gameUrl, recipient } = args;
  const invite = buildInviteText(roomCode, gameUrl);
  const encodedInvite = encodeURIComponent(invite);
  const phone = sanitizePhone(recipient);
  const email = recipient.trim();

  switch (channelId) {
    case 'email':
      return {
        url: `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(INVITE_SUBJECT)}&body=${encodedInvite}`,
        copyInvite: false,
        requiresPaste: false,
      };

    case 'sms':
      return { url: `sms:${phone}?&body=${encodedInvite}`, copyInvite: false, requiresPaste: false };

    case 'whatsapp':
      // wa.me wants a bare international number (digits only) or none at all.
      return { url: `https://wa.me/${phone.replace('+', '')}?text=${encodedInvite}`, copyInvite: false, requiresPaste: false };

    case 'telegram':
      return {
        url: `https://t.me/share/url?url=${encodeURIComponent(buildJoinUrl(roomCode, gameUrl))}&text=${encodedInvite}`,
        copyInvite: false,
        requiresPaste: false,
      };

    case 'teams':
      return {
        url: `https://teams.microsoft.com/l/chat/0/0?users=${encodeURIComponent(email)}&message=${encodedInvite}`,
        copyInvite: false,
        requiresPaste: false,
      };

    case 'signal':
      // Signal exposes no prefill API; open the chat (if a number is given) and
      // copy the invite so the player can paste it.
      return {
        url: phone ? `https://signal.me/#p/${phone}` : 'https://signal.org/install/',
        copyInvite: true,
        requiresPaste: true,
      };

    case 'messenger':
      return { url: 'https://www.messenger.com/', copyInvite: true, requiresPaste: true };

    case 'discord':
      return { url: 'https://discord.com/channels/@me', copyInvite: true, requiresPaste: true };

    case 'slack':
      return { url: 'https://app.slack.com/client', copyInvite: true, requiresPaste: true };

    case 'snapchat':
      return { url: 'https://web.snapchat.com/', copyInvite: true, requiresPaste: true };

    case 'wechat':
      // WeChat has no outside web entry point; copying is the only honest path.
      return { url: '', copyInvite: true, requiresPaste: true };

    case 'copy':
    default:
      return { url: '', copyInvite: true, requiresPaste: false };
  }
}
