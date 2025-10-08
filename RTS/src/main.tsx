import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

const root = createRoot(document.getElementById('root')!);
root.render(
  // <React.StrictMode> // Temporarily disabled for camera debugging
    <App />
  // </React.StrictMode>
);



