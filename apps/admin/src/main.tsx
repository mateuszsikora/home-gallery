import { createRoot } from 'react-dom/client';

import { AdminApp } from './admin-app.js';
import './styles.css';

const apiBaseUrl =
  import.meta.env.VITE_HOME_GALLERY_API_URL?.trim() || window.location.origin;
const root = document.querySelector<HTMLElement>('#root');

if (root === null) {
  throw new Error('Administration root element is missing');
}

createRoot(root).render(<AdminApp apiBaseUrl={apiBaseUrl} />);
