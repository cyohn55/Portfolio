import { useState } from 'react';
import { INVITE_SUBJECT, buildInviteText, buildMailtoUrl, buildSmsUrl } from './roomInvite';

/**
 * Share controls shown beneath a freshly created room code so the host can
 * invite a friend without dictating the code out loud. Offers the device's
 * native share sheet (mobile), plus explicit Text (SMS) and Email channels and
 * a clipboard copy. All message construction lives in the pure `roomInvite`
 * helpers; this component only handles the browser side effects and feedback.
 */
export function ShareRoomCode(props: { roomCode: string }) {
  const { roomCode } = props;
  const [copied, setCopied] = useState(false);

  // base path is relative ('./'), so origin + pathname is the live game entry.
  const gameUrl = typeof window !== 'undefined'
    ? window.location.origin + window.location.pathname
    : '';

  // navigator.share is the native OS share sheet (SMS, email, messengers, …);
  // it only exists on supporting browsers (chiefly mobile), so feature-detect.
  const canNativeShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  const shareNatively = async () => {
    try {
      await navigator.share({
        title: INVITE_SUBJECT,
        text: buildInviteText(roomCode, gameUrl),
        url: gameUrl,
      });
    } catch {
      // The user dismissing the share sheet rejects the promise — not an error.
    }
  };

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(roomCode);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be blocked (insecure context / permissions); stay silent
      // since Text and Email remain available as share channels.
    }
  };

  return (
    <div className="mp-share">
      {canNativeShare && (
        <button className="mp-share-button primary" onClick={shareNatively}>
          Share Invite
        </button>
      )}

      <div className="mp-share-row">
        <a className="mp-share-button" href={buildSmsUrl(roomCode, gameUrl)}>
          Text
        </a>
        <a className="mp-share-button" href={buildMailtoUrl(roomCode, gameUrl)}>
          Email
        </a>
        <button className="mp-share-button" onClick={copyCode}>
          {copied ? 'Copied ✓' : 'Copy Code'}
        </button>
      </div>
    </div>
  );
}
