import { useEffect, useState, useCallback } from 'react';

/**
 * Round 48px button that toggles browser fullscreen on
 * `document.documentElement`. Designed to sit immediately to the right of the
 * 🔊 background-music toggle in both the title screen (MainMenu.tsx) and the
 * in-game HUD (HUD.tsx), so the two screens share one source of truth for the
 * visual + behavior.
 *
 * Why a component rather than two inline buttons:
 *   - Both call sites need the same fullscreenchange subscription so the icon
 *     stays in sync if the user exits via Esc (which fires no click handler).
 *   - Centralizing the request/exit call lets us route through the standard
 *     Fullscreen API once and keep the catch() side-effect uniform.
 */
export function FullscreenToggle() {
  // Track the live fullscreen state instead of toggling a local boolean,
  // because the user can leave fullscreen via Esc or the browser's own UI —
  // those paths bypass our click handler but still fire `fullscreenchange`.
  const [isFullscreen, setIsFullscreen] = useState<boolean>(
    () => Boolean(document.fullscreenElement),
  );

  useEffect(() => {
    const syncFromDocument = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener('fullscreenchange', syncFromDocument);
    return () => {
      document.removeEventListener('fullscreenchange', syncFromDocument);
    };
  }, []);

  const handleToggle = useCallback(() => {
    if (document.fullscreenElement) {
      // exitFullscreen rejects if there is no fullscreen element, but we
      // already gated on that — the catch is just defense against races where
      // the user pressed Esc between our read and this call.
      document.exitFullscreen().catch((err) => {
        console.log('Exit fullscreen failed:', err);
      });
    } else {
      document.documentElement.requestFullscreen().catch((err) => {
        // Browsers reject the request unless it originated from a user
        // gesture; the click handler satisfies that, but Safari/iOS can still
        // refuse. We swallow rather than throw so the UI stays usable.
        console.log('Fullscreen request failed:', err);
      });
    }
  }, []);

  return (
    <button
      type="button"
      role="switch"
      aria-checked={isFullscreen}
      aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
      title={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
      onClick={handleToggle}
      style={{
        width: '48px',
        height: '48px',
        borderRadius: '50%',
        background: isFullscreen
          ? 'linear-gradient(135deg, rgba(88,120,255,0.9) 0%, rgba(118,75,162,0.9) 100%)'
          : 'rgba(60,68,90,0.85)',
        border: '2px solid rgba(255,255,255,0.3)',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        transition: 'transform 0.3s ease, box-shadow 0.3s ease, background 0.3s ease',
        boxShadow: isFullscreen
          ? '0 4px 15px rgba(88,120,255,0.4)'
          : '0 4px 15px rgba(0,0,0,0.4)',
        backdropFilter: 'blur(10px)',
        fontSize: '22px',
        lineHeight: 1,
        padding: 0,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.transform = 'scale(1.1)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = 'scale(1)';
      }}
    >
      {/* ⛶ (U+26F6) reads as "expand" when windowed, and we swap to ❎/↙ when
          fullscreen is active. Using two distinct glyphs (not just a color
          change) keeps the affordance legible without relying on the
          background gradient alone. */}
      <span role="img" aria-hidden="true">{isFullscreen ? '🗗' : '⛶'}</span>
    </button>
  );
}
