import { test, expect } from '@playwright/test';
import {
  INVITE_SUBJECT,
  buildInviteText,
  buildMailtoUrl,
  buildSmsUrl,
} from '../src/components/Working/roomInvite';

/**
 * Unit tests for the room-invite message builders that back the "share my room
 * code" controls. These are pure string/URL builders (no DOM), so they run in
 * plain Node. Assertions decode the URLs and check the real inputs flow through
 * — the room code and game URL — rather than matching hand-copied literals.
 */

const GAME_URL = 'https://example.com/RTS/';

/** Pull the value of one query parameter out of a mailto:/sms: URL. */
function decodeParam(url: string, param: string): string {
  const match = new RegExp(`[?&]${param}=([^&]*)`).exec(url);
  return match ? decodeURIComponent(match[1]) : '';
}

test.describe('buildInviteText', () => {
  test('includes the game URL and the room code', () => {
    const text = buildInviteText('AB12CD', GAME_URL);
    expect(text).toContain(GAME_URL);
    expect(text).toContain('AB12CD');
  });

  test('normalizes the room code to trimmed upper case', () => {
    expect(buildInviteText('  ab12cd  ', GAME_URL)).toContain('AB12CD');
  });

  test('reflects the room code it is given, not a hard-coded one', () => {
    expect(buildInviteText('ZZ99', GAME_URL)).toContain('ZZ99');
    expect(buildInviteText('ZZ99', GAME_URL)).not.toContain('AB12CD');
  });
});

test.describe('buildMailtoUrl', () => {
  test('is a mailto link carrying the subject and the invite body', () => {
    const url = buildMailtoUrl('AB12CD', GAME_URL);
    expect(url.startsWith('mailto:?')).toBe(true);
    expect(decodeParam(url, 'subject')).toBe(INVITE_SUBJECT);
    expect(decodeParam(url, 'body')).toBe(buildInviteText('AB12CD', GAME_URL));
  });

  test('percent-encodes the body so the URL stays well-formed', () => {
    // A raw space would break the mailto query; it must arrive encoded.
    expect(buildMailtoUrl('AB12CD', GAME_URL)).not.toMatch(/body=[^&]* [^&]*/);
  });
});

test.describe('buildSmsUrl', () => {
  test('is an sms link carrying the invite body', () => {
    const url = buildSmsUrl('AB12CD', GAME_URL);
    expect(url.startsWith('sms:')).toBe(true);
    expect(decodeParam(url, 'body')).toBe(buildInviteText('AB12CD', GAME_URL));
  });
});
