import { test, expect } from '@playwright/test';
import {
  INVITE_SUBJECT,
  SHARE_CHANNELS,
  buildInviteText,
  getShareChannel,
  resolveShareAction,
} from '../src/components/Working/roomInvite';

/**
 * Unit tests for the room-invite channel registry and message builders that
 * back the "share my room code" dropdown. These are pure (no DOM), so they run
 * in plain Node. Assertions decode the produced URLs and check the real inputs
 * flow through — the room code, game URL, and recipient — rather than matching
 * hand-copied literals.
 */

const GAME_URL = 'https://example.com/RTS/';
const CODE = 'AB12CD';

/** Pull one query parameter's decoded value out of a deep-link URL. */
function decodeParam(url: string, param: string): string {
  const match = new RegExp(`[?&]${param}=([^&]*)`).exec(url);
  return match ? decodeURIComponent(match[1]) : '';
}

const action = (channelId: Parameters<typeof resolveShareAction>[0], recipient = '') =>
  resolveShareAction(channelId, { roomCode: CODE, gameUrl: GAME_URL, recipient });

test.describe('buildInviteText', () => {
  test('includes the game URL and the room code', () => {
    const text = buildInviteText(CODE, GAME_URL);
    expect(text).toContain(GAME_URL);
    expect(text).toContain(CODE);
  });

  test('normalizes the room code to trimmed upper case', () => {
    expect(buildInviteText('  ab12cd  ', GAME_URL)).toContain(CODE);
  });

  test('reflects the room code it is given, not a hard-coded one', () => {
    expect(buildInviteText('ZZ99', GAME_URL)).toContain('ZZ99');
    expect(buildInviteText('ZZ99', GAME_URL)).not.toContain(CODE);
  });
});

test.describe('SHARE_CHANNELS registry', () => {
  test('every channel resolves to an action and is looked up by id', () => {
    for (const channel of SHARE_CHANNELS) {
      expect(getShareChannel(channel.id).id).toBe(channel.id);
      const resolved = action(channel.id);
      // Every channel either opens a destination or copies the invite (or both).
      expect(resolved.url.length > 0 || resolved.copyInvite).toBe(true);
    }
  });

  test('channels needing a recipient are flagged with the input kind', () => {
    expect(getShareChannel('teams').recipient).toBe('email');
    expect(getShareChannel('teams').recipientRequired).toBe(true);
    expect(getShareChannel('sms').recipient).toBe('phone');
    expect(getShareChannel('telegram').recipient).toBe('none');
  });
});

test.describe('prefilled deep-link channels carry the invite', () => {
  test('email is a mailto with subject, recipient, and body', () => {
    const url = action('email', 'friend@example.com').url;
    expect(url.startsWith('mailto:')).toBe(true);
    expect(url).toContain(encodeURIComponent('friend@example.com'));
    expect(decodeParam(url, 'subject')).toBe(INVITE_SUBJECT);
    expect(decodeParam(url, 'body')).toBe(buildInviteText(CODE, GAME_URL));
  });

  test('sms targets the given number and prefills the body', () => {
    const url = action('sms', '+1 (555) 123-4567').url;
    expect(url.startsWith('sms:+15551234567')).toBe(true);
    expect(decodeParam(url, 'body')).toBe(buildInviteText(CODE, GAME_URL));
  });

  test('whatsapp uses a digits-only number and prefills the text', () => {
    const url = action('whatsapp', '+44 7700 900123').url;
    expect(url.startsWith('https://wa.me/447700900123?')).toBe(true);
    expect(decodeParam(url, 'text')).toBe(buildInviteText(CODE, GAME_URL));
  });

  test('telegram shares the game url and the invite text', () => {
    const url = action('telegram').url;
    expect(url.startsWith('https://t.me/share/url?')).toBe(true);
    expect(decodeParam(url, 'url')).toBe(GAME_URL);
    expect(decodeParam(url, 'text')).toBe(buildInviteText(CODE, GAME_URL));
  });

  test('teams deep-links a chat to the recipient with the message prefilled', () => {
    const url = action('teams', 'coworker@example.com').url;
    expect(url.startsWith('https://teams.microsoft.com/l/chat/')).toBe(true);
    expect(decodeParam(url, 'users')).toBe('coworker@example.com');
    expect(decodeParam(url, 'message')).toBe(buildInviteText(CODE, GAME_URL));
  });

  test('prefilled channels do not require a manual paste', () => {
    for (const id of ['email', 'sms', 'whatsapp', 'telegram', 'teams'] as const) {
      expect(action(id).requiresPaste).toBe(false);
    }
  });
});

test.describe('copy-and-paste channels (no prefill API)', () => {
  test('signal opens the contact chat when a number is given and copies the invite', () => {
    const resolved = action('signal', '+15551234567');
    expect(resolved.url).toBe('https://signal.me/#p/+15551234567');
    expect(resolved.copyInvite).toBe(true);
    expect(resolved.requiresPaste).toBe(true);
  });

  test('discord/slack/messenger/snapchat open the app and copy the invite to paste', () => {
    for (const id of ['discord', 'slack', 'messenger', 'snapchat'] as const) {
      const resolved = action(id);
      expect(resolved.url.startsWith('https://')).toBe(true);
      expect(resolved.copyInvite).toBe(true);
      expect(resolved.requiresPaste).toBe(true);
    }
  });

  test('wechat has no web entry point, so it copies only', () => {
    const resolved = action('wechat');
    expect(resolved.url).toBe('');
    expect(resolved.copyInvite).toBe(true);
  });
});

test.describe('copy channel', () => {
  test('copies the invite without opening or requiring a paste', () => {
    const resolved = action('copy');
    expect(resolved.url).toBe('');
    expect(resolved.copyInvite).toBe(true);
    expect(resolved.requiresPaste).toBe(false);
  });
});
