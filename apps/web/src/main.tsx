import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import { BASE } from './lib/base';

if ('serviceWorker' in navigator && location.hostname !== '127.0.0.1') {
  window.addEventListener('load', () => navigator.serviceWorker.register(`${BASE}/sw.js`, { scope: `${BASE}/` }).catch(() => undefined));
}

createRoot(document.getElementById('root')!).render(<App />);
