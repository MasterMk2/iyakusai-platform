import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import { CardLanding } from './components/CardLogin';
import { parseLoginCardUrl } from '../shared/card-login';
import { startTheme } from './theme';

const cardEntry = window.location.pathname === '/card';
const cardToken = cardEntry ? parseLoginCardUrl(window.location.href, window.location.origin) : null;
// Remove the credential from the history entry before the first API call or render.
if (cardEntry) window.history.replaceState(null, '', '/card');
startTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {cardEntry ? <CardLanding token={cardToken} /> : <App />}
  </StrictMode>,
);
