import { useMemo, useState } from 'react';
import {
  INVITE_SUBJECT,
  SHARE_CHANNELS,
  buildInviteText,
  getShareChannel,
  resolveShareAction,
  type ShareChannelId,
} from './roomInvite';

/**
 * Share controls shown beneath a freshly created room code. The host picks a
 * channel from a dropdown, optionally fills in a recipient (email/phone) when
 * that channel can pre-target one, and presses Send Code. Channels that expose
 * a prefilled deep link open straight into a ready-to-send message; channels
 * without one copy the invite and open the app so the player can paste it.
 *
 * All message construction lives in the pure `roomInvite` helpers; this
 * component only executes the resulting action (open a link / copy) and reports
 * what happened. Opening uses a new tab or an OS scheme hand-off so the host
 * never navigates away from the room and drops the live connection.
 */

const NATIVE_CHANNEL_ID = 'native' as const;
type DropdownChannelId = ShareChannelId | typeof NATIVE_CHANNEL_ID;

export function ShareRoomCode(props: { roomCode: string }) {
  const { roomCode } = props;

  // base path is relative ('./'), so origin + pathname is the live game entry.
  const gameUrl = typeof window !== 'undefined'
    ? window.location.origin + window.location.pathname
    : '';

  // navigator.share is the native OS share sheet — the one path that reaches
  // ANY installed app (Signal, Snapchat, Discord, …). Offer it first when the
  // browser supports it (chiefly mobile).
  const canNativeShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  const [channelId, setChannelId] = useState<DropdownChannelId>(canNativeShare ? NATIVE_CHANNEL_ID : 'email');
  const [recipient, setRecipient] = useState('');
  const [status, setStatus] = useState('');

  const selectedChannel = channelId === NATIVE_CHANNEL_ID ? null : getShareChannel(channelId);

  // Whether Send Code is allowed yet (required recipient must be present).
  const canSend = useMemo(() => {
    if (!selectedChannel) return true; // native share has no recipient field
    if (selectedChannel.recipientRequired) return recipient.trim().length > 0;
    return true;
  }, [selectedChannel, recipient]);

  const copyInvite = async (): Promise<boolean> => {
    try {
      await navigator.clipboard.writeText(buildInviteText(roomCode, gameUrl));
      return true;
    } catch {
      return false; // clipboard can be blocked (insecure context / permissions)
    }
  };

  // Open a destination without unloading the host's page: web URLs in a new
  // tab, OS scheme links (mailto:/sms:/signal:) via a transient anchor click
  // the OS intercepts. window.location would kill the live room connection.
  const openDestination = (url: string) => {
    if (!url) return;
    const isWebUrl = url.startsWith('http://') || url.startsWith('https://');
    if (isWebUrl) {
      window.open(url, '_blank', 'noopener');
      return;
    }
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.target = '_blank';
    anchor.rel = 'noopener';
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  };

  const shareNatively = async () => {
    try {
      await navigator.share({
        title: INVITE_SUBJECT,
        text: buildInviteText(roomCode, gameUrl),
        url: gameUrl,
      });
      setStatus('Invite shared.');
    } catch {
      // The user dismissing the share sheet rejects the promise — not an error.
    }
  };

  const sendCode = async () => {
    if (channelId === NATIVE_CHANNEL_ID) {
      await shareNatively();
      return;
    }
    if (!selectedChannel) return;

    const action = resolveShareAction(channelId, { roomCode, gameUrl, recipient });
    const copied = action.copyInvite ? await copyInvite() : false;
    openDestination(action.url);

    if (channelId === 'copy') {
      setStatus(copied ? 'Invite copied to clipboard.' : 'Could not access the clipboard — select the code above to copy it.');
    } else if (action.requiresPaste) {
      const copyNote = copied ? 'Invite copied — ' : '';
      setStatus(`${copyNote}paste it into ${selectedChannel.label} once it opens.`);
    } else {
      setStatus(`Opening ${selectedChannel.label}…`);
    }
  };

  return (
    <div className="mp-share">
      <label className="mp-share-label" htmlFor="mp-share-channel">Send invite via</label>
      <select
        id="mp-share-channel"
        className="mp-share-select"
        value={channelId}
        onChange={(event) => {
          setChannelId(event.target.value as DropdownChannelId);
          setRecipient('');
          setStatus('');
        }}
      >
        {canNativeShare && <option value={NATIVE_CHANNEL_ID}>Share via device…</option>}
        {SHARE_CHANNELS.map((channel) => (
          <option key={channel.id} value={channel.id}>{channel.label}</option>
        ))}
      </select>

      {selectedChannel && selectedChannel.recipient !== 'none' && (
        <input
          className="mp-share-input"
          type={selectedChannel.recipient === 'email' ? 'email' : 'tel'}
          inputMode={selectedChannel.recipient === 'email' ? 'email' : 'tel'}
          autoComplete="off"
          placeholder={selectedChannel.recipientPlaceholder}
          value={recipient}
          onChange={(event) => setRecipient(event.target.value)}
        />
      )}

      <button className="mp-share-button primary" disabled={!canSend} onClick={sendCode}>
        {channelId === NATIVE_CHANNEL_ID ? 'Share Code' : 'Send Code'}
      </button>

      {status && <p className="mp-share-status">{status}</p>}
    </div>
  );
}
