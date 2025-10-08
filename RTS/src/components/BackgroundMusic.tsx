import { useEffect, useRef, useState } from 'react';
import { useGameStore } from '../game/state';

export function BackgroundMusic() {
  const menuMusicRef = useRef<HTMLAudioElement | null>(null);
  const gameMusicRef = useRef<HTMLAudioElement | null>(null);
  const currentScreen = useGameStore((s) => s.currentScreen);
  const [isPageVisible, setIsPageVisible] = useState(!document.hidden);
  const [hasUserInteracted, setHasUserInteracted] = useState(false);
  const menuMusicPlayCountRef = useRef<number>(0);

  // Handle user interaction for autoplay policy
  useEffect(() => {
    const handleInteraction = () => {
      setHasUserInteracted(true);
      console.log('User interaction detected - audio enabled');
    };

    // Listen for first click to enable audio
    document.addEventListener('click', handleInteraction, { once: true });
    document.addEventListener('keydown', handleInteraction, { once: true });

    return () => {
      document.removeEventListener('click', handleInteraction);
      document.removeEventListener('keydown', handleInteraction);
    };
  }, []);

  // Handle page visibility changes
  useEffect(() => {
    const handleVisibilityChange = () => {
      const visible = !document.hidden;
      setIsPageVisible(visible);
      console.log('Page visibility changed:', visible ? 'visible' : 'hidden');

      // Pause all music when page is hidden
      if (!visible) {
        if (menuMusicRef.current) menuMusicRef.current.pause();
        if (gameMusicRef.current) gameMusicRef.current.pause();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  // Create audio elements once on mount
  useEffect(() => {
    if (!menuMusicRef.current) {
      // URL encode the filename with spaces
      const menuMusicPath = "/audio/Music/" + encodeURIComponent("The Teddy Bears Picnic.mp3");
      const audio = new Audio(menuMusicPath);
      audio.loop = false; // Don't loop - we'll manually control playback
      audio.volume = 0.5;
      audio.playbackRate = 1.4;
      audio.preload = 'auto';
      menuMusicRef.current = audio;
      console.log('Menu music loaded from:', menuMusicPath);

      // Log when audio is ready
      audio.addEventListener('canplaythrough', () => {
        console.log('Menu music ready to play');
      });
      audio.addEventListener('error', (e) => {
        console.error('Menu music load error:', e);
      });

      // Handle end of song - replay up to 2 times total
      audio.addEventListener('ended', () => {
        menuMusicPlayCountRef.current += 1;
        console.log('Menu music ended, play count:', menuMusicPlayCountRef.current);

        if (menuMusicPlayCountRef.current < 2) {
          // Reset and play again
          audio.currentTime = 0;
          audio.play().catch((error) => {
            console.error('Menu music replay failed:', error);
          });
        } else {
          console.log('Menu music finished 2 plays, stopping');
        }
      });
    }

    if (!gameMusicRef.current) {
      // URL encode the filename with spaces
      const gameMusicPath = "/audio/Music/" + encodeURIComponent("Clash of Titans.mp3");
      const audio = new Audio(gameMusicPath);
      audio.loop = true;
      audio.volume = 0.5;
      audio.preload = 'auto';
      gameMusicRef.current = audio;
      console.log('Game music loaded from:', gameMusicPath);

      // Log when audio is ready
      audio.addEventListener('canplaythrough', () => {
        console.log('Game music ready to play');
      });
      audio.addEventListener('error', (e) => {
        console.error('Game music load error:', e);
      });
    }

    // Cleanup on unmount
    return () => {
      if (menuMusicRef.current) {
        menuMusicRef.current.pause();
        menuMusicRef.current.currentTime = 0;
      }
      if (gameMusicRef.current) {
        gameMusicRef.current.pause();
        gameMusicRef.current.currentTime = 0;
      }
    };
  }, []);

  // Handle music playback based on screen and page visibility
  useEffect(() => {
    const menuMusic = menuMusicRef.current;
    const gameMusic = gameMusicRef.current;

    if (!menuMusic || !gameMusic) {
      console.log('Audio elements not yet created');
      return;
    }

    // Only play music if page is visible and user has interacted
    if (!isPageVisible) {
      console.log('Page not visible - music paused');
      menuMusic.pause();
      gameMusic.pause();
      return;
    }

    if (!hasUserInteracted) {
      console.log('Waiting for user interaction to enable audio playback');
      return;
    }

    // Play appropriate music based on screen
    if (currentScreen === 'menu' || currentScreen === 'lobby') {
      console.log('Switching to menu music... (screen:', currentScreen, ')');
      // Stop game music
      gameMusic.pause();
      gameMusic.currentTime = 0;
      // Play menu music
      console.log('Menu music ready state:', menuMusic.readyState);
      menuMusic.play()
        .then(() => {
          console.log('Menu music playing successfully');
        })
        .catch((error) => {
          console.error('Menu music playback failed:', error);
        });
    } else if (currentScreen === 'playing') {
      console.log('Switching to game music... (screen:', currentScreen, ')');
      // Stop menu music
      menuMusic.pause();
      menuMusic.currentTime = 0;
      // Play game music
      console.log('Game music ready state:', gameMusic.readyState);
      gameMusic.play()
        .then(() => {
          console.log('Game music playing successfully');
        })
        .catch((error) => {
          console.error('Game music playback failed:', error);
        });
    } else {
      // Stop all music
      console.log('Stopping all music (screen:', currentScreen, ')');
      menuMusic.pause();
      gameMusic.pause();
    }
  }, [currentScreen, isPageVisible, hasUserInteracted]);

  return null; // This component doesn't render anything
}
