/**
 * Pure builders for the "invite a friend to my room" share actions.
 *
 * The multiplayer Room-Created screen lets the host send their room code to a
 * friend over the device's native share sheet, SMS, or email. The URL/string
 * construction is kept here — free of React and the DOM — so it can be unit
 * tested directly and reused by whichever delivery channel the player taps.
 */

/** Subject line used for the email invite and the native share-sheet title. */
export const INVITE_SUBJECT = 'Join my Animal RTS battle';

/**
 * The human-readable invite. Names the room code prominently and tells the
 * recipient exactly where to type it, since joining is code-entry (not a deep
 * link). The code is normalized to the same upper-case form the join input
 * enforces so a copy/paste matches regardless of how it was stored.
 */
export function buildInviteText(roomCode: string, gameUrl: string): string {
  const normalizedCode = roomCode.trim().toUpperCase();
  return (
    `Join my 1v1 Animal RTS battle! Open ${gameUrl} ` +
    `then pick Multiplayer, choose "Enter Code", and type ${normalizedCode}`
  );
}

/** A `mailto:` URL that pre-fills the subject and the invite body. */
export function buildMailtoUrl(roomCode: string, gameUrl: string): string {
  const subject = encodeURIComponent(INVITE_SUBJECT);
  const body = encodeURIComponent(buildInviteText(roomCode, gameUrl));
  return `mailto:?subject=${subject}&body=${body}`;
}

/**
 * An `sms:` URL that pre-fills the message body. The `?&body=` separator form
 * is the variant both iOS and Android message apps accept; recipient is left
 * blank so the sender picks the contact in their own messaging app.
 */
export function buildSmsUrl(roomCode: string, gameUrl: string): string {
  const body = encodeURIComponent(buildInviteText(roomCode, gameUrl));
  return `sms:?&body=${body}`;
}
