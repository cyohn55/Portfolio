import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { UINavigationController } from './components/Working/UINavigationController';

const root = createRoot(document.getElementById('root')!);
root.render(
  // <React.StrictMode> // Temporarily disabled for camera debugging
    <>
      {/* Always-mounted controller→menu focus driver; sits outside App's
          per-screen early returns so it stays alive across screen changes. */}
      <UINavigationController />
      <App />
    </>
  // </React.StrictMode>
);



