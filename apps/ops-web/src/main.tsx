import './styles/fonts.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/tailwind.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter } from 'react-router';

import { App } from './app/App';
import { createAppRoutes } from './app/routes';
import { startThemeChoice } from './platform/theme/theme-choice';

const container = document.getElementById('root');
if (container === null) throw new Error('The page has no #root element to render into.');

// The person's stored choice of theme is already on the root when the pre-paint script of index.html ran; this makes it so for a page where it did not.
startThemeChoice();

createRoot(container).render(
  <StrictMode>
    <App router={createBrowserRouter(createAppRoutes())} />
  </StrictMode>,
);
