import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import { CardLanding } from './components/CardLogin';
import { BankReturn } from './components/bank/BankReturn';
import { completeBankReturn, readBankReturn } from './components/bank/return-flow';
import { parseLoginCardUrl } from '../shared/card-login';
import { BANK_CALLBACK_PATH } from '../shared/bank';
import { startTheme } from './theme';

const cardEntry = window.location.pathname === '/card';
const cardToken = cardEntry ? parseLoginCardUrl(window.location.href, window.location.origin) : null;
// Remove the credential from the history entry before the first API call or render.
if (cardEntry) window.history.replaceState(null, '', '/card');
// The return from the bank: the one-time code leaves the address bar and the history first, and is posted before
// anything else loads (it is good for 60 seconds and works once).
const bankEntry = window.location.pathname === BANK_CALLBACK_PATH;
const bankReturn = bankEntry ? readBankReturn(window.location.search) : null;
if (bankEntry) window.history.replaceState(null, '', BANK_CALLBACK_PATH);
const bankCompletion = bankEntry ? completeBankReturn(bankReturn) : null;
startTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {cardEntry ? <CardLanding token={cardToken} /> : bankCompletion ? <BankReturn completion={bankCompletion} /> : <App />}
  </StrictMode>,
);
