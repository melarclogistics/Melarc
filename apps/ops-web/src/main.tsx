import './styles/app.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter } from 'react-router';

import { App } from './app/App';
import { createAppRoutes } from './app/routes';

const container = document.getElementById('root');
if (container === null) throw new Error('The page has no #root element to render into.');

createRoot(container).render(
  <StrictMode>
    <App router={createBrowserRouter(createAppRoutes())} />
  </StrictMode>,
);
